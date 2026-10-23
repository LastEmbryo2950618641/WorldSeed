import {
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ProjectId,
  type ProjectSettings,
  type ChapterNarrativeIntent,
  type DiscussFocusKind,
  type SynopsisConversationListResult,
  type SynopsisConversationMessage,
  type SynopsisConversationSendResult,
  type SynopsisConversationStartResult,
  type SynopsisConversationStreamEdit,
  type SynopsisConversationStreamSnapshot,
  type SynopsisConversationStreamUsage,
  type SynopsisConversationBudgetAdvisory,
  type SynopsisConversationChoice,
  type SynopsisResolveTurnInputResult,
  type TurnHandoffBrief,
  type TurnMonitorPhaseSnapshot,
  type WorkspaceCatalogSnapshot,
  type DeductionGoal,
  type HookScheduleAudit,
  selectGoalsForChapterContext,
} from "@worldseed/contracts"
import {
  consumeDiscussToolExclusiveStrip,
  synopsisDiscussArtifactSchema,
} from "@worldseed/prompt-contracts"
import { defaultProjectSettings } from "@worldseed/config"

import {
  buildContextUsageBreakdown,
  executeWithContextCompaction,
  filterNovelContextExchangeMessages,
  findExactDuplicateStaticMessageIds,
} from "../context/index.js"
import {
  assembleSynopsisPlaceholderDocument,
  assertUniqueVolumeSequence,
  DEFAULT_VOLUME_FOLDER_NAME,
  deriveChapterPublishPath,
  deriveOutlineMarkdownPath,
  deriveSynopsisMarkdownPath,
  deriveVolumeDirectoryPath,
  extractSynopsisTitleFromDocument,
  extractVolumeFolderNameFromPath,
  formatChapterSequenceLabel,
  digest,
  assembleChapterDocument,
  readChapterBody,
  pickPreferredVolumeFolderName,
  parseChapterSequenceFromLabel,
  parseOutlineMarkdownPath,
  parseSynopsisMarkdownPath,
  parseSynopsisTitleFromLabel,
  remapPathVolumeFolder,
  siblingPlanningMarkdownPath,
  isChapterBodyMarkdownPath,
  isOutlineMarkdownPath,
  isSynopsisMarkdownPath,
  validateSynopsisMarkdownPath,
  validateVolumeFolderName,
  assertWorkspaceMutationAllowed,
  assertWorkDescriptionWriteBatch,
  resolveDescriptionRulePaths,
  listWorkDescriptionRuleFiles,
  WORK_STYLE_RULE_PATH,
} from "../../core/index.js"
import { applyColdStartStyleGate } from "./cold-start-style-gate.js"
import type { GoalProposalPayload } from "@worldseed/contracts"
import type { AIModelPort, PromptResourcePort, TurnReadEvidence, TurnRetrievalGap } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort, InternalStorePort } from "../workspace/index.js"
import type { WorkspaceCatalogPort } from "../retrieval/ports/workspace-catalog.js"
import type { WebResearchPort } from "../retrieval/ports/web-research-port.js"
import type { ChapterResolveService } from "./chapter-resolve-service.js"
import {
  RevisionInvalidStateError,
  type ChapterRevisionService,
} from "./chapter-revision-service.js"
import type { ChapterSynopsisService } from "./chapter-synopsis-service.js"
import type { DeductionGoalsService } from "./deduction-goals-service.js"
import type { StagingPromoteService } from "./staging-promote-service.js"
import type { SettingsLineageService } from "../settings/settings-lineage-service.js"
import type { SqliteChapterIndexRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import type { SqliteDocumentRepository } from "../../infrastructure/sqlite/repositories/sqlite-document-repository.js"
import { ChapterTemporalSourceResolver } from "./chapter-temporal-source-resolver.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"
import { synopsisConversationStreamHub } from "./synopsis-conversation-stream-hub.js"
import {
  AGENT_MEMORY_INDEX_PATH,
  truncateAgentMemoryIndex,
} from "./agent-memory.js"
import {
  collectDiscussReadEvidenceFromContext,
  computeDiscussBootstrapDigest,
  toVisibleDiscussContextMessages,
} from "./discuss-session-context.js"
import {
  clearSynopsisSendCancellation,
  isSynopsisSendCancelled,
  markSynopsisSendCancelled,
  SynopsisSendCancelledError,
} from "./synopsis-send-cancellation.js"
import {
  acknowledgeSynopsisModelBudget,
  peekSynopsisModelBudgetAdvisory,
  recordSynopsisModelCall,
} from "./synopsis-model-budget-tracker.js"
import {
  buildInterruptedAssistantMessageFields,
  streamHasVisibleProgress,
} from "./synopsis-interrupted-turn.js"
import {
  alignTodosForChapterSequenceGate,
  alignTodosForToolExclusiveGate,
  discussChapterSequenceGateHint,
  DISCUSS_TODO_INCOMPLETE_HINT,
  DISCUSS_TODO_REQUIRED_HINT,
  DISCUSS_TOOL_EXCLUSIVE_GATE_HINT,
  discussArtifactRequiresTodos,
  discussTodosAreSettled,
  discussTurnHasTodos,
  isDiscussTodoBootstrapTool,
  isPrecedingChapterPublishGateError,
  partitionChapterDraftSequences,
  settleToolGateTodos,
} from "./synopsis-todo-gate.js"
import { normalizeThinkingDisplayText } from "./synopsis-thinking-text.js"
import { applySearchReplace } from "./markdown-search-replace.js"
import {
  executeSynopsisTool,
  synopsisToolCatalog,
  type SynopsisWorkflowToolCallbacks,
  type SynopsisWorkflowToolResult,
} from "./synopsis-workflow-tools.js"
import {
  executeSynopsisWebReads,
} from "./synopsis-web-reads.js"
import {
  executeSynopsisWorkspaceReads,
  formatSynopsisSearchLabel,
  isPresentationRuleMarkdownPath,
  listUserRuleMarkdownPaths,
} from "./synopsis-workspace-reads.js"
import {
  executeSynopsisTemporalReads,
  formatTemporalSearchLabel,
  isTemporalReadRequest,
  MAX_TEMPORAL_READS_PER_ROUND,
  temporalSearchMeta,
} from "./synopsis-temporal-reads.js"
import {
  ARC_PLAN_STAGING_PATH,
  STAGING_FILE_KEYS,
  volumeOutlinePlanPath,
  evictStagingEntries,
  mergeStagingPatches,
  parseStagingEntries,
  serializeStagingEntries,
  stagingFileTitle,
  type StagingEntry,
  type StagingEntryPatch,
} from "./staging-entries.js"
import { chapterNarrativeIntentPhaseAppendix, chapterPresentationPhaseAppendix } from "../settings/chapter-narrative-intent-policy.js"
import {
  formatTurnHandoffSystemMessage,
} from "./turn-handoff.js"

export class SynopsisInvalidStateError extends Error {}

type ChapterDraftProposal = Readonly<{
  base: "body" | "draft"
  baseDraftVersionId?: string
  heading: string
  body: string
}>

type ChapterDraftProposalEntry = ChapterDraftProposal & Readonly<{
  chapterSequence: number
}>

type VolumeChapterPlan = Readonly<{
  chapterSequence: number
  chapterTitle?: string
  synopsisBody: string
  outlineBody: string
}>

export type SynopsisConversationServiceDependencies = SynopsisWorkflowToolCallbacks & Readonly<{
  chapters: ChapterResolveService
  revisions?: ChapterRevisionService
  chapterSynopsis: ChapterSynopsisService
  conversation: SqliteSynopsisConversationRepository
  goals: DeductionGoalsService
  stagingPromote: StagingPromoteService
  settingsLineage: SettingsLineageService
  chapterIndex: SqliteChapterIndexRepository
  documents: SqliteDocumentRepository
  internalStore: InternalStorePort
  chapterTemporal: ChapterTemporalSourceResolver
  workspace: WorkspacePort
  catalog: WorkspaceCatalogPort
  prompts: PromptResourcePort
  webResearch?: WebResearchPort
  readProjectSettings?: () => Promise<ProjectSettings>
  readDisplayName?: () => Promise<string>
  renameDisplayName?: (displayName: string) => Promise<string>
  readTurnMonitor?: () => Promise<Readonly<{
    taskId: string
    status: string
    phases: readonly TurnMonitorPhaseSnapshot[]
  }> | undefined>
  /** Wait for in-flight graph revision publication; true when nothing is pending. */
  waitForPendingPublications?: (input: Readonly<{ timeoutMs: number; signal?: AbortSignal }>) => Promise<boolean>
  createId: () => string
  now: () => number
}>

export class SynopsisConversationService {

  public constructor(private readonly dependencies: SynopsisConversationServiceDependencies) {}

  public async list(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
  }>): Promise<SynopsisConversationListResult> {
    const usage = await this.hydrateDiscussUsage(input.projectId)
    const session = await this.dependencies.conversation.findActiveSession(input.projectId)
    const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    if (session === undefined) {
      return {
        messages: [...messages],
        ...(usage === undefined ? {} : { usage }),
      }
    }
    const reconciled = await this.reconcileSessionSynopsisPath(input.workspaceRootRef, session)
    return {
      session: reconciled,
      messages: [...messages],
      ...(usage === undefined ? {} : { usage }),
    }
  }

  public async listInheritedReadEvidence(projectId: ProjectId): Promise<readonly TurnReadEvidence[]> {
    const session = await this.dependencies.conversation.findActiveSession(projectId)
    if (session === undefined) return []
    const messages = await this.dependencies.conversation.listDiscussContextMessages(session.sessionId)
    return collectDiscussReadEvidenceFromContext(messages)
  }

  public async start(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    title?: string
  }>): Promise<SynopsisConversationStartResult> {
    const usage = await this.hydrateDiscussUsage(input.projectId)
    const existing = await this.dependencies.conversation.findActiveSession(input.projectId)
    if (existing !== undefined) {
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      const reconciled = await this.reconcileSessionSynopsisPath(input.workspaceRootRef, existing)
      return {
        session: reconciled,
        messages: [...messages],
        ...(usage === undefined ? {} : { usage }),
      }
    }
    const fromIndex = await this.dependencies.chapters.nextChapterSequence(input.projectId)
    const chapterSequence = fromIndex
    const claimed = await this.findExistingSynopsisForSequence(input.workspaceRootRef, chapterSequence)
    const title = input.title?.trim()
      || claimed?.title
      || ""
    const existingVolumes = await this.dependencies.workspace.listVolumeFolderNames(input.workspaceRootRef)
    const preferredVolume = pickPreferredVolumeFolderName(existingVolumes) ?? DEFAULT_VOLUME_FOLDER_NAME
    const synopsisPath = claimed?.path
      ?? deriveSynopsisMarkdownPath(chapterSequence, title, preferredVolume)
    if (claimed === undefined) {
      const placeholder = assembleSynopsisPlaceholderDocument(chapterSequence, title)
      await this.dependencies.workspace.saveSynopsisMarkdown(input.workspaceRootRef, synopsisPath, placeholder)
    }
    const nowMs = this.dependencies.now()
    const sessionId = this.dependencies.createId()
    const session = await this.dependencies.conversation.createSession({
      sessionId,
      projectId: input.projectId,
      chapterSequence,
      synopsisPath,
      title: title.length === 0 ? formatChapterSequenceLabel(chapterSequence) : title,
      createdAtMs: nowMs,
    })
    runtimeLog("debug", "synopsis-conversation", "started", {
      projectId: input.projectId,
      sessionId,
      chapterSequence,
      synopsisPath,
      claimed: claimed !== undefined,
    })
    const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    return {
      session,
      messages: [...messages],
      ...(usage === undefined ? {} : { usage }),
    }
  }

  public async setFocus(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterSequence?: number
    relativePath?: string
    focusKind?: DiscussFocusKind
  }>): Promise<SynopsisConversationStartResult> {
    const chapterSequence = this.resolveFocusChapterSequence(input)
    if (chapterSequence > await this.dependencies.chapters.nextChapterSequence(input.projectId)) {
      throw new SynopsisInvalidStateError("当前章尚未经过图修订发布为正文，不能进入下一章")
    }
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
    const focusKind = input.focusKind
      ?? this.resolveFocusKindFromPath(input.relativePath)
      ?? session.focusKind
      ?? "plot_synopsis"
    if (session.chapterSequence === chapterSequence && session.focusKind === focusKind) {
      const usage = await this.hydrateDiscussUsage(input.projectId)
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      const reconciled = await this.reconcileSessionSynopsisPath(input.workspaceRootRef, session)
      return {
        session: reconciled,
        messages: [...messages],
        ...(usage === undefined ? {} : { usage }),
      }
    }
    if (session.chapterSequence === chapterSequence) {
      await this.dependencies.conversation.updateSession({
        sessionId: session.sessionId,
        focusKind,
        updatedAtMs: this.dependencies.now(),
      })
      const usage = await this.hydrateDiscussUsage(input.projectId)
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      const focused = await this.dependencies.conversation.findSession(session.sessionId)
      const reconciled = await this.reconcileSessionSynopsisPath(
        input.workspaceRootRef,
        focused ?? { ...session, focusKind },
      )
      return {
        session: reconciled,
        messages: [...messages],
        ...(usage === undefined ? {} : { usage }),
      }
    }
    const claimed = await this.findExistingSynopsisForSequence(input.workspaceRootRef, chapterSequence)
    const existingVolumes = await this.dependencies.workspace.listVolumeFolderNames(input.workspaceRootRef)
    const preferredVolume = extractVolumeFolderNameFromPath(claimed?.path ?? session.synopsisPath)
      ?? pickPreferredVolumeFolderName(existingVolumes)
      ?? DEFAULT_VOLUME_FOLDER_NAME
    const title = claimed?.title?.trim()
      || ""
    const synopsisPath = claimed?.path
      ?? deriveSynopsisMarkdownPath(
        chapterSequence,
        title,
        preferredVolume,
      )
    if (claimed === undefined) {
      const placeholder = assembleSynopsisPlaceholderDocument(chapterSequence, title)
      await this.dependencies.workspace.saveSynopsisMarkdown(input.workspaceRootRef, synopsisPath, placeholder)
    }
    const nowMs = this.dependencies.now()
    await this.dependencies.conversation.updateSession({
      sessionId: session.sessionId,
      chapterSequence,
      synopsisPath,
      title: title.length === 0 ? formatChapterSequenceLabel(chapterSequence) : title,
      focusKind,
      lastAgentDigest: null,
      lastOutlineAgentDigest: null,
      synopsisConfirmedAtMs: null,
      updatedAtMs: nowMs,
    })
    await this.dependencies.conversation.saveDiscussContextDigests({
      sessionId: session.sessionId,
      synopsisDigest: null,
      outlineDigest: null,
      bootstrapDigest: null,
      updatedAtMs: nowMs,
    })
    runtimeLog("debug", "synopsis-conversation", "set_focus", {
      projectId: input.projectId,
      sessionId: session.sessionId,
      fromSequence: session.chapterSequence,
      chapterSequence,
      focusKind,
      synopsisPath,
    })
    const usage = await this.hydrateDiscussUsage(input.projectId)
    const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    const focused = await this.dependencies.conversation.findSession(session.sessionId)
    const reconciled = await this.reconcileSessionSynopsisPath(
      input.workspaceRootRef,
      focused ?? { ...session, chapterSequence, synopsisPath, focusKind },
    )
    return {
      session: reconciled,
      messages: [...messages],
      ...(usage === undefined ? {} : { usage }),
    }
  }

  public peekStream(projectId: ProjectId, sessionId?: string): SynopsisConversationStreamSnapshot {
    const snapshot = synopsisConversationStreamHub.peek(projectId, sessionId)
    const budgetAdvisory = peekSynopsisModelBudgetAdvisory(projectId)
    return budgetAdvisory === undefined
      ? snapshot
      : { ...snapshot, budgetAdvisory }
  }

  public async contextUsage(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId?: string
    contextWindowTokens?: number
  }>): Promise<Readonly<{
    sessionId?: string
    usedTokens: number
    maxTokens: number
    percent: number
    categories: ReturnType<typeof buildContextUsageBreakdown>["categories"]
    empty: boolean
  }>> {
    void input.workspaceRootRef
    const session = input.sessionId === undefined
      ? await this.dependencies.conversation.findActiveSession(input.projectId)
      : await this.dependencies.conversation.findSession(input.sessionId)
    const maxTokens = input.contextWindowTokens ?? 1_000_000
    if (session === undefined || session.projectId !== input.projectId) {
      return {
        usedTokens: 0,
        maxTokens,
        percent: 0,
        categories: [],
        empty: true,
      }
    }
    let messages = [...await this.dependencies.conversation.listDiscussContextMessages(session.sessionId)]
    const duplicateStaticIds = findExactDuplicateStaticMessageIds(messages)
    if (duplicateStaticIds.length > 0) {
      await this.dependencies.conversation.hideDiscussContextMessages(
        session.sessionId,
        duplicateStaticIds,
        this.dependencies.now(),
      )
      messages = messages.filter((message) => !duplicateStaticIds.includes(message.messageId))
    }
    const usage = await this.hydrateDiscussUsage(input.projectId)
    const breakdown = buildContextUsageBreakdown({
      messages,
      contextWindowTokens: maxTokens,
      ...(usage?.lastRequestInputTokens === undefined
        ? {}
        : { lastRequestInputTokens: usage.lastRequestInputTokens }),
    })
    return {
      sessionId: session.sessionId,
      usedTokens: breakdown.usedTokens,
      maxTokens: breakdown.maxTokens,
      percent: breakdown.percent,
      categories: breakdown.categories,
      empty: breakdown.empty,
    }
  }

  public acknowledgeBudget(input: Readonly<{ projectId: ProjectId }>): Readonly<{
    budgetAdvisory?: SynopsisConversationBudgetAdvisory
  }> {
    acknowledgeSynopsisModelBudget(input.projectId)
    const advisory = peekSynopsisModelBudgetAdvisory(input.projectId)
    return advisory === undefined ? {} : { budgetAdvisory: advisory }
  }

  public async send(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    message: string
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    presentation?: Readonly<{
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    }>
    maxModelCalls?: number
    deadlineMs?: number
    signal?: AbortSignal
    focusLocked?: boolean
    lockedChapterSequence?: number
    lockedFocusKind?: DiscussFocusKind
    /** ChapterPanel 批量推演：自动确认梗概并允许同轮写细纲。 */
    automation?: "batch_chapter"
    /**
     * Creation-desk「批量推进」：跳过梗概/细纲/正文确认并自动连章。
     * false/缺省 = 每步停等用户确认（即便 agentMode=auto）。
     */
    batchProceed?: boolean
    /** Claude Code–style discuss mode. */
    agentMode?: import("@worldseed/contracts").DiscussAgentMode
  }>): Promise<SynopsisConversationSendResult> {
    const focusLocked = input.focusLocked === true
    const batchAutomation = input.automation === "batch_chapter"
    const batchProceed = input.batchProceed === true || batchAutomation
    const agentMode = input.agentMode ?? "auto"
    // Autonomous gates only when 批量推进（或卷批量 automation）开启；Auto  alone no longer skips confirms.
    const autonomous = batchProceed && (agentMode === "auto" || agentMode === "accept_edits")
    if (input.lockedChapterSequence !== undefined) {
      await this.setFocus({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        chapterSequence: input.lockedChapterSequence,
        focusKind: input.lockedFocusKind ?? "chapter_body",
      })
    }
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
    clearSynopsisSendCancellation(input.projectId)
    await this.hydrateDiscussUsage(input.projectId)
    // Reset stream hub before any further awaits so concurrent streamPeek cannot
    // resurface the previous turn's completed thinking/content.
    const streamStartedAtMs = this.dependencies.now()
    synopsisConversationStreamHub.begin(input.projectId, session.sessionId, streamStartedAtMs)
    try {
      const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
      const synopsisDigest = digest(synopsisMarkdown)
      const userEditedSinceAgent = session.lastAgentDigest !== undefined && session.lastAgentDigest !== synopsisDigest
      const outlinePathForRead = siblingPlanningMarkdownPath(session.synopsisPath, "outline")
        ?? deriveOutlineMarkdownPath(
          session.chapterSequence,
          session.title,
          extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
        )
      const outlineMarkdown = await this.readSynopsisFile(input.workspaceRootRef, outlinePathForRead)
      const outlineDigest = outlineMarkdown.trim().length === 0 ? undefined : digest(outlineMarkdown)
      const chapterBodyMarkdown = await this.readFocusedCommittedBody(
        input.projectId,
        input.workspaceRootRef,
        session.chapterSequence,
      )
      const latestDraftMarkdown = await this.readFocusedLatestDraft(
        input.projectId,
        session.chapterSequence,
      )
      const userEditedOutlineSinceAgent = session.lastOutlineAgentDigest !== undefined
        && outlineDigest !== undefined
        && session.lastOutlineAgentDigest !== outlineDigest
      const confirmingSynopsis = isConfirmSynopsisUserMessage(input.message)
      const nowMs = this.dependencies.now()
      let synopsisConfirmedAtMs = session.synopsisConfirmedAtMs
      if (userEditedSinceAgent && !confirmingSynopsis && synopsisConfirmedAtMs !== undefined) {
        synopsisConfirmedAtMs = undefined
        await this.dependencies.conversation.updateSession({
          sessionId: session.sessionId,
          synopsisConfirmedAtMs: null,
          updatedAtMs: nowMs,
        })
      }
      if (confirmingSynopsis && synopsisConfirmedAtMs === undefined) {
        synopsisConfirmedAtMs = nowMs
        await this.dependencies.conversation.updateSession({
          sessionId: session.sessionId,
          synopsisConfirmedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
      }
      const synopsisConfirmed = synopsisConfirmedAtMs !== undefined
      const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
      const activeGoals = selectGoalsForChapterContext(goalsSnapshot.goals, session.chapterSequence)
      const chapterProgress = goalsSnapshot.progress.filter(
        (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
      )
      const hookScheduleAudit = await this.dependencies.goals.auditHookSchedules(input.projectId)
      await this.dependencies.conversation.appendMessage({
        messageId: this.dependencies.createId(),
        projectId: input.projectId,
        sessionId: session.sessionId,
        role: "user",
        content: input.message,
        createdAtMs: nowMs,
      })
      const currentWorkDisplayName = this.dependencies.readDisplayName === undefined
        ? undefined
        : await this.dependencies.readDisplayName()
      let assist = await this.runSynopsisDiscuss({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        sessionId: session.sessionId,
        userMessage: input.message,
        heading: session.title,
        chapterSequence: session.chapterSequence,
        synopsisMarkdown,
        outlineMarkdown,
        ...(chapterBodyMarkdown === undefined ? {} : { chapterBodyMarkdown }),
        ...(latestDraftMarkdown === undefined ? {} : { latestDraftMarkdown }),
        focusKind: session.focusKind ?? "plot_synopsis",
        ...(focusLocked ? { focusLocked: true } : {}),
        ...(outlineDigest === undefined ? {} : { outlineDigest }),
        userEditedSinceAgent,
        userEditedOutlineSinceAgent,
        synopsisConfirmed: synopsisConfirmed || autonomous,
        ...(batchAutomation ? { batchAutomation: true } : {}),
        ...(batchProceed ? { batchProceed: true } : {}),
        ...(currentWorkDisplayName === undefined ? {} : { currentWorkDisplayName }),
        activeGoals,
        chapterProgress,
        hookScheduleAudit,
        model: input.model,
        allowWorkflowTools: true,
        agentMode,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
        ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
        ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      })
      // Mark stream completed as soon as the visible reply is ready, so the UI can leave
      // the "Stop / streaming" state while we still persist files and messages.
      synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
        ...(assist.reasoningContent === undefined ? {} : { thinking: assist.reasoningContent }),
        content: assist.content,
      })
      if (isSynopsisSendCancelled(input.projectId)) {
        throw new SynopsisSendCancelledError()
      }
      let synopsisPath = session.synopsisPath
      let sessionTitle = session.title
      let lastAgentDigest = session.lastAgentDigest
      let lastOutlineAgentDigest = session.lastOutlineAgentDigest
      let wroteSynopsisBody = false
      let nextSynopsisConfirmedAtMs = synopsisConfirmedAtMs
      const writeNotices: string[] = []
      const currentVolume = extractVolumeFolderNameFromPath(synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME
      const volumeFromAssist = assist.volumeFolderName === undefined
        ? undefined
        : validateVolumeFolderName(assist.volumeFolderName)
      if (volumeFromAssist !== undefined && !volumeFromAssist.ok) {
        throw new SynopsisInvalidStateError(volumeFromAssist.reason)
      }
      let nextVolume = volumeFromAssist?.ok === true ? volumeFromAssist.folderName : currentVolume
      let volumeCleanupFolder: string | undefined
      if (nextVolume !== currentVolume) {
        const volumeChange = await this.applyVolumeFolderChange({
          projectId: input.projectId,
          workspaceRootRef: input.workspaceRootRef,
          synopsisPath,
          fromFolderName: currentVolume,
          toFolderName: nextVolume,
        })
        synopsisPath = volumeChange.synopsisPath
        nextVolume = volumeChange.volumeFolderName
        volumeCleanupFolder = volumeChange.cleanupEmptyFolderName
      }
      if (assist.synopsisBody !== undefined && !userEditedSinceAgent) {
        wroteSynopsisBody = true
        const resolvedTitle = assist.chapterTitle?.trim()
          ?? extractSynopsisTitleFromDocument(assist.synopsisBody)
        if (resolvedTitle !== undefined && resolvedTitle.length > 0) {
          const nextPath = deriveSynopsisMarkdownPath(session.chapterSequence, resolvedTitle, nextVolume)
          this.emitDiscussEdit(input.projectId, {
            path: nextPath,
            kind: "synopsis",
            status: "running",
            summary: "正在写入剧情梗概",
          })
          if (nextPath !== synopsisPath) {
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              nextPath,
              assist.synopsisBody,
            )
            await this.relocateOutlineBesideSynopsis(
              input.workspaceRootRef,
              synopsisPath,
              nextPath,
            )
            await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, synopsisPath)
            synopsisPath = nextPath
            sessionTitle = resolvedTitle
          } else {
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              synopsisPath,
              assist.synopsisBody,
            )
            sessionTitle = resolvedTitle
          }
          this.emitDiscussEdit(input.projectId, {
            path: synopsisPath,
            kind: "synopsis",
            status: "completed",
            summary: "已写入剧情梗概",
          })
        } else {
          const nextPath = deriveSynopsisMarkdownPath(
            session.chapterSequence,
            sessionTitle,
            nextVolume,
          )
          this.emitDiscussEdit(input.projectId, {
            path: nextPath,
            kind: "synopsis",
            status: "running",
            summary: "正在写入剧情梗概",
          })
          if (nextPath !== synopsisPath) {
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              nextPath,
              assist.synopsisBody,
            )
            await this.relocateOutlineBesideSynopsis(
              input.workspaceRootRef,
              synopsisPath,
              nextPath,
            )
            await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, synopsisPath)
            synopsisPath = nextPath
          } else {
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              synopsisPath,
              assist.synopsisBody,
            )
          }
          this.emitDiscussEdit(input.projectId, {
            path: synopsisPath,
            kind: "synopsis",
            status: "completed",
            summary: "已写入剧情梗概",
          })
        }
        lastAgentDigest = digest(assist.synopsisBody)
      } else if (assist.synopsisBody !== undefined && userEditedSinceAgent) {
        writeNotices.push("你刚改过梗概文件，本轮未覆盖梗概。若要以我这版为准，请明确说「用我这版覆盖你的手改」。")
        this.emitDiscussEdit(input.projectId, {
          path: synopsisPath,
          kind: "synopsis",
          status: "failed",
          summary: "未落盘：你刚改过梗概文件",
        })
        runtimeLog("debug", "synopsis-conversation", "skipped-agent-overwrite", {
          projectId: input.projectId,
          sessionId: session.sessionId,
        })
      } else if ((assist.chapterTitle !== undefined || nextVolume !== currentVolume) && !userEditedSinceAgent) {
        const resolvedTitle = assist.chapterTitle?.trim() ?? sessionTitle
        if (resolvedTitle.length > 0) {
          const nextPath = deriveSynopsisMarkdownPath(session.chapterSequence, resolvedTitle, nextVolume)
          if (nextPath !== synopsisPath) {
            const currentBody = await this.readSynopsisFile(input.workspaceRootRef, synopsisPath)
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              nextPath,
              currentBody,
            )
            await this.relocateOutlineBesideSynopsis(
              input.workspaceRootRef,
              synopsisPath,
              nextPath,
            )
            await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, synopsisPath)
            synopsisPath = nextPath
            if (assist.chapterTitle !== undefined) sessionTitle = resolvedTitle
          }
        }
      }

      if (assist.titleAlignTarget !== undefined) {
        const aligned = await this.applyTitleAlignTarget({
          projectId: input.projectId,
          workspaceRootRef: input.workspaceRootRef,
          chapterSequence: session.chapterSequence,
          target: assist.titleAlignTarget,
          synopsisPath,
          sessionTitle,
          volumeFolderName: nextVolume,
        })
        synopsisPath = aligned.synopsisPath
        sessionTitle = aligned.sessionTitle
        writeNotices.push(...aligned.notices)
      }

      let styleDiskMarkdown: string | undefined
      try {
        styleDiskMarkdown = await this.dependencies.workspace.readMarkdown(
          input.workspaceRootRef,
          WORK_STYLE_RULE_PATH,
        )
      } catch {
        styleDiskMarkdown = undefined
      }
      const styleGated = applyColdStartStyleGate({
        assist,
        diskStyleMarkdown: styleDiskMarkdown,
      })
      assist = styleGated.assist
      if (styleGated.notices.length > 0) writeNotices.push(...styleGated.notices)

      if (assist.volumeChapterPlans !== undefined && assist.volumeChapterPlans.length > 0) {
        const planVolume = nextVolume
          ?? extractVolumeFolderNameFromPath(synopsisPath)
          ?? DEFAULT_VOLUME_FOLDER_NAME
        for (const plan of assist.volumeChapterPlans) {
          const persisted = await this.persistVolumeChapterPlan({
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            plan,
            volumeFolderName: planVolume,
          })
          if (plan.chapterSequence === session.chapterSequence) {
            wroteSynopsisBody = true
            synopsisPath = persisted.synopsisPath
            sessionTitle = persisted.title
            lastAgentDigest = digest(plan.synopsisBody)
          }
        }
      }

      const outlineWriteAllowed = synopsisConfirmed || confirmingSynopsis || batchAutomation || autonomous
      const outlinePath = siblingPlanningMarkdownPath(synopsisPath, "outline")
        ?? deriveOutlineMarkdownPath(
          session.chapterSequence,
          sessionTitle,
          extractVolumeFolderNameFromPath(synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
        )
      if (assist.bodyEdits !== undefined) {
        this.emitDiscussEdit(input.projectId, {
          path: outlinePath,
          kind: "body_edits",
          status: "running",
          summary: "正在局部更新细纲",
          opsAttempted: assist.bodyEdits.ops.length,
        })
        if (!outlineWriteAllowed) {
          writeNotices.push("细纲尚未确认可写：本轮 bodyEdits 未落盘。请先点「用这份梗概写细纲」。")
          this.emitDiscussEdit(input.projectId, {
            path: outlinePath,
            kind: "body_edits",
            status: "failed",
            summary: "未落盘：细纲尚未确认可写",
            opsAttempted: assist.bodyEdits.ops.length,
            opsApplied: 0,
          })
          runtimeLog("debug", "synopsis-conversation", "outline-edits-blocked-until-synopsis-confirmed", {
            projectId: input.projectId,
            sessionId: session.sessionId,
          })
        } else if (userEditedOutlineSinceAgent) {
          writeNotices.push("你刚改过细纲文件，本轮未应用局部编辑。若要以我这版为准，请明确说「用我这版覆盖你的手改」。")
          this.emitDiscussEdit(input.projectId, {
            path: outlinePath,
            kind: "body_edits",
            status: "failed",
            summary: "未落盘：你刚改过细纲文件",
            opsAttempted: assist.bodyEdits.ops.length,
            opsApplied: 0,
          })
        } else {
          const currentOutline = await this.readSynopsisFile(input.workspaceRootRef, outlinePath)
          if (currentOutline.trim().length === 0) {
            writeNotices.push("细纲文件尚不存在或为空，无法局部编辑；请先输出完整 outlineBody。")
            this.emitDiscussEdit(input.projectId, {
              path: outlinePath,
              kind: "body_edits",
              status: "failed",
              summary: "未落盘：细纲为空或不存在",
              opsAttempted: assist.bodyEdits.ops.length,
              opsApplied: 0,
            })
          } else if (
            assist.bodyEdits.baseDigest !== undefined
            && digest(currentOutline) !== assist.bodyEdits.baseDigest
          ) {
            writeNotices.push("细纲已变化（baseDigest 不匹配），本轮 bodyEdits 未落盘。请基于最新细纲重抄 oldText，或改吐全量 outlineBody。")
            this.emitDiscussEdit(input.projectId, {
              path: outlinePath,
              kind: "body_edits",
              status: "failed",
              summary: "未落盘：baseDigest 不匹配",
              opsAttempted: assist.bodyEdits.ops.length,
              opsApplied: 0,
            })
          } else {
            const applied = applySearchReplace(currentOutline, assist.bodyEdits.ops)
            if (!applied.ok) {
              writeNotices.push(`${applied.reason}；细纲未改盘。请重贴锚点或改吐全量 outlineBody。`)
              this.emitDiscussEdit(input.projectId, {
                path: outlinePath,
                kind: "body_edits",
                status: "failed",
                summary: applied.reason,
                opsAttempted: assist.bodyEdits.ops.length,
                opsApplied: 0,
              })
            } else {
              await this.dependencies.workspace.saveSynopsisMarkdown(
                input.workspaceRootRef,
                outlinePath,
                applied.content,
              )
              lastOutlineAgentDigest = digest(applied.content)
              writeNotices.push(`已局部更新细纲（${String(applied.appliedCount)} 处）。`)
              this.emitDiscussEdit(input.projectId, {
                path: outlinePath,
                kind: "body_edits",
                status: "completed",
                summary: `已局部更新细纲（${String(applied.appliedCount)} 处）`,
                opsAttempted: assist.bodyEdits.ops.length,
                opsApplied: applied.appliedCount,
              })
            }
          }
        }
      } else if (assist.outlineBody !== undefined && outlineWriteAllowed) {
        this.emitDiscussEdit(input.projectId, {
          path: outlinePath,
          kind: "outline",
          status: "running",
          summary: "正在写入剧情细纲",
        })
        if (userEditedOutlineSinceAgent) {
          writeNotices.push("你刚改过细纲文件，本轮未覆盖细纲。若要以我这版为准，请明确说「用我这版覆盖你的手改」。")
          this.emitDiscussEdit(input.projectId, {
            path: outlinePath,
            kind: "outline",
            status: "failed",
            summary: "未落盘：你刚改过细纲文件",
          })
        } else {
          await this.dependencies.workspace.saveSynopsisMarkdown(
            input.workspaceRootRef,
            outlinePath,
            assist.outlineBody,
          )
          lastOutlineAgentDigest = digest(assist.outlineBody)
          this.emitDiscussEdit(input.projectId, {
            path: outlinePath,
            kind: "outline",
            status: "completed",
            summary: "已写入剧情细纲",
          })
        }
      } else if (assist.outlineBody !== undefined) {
        writeNotices.push("细纲尚未确认可写：本轮 outlineBody 未落盘。请先点「用这份梗概写细纲」。")
        this.emitDiscussEdit(input.projectId, {
          path: outlinePath,
          kind: "outline",
          status: "failed",
          summary: "未落盘：细纲尚未确认可写",
        })
        runtimeLog("debug", "synopsis-conversation", "outline-blocked-until-synopsis-confirmed", {
          projectId: input.projectId,
          sessionId: session.sessionId,
        })
      }

      const wroteOutlineThisTurn = lastOutlineAgentDigest !== undefined
        && lastOutlineAgentDigest !== session.lastOutlineAgentDigest
      if (wroteSynopsisBody && batchAutomation) {
        nextSynopsisConfirmedAtMs = nowMs
      } else if (wroteSynopsisBody && !confirmingSynopsis) {
        nextSynopsisConfirmedAtMs = undefined
      }
      if (confirmingSynopsis || (batchAutomation && wroteSynopsisBody)) {
        nextSynopsisConfirmedAtMs = nextSynopsisConfirmedAtMs ?? nowMs
      }

      if (volumeCleanupFolder !== undefined) {
        await this.tryRemoveEmptyVolumeDirectory(input.workspaceRootRef, volumeCleanupFolder)
      }

      const confirmingOutline = isConfirmOutlineUserMessage(input.message)
      const hasOutlineOnDisk = (outlineDigest !== undefined && outlineMarkdown.trim().length > 0)
        || wroteOutlineThisTurn
      // 批量推进关闭：须「按细纲写正文」或「跳过细纲按梗概开推」后才写正文。
      const bodyWriteAllowed = autonomous || batchAutomation || confirmingOutline
        || isSkipOutlineStartTurnMessage(input.message)
      const mustStopAfterOutline = wroteOutlineThisTurn && !autonomous && !batchAutomation
      const blockBodyPipeline = !bodyWriteAllowed || mustStopAfterOutline
      let draftAssist = assist
      if (blockBodyPipeline) {
        if (
          assist.chapterDraftProposal !== undefined
          || (assist.chapterDraftProposals?.length ?? 0) > 0
          || assist.appendedDraft !== undefined
        ) {
          writeNotices.push(
            hasOutlineOnDisk || wroteOutlineThisTurn
              ? "正文尚未确认可写：本轮草稿未落盘。请先点「按细纲写正文」。"
              : "请先完成梗概确认并写细纲，或点「跳过细纲，按梗概开推」。",
          )
        }
        const {
          chapterDraftProposal: _blockedProposal,
          chapterDraftProposals: _blockedProposals,
          appendedDraft: _blockedAppended,
          continueTurn: _blockedContinue,
          focusChange: _blockedFocus,
          ...assistWithoutBodyWrites
        } = assist
        draftAssist = {
          ...assistWithoutBodyWrites,
          choices: (hasOutlineOnDisk || wroteOutlineThisTurn)
            ? mergeConfirmOutlineChoice(assist.choices)
            : assist.choices,
        }
      } else if (!autonomous && !batchAutomation) {
        // 逐步确认：禁止自动跳章
        const { continueTurn: _stepContinue, focusChange: _stepFocus, ...assistWithoutJump } = assist
        draftAssist = assistWithoutJump
      }

      const assistantMessageId = this.dependencies.createId()
      const draftVolume = extractVolumeFolderNameFromPath(synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME
      const deferredDraftSequences: number[] = []
      let draftApply: Awaited<ReturnType<SynopsisConversationService["applyDiscussChapterDraft"]>> =
        draftAssist.chapterDraftProposal === undefined && draftAssist.appendedDraft !== undefined
          ? { appended: draftAssist.appendedDraft }
          : await this.applyDiscussChapterDraft({
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            chapterSequence: session.chapterSequence,
            volumeFolderName: draftVolume,
            ...(draftAssist.chapterDraftProposal === undefined ? {} : { proposal: draftAssist.chapterDraftProposal }),
            messageId: assistantMessageId,
          })
      if (draftApply.notice !== undefined) writeNotices.push(draftApply.notice)
      if (draftApply.deferredSequence !== undefined) deferredDraftSequences.push(draftApply.deferredSequence)
      if (draftAssist.chapterDraftProposals !== undefined) {
        for (const entry of draftAssist.chapterDraftProposals) {
          const applied = await this.applyDiscussChapterDraft({
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            chapterSequence: entry.chapterSequence,
            volumeFolderName: draftVolume,
            proposal: {
              base: entry.base,
              heading: entry.heading,
              body: entry.body,
              ...(entry.baseDraftVersionId === undefined ? {} : { baseDraftVersionId: entry.baseDraftVersionId }),
            },
            messageId: assistantMessageId,
          })
          if (applied.notice !== undefined) writeNotices.push(applied.notice)
          if (applied.deferredSequence !== undefined) deferredDraftSequences.push(applied.deferredSequence)
          if (entry.chapterSequence === session.chapterSequence && applied.appended !== undefined) {
            draftApply = applied
          }
        }
      }
      if (deferredDraftSequences.length > 0) {
        const nextSequence = await this.dependencies.chapters.nextChapterSequence(input.projectId)
        this.applyChapterSequenceTodoGate(
          input.projectId,
          session.sessionId,
          nextSequence,
          deferredDraftSequences,
        )
        await this.dependencies.conversation.appendDiscussContextMessages({
          sessionId: session.sessionId,
          projectId: input.projectId,
          createdAtMs: this.dependencies.now(),
          messages: [{
            role: "system",
            kind: "phase_instruction",
            content: JSON.stringify({
              protocol: "discuss-gate-v1",
              gate: "chapter_sequence_publish",
              nextSequence,
              deferredSequences: deferredDraftSequences,
              message: discussChapterSequenceGateHint(nextSequence, deferredDraftSequences),
            }),
          }],
        })
        runtimeLog("info", "synopsis-conversation", "chapter_sequence.gate_applied", {
          projectId: input.projectId,
          sessionId: session.sessionId,
          nextSequence,
          deferredSequences: deferredDraftSequences,
        })
      }
      let appliedFocusSequence: number | undefined
      let focusGateDeferred = false
      if (draftAssist.focusChange !== undefined) {
        if (focusLocked) {
          writeNotices.push("当前入口已锁定焦点，本轮 focusChange 未生效。")
        } else if (batchAutomation) {
          writeNotices.push("批量推演中焦点由系统推进，本轮 focusChange 未生效。")
        } else if (!autonomous) {
          writeNotices.push("批量推进已关闭：本轮 focusChange 未生效，请确认后再手动换章。")
        } else {
          const targetSequence = draftAssist.focusChange.chapterSequence
          const nextSequence = await this.waitForChapterSequenceGate(input.projectId, targetSequence)
          if (targetSequence > nextSequence) {
            focusGateDeferred = true
            this.applyChapterSequenceTodoGate(input.projectId, session.sessionId, nextSequence, [targetSequence])
            writeNotices.push(
              `门禁：第${String(nextSequence)}章尚未完成图修订发布，焦点暂留；完成后将自动继续推进到第${String(targetSequence)}章。`,
            )
          } else {
            try {
              await this.setFocus({
                projectId: input.projectId,
                workspaceRootRef: input.workspaceRootRef,
                chapterSequence: targetSequence,
                focusKind: draftAssist.focusChange.focusKind ?? "plot_synopsis",
              })
              appliedFocusSequence = targetSequence
              writeNotices.push(`已将讨论焦点调整到第 ${String(targetSequence)} 章（无需确认）。`)
            } catch (error) {
              if (!isPrecedingChapterPublishGateError(error)) throw error
              focusGateDeferred = true
              writeNotices.push(`门禁：前一章尚未发布，焦点暂留；完成后将自动继续推进到第${String(targetSequence)}章。`)
            }
          }
        }
      }
      const gateDeferred = !focusLocked && (focusGateDeferred || deferredDraftSequences.length > 0)
      const persistedChoices = filterDiscussChoices(
        this.dependencies.publishDraft === undefined
          ? withPromoteDraftChoice(draftAssist.choices, draftApply.appended?.draftLabel)
          : draftAssist.choices,
        {
          focusLocked,
          ...(appliedFocusSequence === undefined ? {} : { appliedFocusSequence }),
        },
      )
      // 批量推进开启时：Todo 未清 / continueTurn / 自决 choices 都自动续跑。
      // 关闭时：仅门禁延迟（如前章发布中）可续跑，流水线步骤必须等用户点确认。
      const todosStillOpen = !discussTodosAreSettled(
        synopsisConversationStreamHub.peek(input.projectId, session.sessionId).todos,
      )
      const offeredChoices = persistedChoices ?? []
      const waitingOnUser = !autonomous && offeredChoices.length > 0
      const autoDecideChoices = autonomous && offeredChoices.length > 0
      const autoContinue = agentMode !== "plan" && !batchAutomation
        && (
          gateDeferred
          || (autonomous && (
            draftAssist.continueTurn === true
            || autoDecideChoices
            || (todosStillOpen && !waitingOnUser)
          ))
        )
        ? {
            message: autoDecideChoices
              ? [
                  "继续（批量推进·自决）：上一轮列出的选项无需用户确认——",
                  offeredChoices.slice(0, 6).map((choice) => `「${choice.label}」`).join("、"),
                  "。按最合理的顺序自行决定并执行（可依次全部完成），在回复里简述取舍理由；不要再给待选按钮。",
                ].join("").slice(0, 500)
              : "继续：按 Todo 推进未完成的步骤（前一章图修订完成后写/发布下一章，不要停下来等确认）。",
          }
        : undefined

      const assistantContent = writeNotices.length === 0
        ? assist.content
        : `${assist.content}\n\n——\n${writeNotices.join("\n")}`
      if (isSynopsisSendCancelled(input.projectId)) {
        throw new SynopsisSendCancelledError()
      }
      if (assist.stagingDelta !== undefined) {
        const stagingPaths = await this.applyStagingDelta({
          workspaceRootRef: input.workspaceRootRef,
          delta: assist.stagingDelta,
          sourceMessageId: assistantMessageId,
        })
        for (const path of stagingPaths) {
          this.emitDiscussEdit(input.projectId, {
            path,
            kind: "staging",
            status: "completed",
            summary: "已更新暂存区草稿",
          })
        }
      }
      if (assist.arcPlanMarkdown !== undefined) {
        this.emitDiscussEdit(input.projectId, {
          path: ARC_PLAN_STAGING_PATH,
          kind: "arc_plan",
          status: "running",
          summary: "正在写入弧线规划",
        })
        await this.dependencies.workspace.saveUserMarkdown(
          input.workspaceRootRef,
          ARC_PLAN_STAGING_PATH,
          assist.arcPlanMarkdown,
        )
        this.emitDiscussEdit(input.projectId, {
          path: ARC_PLAN_STAGING_PATH,
          kind: "arc_plan",
          status: "completed",
          summary: "已写入弧线规划",
        })
        const volumeOutlinePath = volumeOutlinePlanPath(nextVolume)
        this.emitDiscussEdit(input.projectId, {
          path: volumeOutlinePath,
          kind: "arc_plan",
          status: "running",
          summary: "正在写入卷大纲",
        })
        await this.dependencies.workspace.saveUserMarkdown(
          input.workspaceRootRef,
          volumeOutlinePath,
          assist.arcPlanMarkdown,
        )
        this.emitDiscussEdit(input.projectId, {
          path: volumeOutlinePath,
          kind: "arc_plan",
          status: "completed",
          summary: "已写入卷大纲",
        })
      }
      if (assist.presentationWrites !== undefined && assist.presentationWrites.length > 0) {
        for (const write of assist.presentationWrites) {
          this.emitDiscussEdit(input.projectId, {
            path: write.relativePath,
            kind: "presentation",
            status: "running",
            summary: `${write.mode === "create" ? "正在新建" : "正在更新"}表现规则`,
          })
        }
        await this.applyPresentationWrites({
          workspaceRootRef: input.workspaceRootRef,
          writes: assist.presentationWrites,
        })
        for (const write of assist.presentationWrites) {
          this.emitDiscussEdit(input.projectId, {
            path: write.relativePath,
            kind: "presentation",
            status: "completed",
            summary: `${write.mode} ${write.relativePath}`,
          })
        }
      }
      let workDisplayName: string | undefined
      if (
        assist.workDisplayName !== undefined
        && this.dependencies.renameDisplayName !== undefined
      ) {
        const nextName = assist.workDisplayName.trim()
        if (nextName.length > 0) {
          workDisplayName = await this.dependencies.renameDisplayName(nextName)
        }
      }
      const streamPeek = synopsisConversationStreamHub.peek(input.projectId, session.sessionId)
      const persistedThinking = normalizeThinkingDisplayText(
        assist.reasoningContent ?? (streamPeek.thinking.length === 0 ? undefined : streamPeek.thinking),
      )
      await this.dependencies.conversation.appendMessage({
        messageId: assistantMessageId,
        projectId: input.projectId,
        sessionId: session.sessionId,
        role: "assistant",
        content: assistantContent,
        ...(persistedThinking === undefined ? {} : { reasoningContent: persistedThinking }),
        ...(streamPeek.thinkingRounds.length === 0 ? {} : { thinkingRounds: streamPeek.thinkingRounds }),
        ...(streamPeek.searching.length === 0 ? {} : { searching: streamPeek.searching }),
        ...(streamPeek.editing.length === 0 ? {} : { editing: streamPeek.editing }),
        ...(streamPeek.toolRuns.length === 0 ? {} : { toolRuns: streamPeek.toolRuns }),
        ...(streamPeek.todos.length === 0 ? {} : { todos: streamPeek.todos }),
        ...(persistedChoices === undefined ? {} : { choices: persistedChoices }),
        createdAtMs: nowMs + 1,
      })
      const createdProposals = assist.goalProposals === undefined || assist.goalProposals.length === 0
        ? []
        : await this.dependencies.goals.createProposalsFromArtifact({
            projectId: input.projectId,
            proposals: assist.goalProposals,
            sourceMessageId: assistantMessageId,
          })
      const projectSettings = this.dependencies.readProjectSettings === undefined
        ? undefined
        : await this.dependencies.readProjectSettings()
      const autoApproveGoals = projectSettings?.creationDesk.autoApproveGoalProposals !== false
      let pendingProposals = createdProposals
      if (autoApproveGoals && createdProposals.length > 0) {
        const { failed } = await this.dependencies.goals.approveProposalsLenient({
          projectId: input.projectId,
          proposalIds: createdProposals.map((proposal) => proposal.proposalId),
        })
        const failedIds = new Set(failed.map((item) => item.proposalId))
        pendingProposals = createdProposals.filter((proposal) => failedIds.has(proposal.proposalId))
        if (failed.length > 0) {
          runtimeLog("warn", "synopsis-conversation", "goal_proposals.kept_pending", {
            projectId: input.projectId,
            failed: failed.map((item) => item.message),
          })
        }
      }
      let pendingStagingPromotes = assist.stagingPromote === undefined
        ? []
        : [await this.dependencies.stagingPromote.createFromArtifact({
            projectId: input.projectId,
            sessionId: session.sessionId,
            sourceMessageId: assistantMessageId,
            settingsWrites: assist.stagingPromote.settingsWrites,
            ...(assist.stagingPromote.goalProposals === undefined
              ? {}
              : { goalProposals: assist.stagingPromote.goalProposals }),
            ...(assist.stagingPromote.reason === undefined ? {} : { reason: assist.stagingPromote.reason }),
          })]
      if (autonomous && pendingStagingPromotes.length > 0) {
        // Lineage records each promote, so Auto applies it instead of waiting for 采纳.
        try {
          await this.dependencies.stagingPromote.approve({
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            proposalIds: pendingStagingPromotes.map((proposal) => proposal.proposalId),
          })
          pendingStagingPromotes = []
        } catch (error) {
          runtimeLog("warn", "synopsis-conversation", "staging_promote.auto_approve_failed", {
            projectId: input.projectId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // Digests/title still belong to the chapter this turn wrote; focusChange already
      // moved session.chapterSequence via setFocus — only patch digests when focus stayed.
      if (appliedFocusSequence === undefined) {
        await this.dependencies.conversation.updateSession({
          sessionId: session.sessionId,
          synopsisPath,
          title: sessionTitle,
          ...(lastAgentDigest === undefined ? {} : { lastAgentDigest }),
          ...(lastOutlineAgentDigest === undefined ? {} : { lastOutlineAgentDigest }),
          synopsisConfirmedAtMs: nextSynopsisConfirmedAtMs === undefined ? null : nextSynopsisConfirmedAtMs,
          updatedAtMs: nowMs + 1,
        })
      } else if (lastAgentDigest !== undefined || lastOutlineAgentDigest !== undefined) {
        // Focus moved: keep new focus paths from setFocus; do not overwrite with old chapter digests.
      }
      const updatedSession = (await this.dependencies.conversation.findSession(session.sessionId)) as NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
        thinking: assist.reasoningContent ?? streamPeek.thinking,
        content: assistantContent,
      })
      // Drop completed thinking/content so the next send cannot briefly re-show this turn.
      // Cumulative usage is retained for composer metrics (and persisted below).
      const usage = synopsisConversationStreamHub.readCumulativeUsage(input.projectId)
      synopsisConversationStreamHub.clear(input.projectId)
      if (usage !== undefined) {
        await this.dependencies.conversation.saveDiscussUsage({
          projectId: input.projectId,
          usage,
          updatedAtMs: this.dependencies.now(),
        })
      }
      const budgetAdvisory = assist.budgetAdvisory ?? peekSynopsisModelBudgetAdvisory(input.projectId)
      return {
        session: updatedSession,
        messages: [...messages],
        ...(pendingProposals.length === 0 ? {} : { pendingProposals: [...pendingProposals] }),
        ...(pendingStagingPromotes.length === 0
          ? {}
          : { pendingStagingPromotes: [...pendingStagingPromotes] }),
        ...(budgetAdvisory === undefined ? {} : { budgetAdvisory }),
        ...(usage === undefined ? {} : { usage }),
        ...(workDisplayName === undefined ? {} : { workDisplayName }),
        ...(draftApply.appended === undefined ? {} : { appendedDraft: draftApply.appended }),
        ...(autoContinue === undefined ? {} : { autoContinue }),
      }
    } catch (error) {
      const cancelled = error instanceof SynopsisSendCancelledError || isSynopsisSendCancelled(input.projectId)
      const errorLabel = cancelled
        ? "用户停止对话"
        : (error instanceof Error ? error.message : String(error))
      try {
        await this.persistInterruptedAssistantTurn({
          projectId: input.projectId,
          sessionId: session.sessionId,
          errorLabel,
        })
      } catch {
        // Best-effort: never lose the throw path because persistence failed.
      }
      synopsisConversationStreamHub.fail(input.projectId, errorLabel, this.dependencies.now())
      synopsisConversationStreamHub.clear(input.projectId)
      if (cancelled) {
        clearSynopsisSendCancellation(input.projectId)
        throw error instanceof SynopsisSendCancelledError ? error : new SynopsisSendCancelledError()
      }
      throw error
    }
  }

  /**
   * Stop an in-flight / timed-out user turn: cancel the active send, keep the user
   * message, and persist any partial assistant stream so the chat does not go blank.
   */
  public async discardLastUserTurn(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId?: string
  }>): Promise<SynopsisConversationListResult> {
    markSynopsisSendCancelled(input.projectId)
    const session = input.sessionId === undefined
      ? await this.dependencies.conversation.findActiveSession(input.projectId)
      : await this.dependencies.conversation.findSession(input.sessionId)
    if (session !== undefined && session.projectId === input.projectId) {
      try {
        await this.persistInterruptedAssistantTurn({
          projectId: input.projectId,
          sessionId: session.sessionId,
          errorLabel: "用户停止对话",
        })
      } catch {
        // Best-effort keep of partial reply.
      }
      // Keep discuss model-context turns; only cancel the in-flight send.
    }
    synopsisConversationStreamHub.fail(input.projectId, "用户停止对话", this.dependencies.now())
    synopsisConversationStreamHub.clear(input.projectId)
    return this.list({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
    })
  }

  /** Persist a failed/stopped discuss bubble from the live stream hub (idempotent-ish). */
  private async persistInterruptedAssistantTurn(input: Readonly<{
    projectId: ProjectId
    sessionId: string
    errorLabel: string
  }>): Promise<void> {
    const peek = synopsisConversationStreamHub.peek(input.projectId, input.sessionId)
    if (!streamHasVisibleProgress(peek) && peek.status !== "failed" && peek.status !== "running") {
      // Still record a short bubble so the user turn is not left alone after an early crash.
      if (peek.status === "idle") return
    }
    const existing = await this.dependencies.conversation.listMessages(input.sessionId)
    const last = existing.at(-1)
    if (
      last?.role === "assistant"
      && last.error !== undefined
      && last.error === input.errorLabel
    ) {
      return
    }
    if (!streamHasVisibleProgress(peek) && last?.role === "assistant") {
      return
    }
    const fields = buildInterruptedAssistantMessageFields(
      peek,
      input.errorLabel,
    )
    await this.dependencies.conversation.appendMessage({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      role: "assistant",
      content: fields.content,
      ...(fields.reasoningContent === undefined ? {} : { reasoningContent: fields.reasoningContent }),
      ...(fields.thinkingRounds === undefined ? {} : { thinkingRounds: fields.thinkingRounds }),
      ...(fields.searching === undefined ? {} : { searching: fields.searching }),
      ...(fields.editing === undefined ? {} : { editing: fields.editing }),
      ...(fields.toolRuns === undefined ? {} : { toolRuns: fields.toolRuns }),
      ...(fields.todos === undefined ? {} : { todos: fields.todos }),
      error: fields.error,
      createdAtMs: this.dependencies.now(),
    })
  }

  /**
   * Quietly regenerate decision chips: appends hidden context messages, then merges
   * new choices onto the visible assistant message without a new chat bubble.
   */
  public async refreshChoices(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    messageId?: string
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    presentation?: Readonly<{
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    }>
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<SynopsisConversationSendResult> {
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
    await this.hydrateDiscussUsage(input.projectId)
    const priorMessages = await this.dependencies.conversation.listMessages(session.sessionId)
    const target = resolveRefreshTargetMessage(priorMessages, input.messageId)
    if (target === undefined) {
      throw new SynopsisInvalidStateError("没有可刷新的选项")
    }
    const existingChoices = target.choices ?? []
    const refreshPrompt = buildRefreshChoicesPrompt(existingChoices)
    const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
    const synopsisDigest = digest(synopsisMarkdown)
    const userEditedSinceAgent = session.lastAgentDigest !== undefined && session.lastAgentDigest !== synopsisDigest
    const nowMs = this.dependencies.now()
    const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
    const activeGoals = selectGoalsForChapterContext(goalsSnapshot.goals, session.chapterSequence)
    const chapterProgress = goalsSnapshot.progress.filter(
      (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
    )
    const hookScheduleAudit = await this.dependencies.goals.auditHookSchedules(input.projectId)
    await this.dependencies.conversation.appendMessage({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "user",
      content: refreshPrompt,
      hidden: true,
      createdAtMs: nowMs,
    })
    const outlinePathForRefresh = siblingPlanningMarkdownPath(session.synopsisPath, "outline")
      ?? deriveOutlineMarkdownPath(
        session.chapterSequence,
        session.title,
        extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
      )
    const outlineMarkdown = await this.readSynopsisFile(input.workspaceRootRef, outlinePathForRefresh)
    const outlineDigest = outlineMarkdown.trim().length === 0 ? undefined : digest(outlineMarkdown)
    const chapterBodyMarkdown = await this.readFocusedCommittedBody(
      input.projectId,
      input.workspaceRootRef,
      session.chapterSequence,
    )
    const userEditedOutlineSinceAgent = session.lastOutlineAgentDigest !== undefined
      && outlineDigest !== undefined
      && session.lastOutlineAgentDigest !== outlineDigest
    const assist = await this.runSynopsisDiscuss({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      sessionId: session.sessionId,
      userMessage: refreshPrompt,
      heading: session.title,
      chapterSequence: session.chapterSequence,
      synopsisMarkdown,
      outlineMarkdown,
      ...(chapterBodyMarkdown === undefined ? {} : { chapterBodyMarkdown }),
      ...(outlineDigest === undefined ? {} : { outlineDigest }),
      userEditedSinceAgent,
      userEditedOutlineSinceAgent,
      synopsisConfirmed: session.synopsisConfirmedAtMs !== undefined,
      activeGoals,
      chapterProgress,
      hookScheduleAudit,
      model: input.model,
      ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
      ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    })
    const incoming = assist.choices ?? []
    if (incoming.length === 0) {
      throw new SynopsisInvalidStateError("模型未返回新的选项，请重试刷新")
    }
    const mergedChoices = mergeSynopsisChoices(existingChoices, incoming)
    if (mergedChoices.length === existingChoices.length) {
      throw new SynopsisInvalidStateError("新选项与已有选项重复，请再试一次刷新")
    }
    await this.dependencies.conversation.updateMessageChoices(target.messageId, mergedChoices)
    await this.dependencies.conversation.appendMessage({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "assistant",
      content: assist.content.trim().length > 0
        ? assist.content
        : `已追加 ${String(mergedChoices.length - existingChoices.length)} 个新选项。`,
      hidden: true,
      createdAtMs: this.dependencies.now(),
    })
    await this.dependencies.conversation.updateSession({
      sessionId: session.sessionId,
      updatedAtMs: this.dependencies.now(),
    })
    const updatedSession = (await this.dependencies.conversation.findSession(session.sessionId)) as NonNullable<
      Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>
    >
    const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    const usage = synopsisConversationStreamHub.readCumulativeUsage(input.projectId)
    if (usage !== undefined) {
      await this.dependencies.conversation.saveDiscussUsage({
        projectId: input.projectId,
        usage,
        updatedAtMs: this.dependencies.now(),
      })
    }
    return {
      session: updatedSession,
      messages: [...messages],
      ...(usage === undefined ? {} : { usage }),
    }
  }

  public async resolveTurnInput(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId?: string
  }>): Promise<SynopsisResolveTurnInputResult> {
    const session = input.sessionId === undefined
      ? await this.dependencies.conversation.findActiveSession(input.projectId)
      : await this.dependencies.conversation.findSession(input.sessionId)
    if (session === undefined || session.projectId !== input.projectId) {
      throw new SynopsisInvalidStateError("No active synopsis conversation session")
    }
    const resolved = await this.resolveBootstrapInput(input.workspaceRootRef, session)
    await this.dependencies.conversation.updateSession({
      sessionId: session.sessionId,
      turnBootstrapInput: resolved.userInput,
      updatedAtMs: this.dependencies.now(),
    })
    const deductionGoalBundle = await this.dependencies.goals.buildTurnBundle({
      projectId: input.projectId,
      chapterSequence: resolved.chapterSequence,
    })
    const projectSettings = this.dependencies.readProjectSettings === undefined
      ? undefined
      : await this.dependencies.readProjectSettings()
    const requireCompleteHookSchedules = projectSettings?.creationDesk.requireCompleteHookSchedules !== false
    const reconcile = await this.dependencies.goals.reconcileForTurn({
      projectId: input.projectId,
      chapterSequence: resolved.chapterSequence,
      synopsisMarkdown: resolved.userInput,
      requireCompleteHookSchedules,
    })
    return {
      ...resolved,
      deductionGoalBundle,
      reconcile,
    }
  }

  public async prepareBeginTurn(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId?: string
    acknowledgeWarnings?: boolean
    forceOverride?: boolean
  }>): Promise<Readonly<{
    userInput: string
    chapterSequence: number
    source: SynopsisResolveTurnInputResult["source"]
    synopsisPath?: string
    reconcile: NonNullable<SynopsisResolveTurnInputResult["reconcile"]>
  }>> {
    const resolved = await this.resolveTurnInput({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })
    const reconcile = resolved.reconcile ?? { warnings: [], blocking: [] }
    const hookBlocks = reconcile.blocking.filter((issue) => issue.code === "incomplete_hook_schedule")
    const otherBlocks = reconcile.blocking.filter((issue) => issue.code !== "incomplete_hook_schedule")
    if (hookBlocks.length > 0) {
      throw new SynopsisInvalidStateError(
        `推演清单：钩子时限不完整，无法开始推演——${hookBlocks.map((issue) => issue.message).join("；")}`,
      )
    }
    if (otherBlocks.length > 0 && input.forceOverride !== true) {
      throw new SynopsisInvalidStateError(
        `推演目标与梗概存在冲突，无法开始推演：${otherBlocks.map((issue) => issue.message).join("；")}`,
      )
    }
    return {
      userInput: resolved.userInput,
      chapterSequence: resolved.chapterSequence,
      source: resolved.source,
      ...(resolved.synopsisPath === undefined ? {} : { synopsisPath: resolved.synopsisPath }),
      reconcile,
    }
  }

  private async hydrateDiscussUsage(projectId: ProjectId): Promise<SynopsisConversationStreamUsage | undefined> {
    const inMemory = synopsisConversationStreamHub.readCumulativeUsage(projectId)
    if (inMemory !== undefined) return inMemory
    const stored = await this.dependencies.conversation.loadDiscussUsage(projectId)
    if (stored === undefined) return undefined
    synopsisConversationStreamHub.hydrateCumulativeUsage(projectId, {
      ...(stored.inputTokens === undefined ? {} : { inputTokens: stored.inputTokens }),
      ...(stored.outputTokens === undefined ? {} : { outputTokens: stored.outputTokens }),
      ...(stored.cacheHitInputTokens === undefined ? {} : { cacheHitInputTokens: stored.cacheHitInputTokens }),
      ...(stored.cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens: stored.cacheMissInputTokens }),
      ...(stored.lastRequestInputTokens === undefined
        ? {}
        : { lastRequestInputTokens: stored.lastRequestInputTokens }),
    })
    return stored
  }

  private async ensureActiveSession(projectId: ProjectId, workspaceRootRef: string) {
    const active = await this.dependencies.conversation.findActiveSession(projectId)
    if (active !== undefined) {
      return this.reconcileSessionSynopsisPath(workspaceRootRef, active)
    }
    const started = await this.start({ projectId, workspaceRootRef })
    return started.session
  }

  /**
   * Keep session.synopsisPath aligned with the on-disk file for this chapter sequence.
   * Stale paths (e.g. after title rename) cause UI/path mismatch and ENOENT on unlink.
   */
  private async reconcileSessionSynopsisPath(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>,
  ) {
    const claimed = await this.findExistingSynopsisForSequence(workspaceRootRef, session.chapterSequence)
    const pathStillValid = claimed === undefined
      ? await this.synopsisFileExists(workspaceRootRef, session.synopsisPath)
      : false
    const nextPath = claimed?.path
      ?? (pathStillValid ? session.synopsisPath : undefined)
    if (nextPath === undefined) {
      // Recreate placeholder when the session points at a missing file and no claim exists.
      const existingVolumes = await this.dependencies.workspace.listVolumeFolderNames(workspaceRootRef)
      const preferredVolume = pickPreferredVolumeFolderName(existingVolumes) ?? DEFAULT_VOLUME_FOLDER_NAME
      const placeholderPath = deriveSynopsisMarkdownPath(session.chapterSequence, session.title, preferredVolume)
      const placeholder = assembleSynopsisPlaceholderDocument(session.chapterSequence, session.title)
      await this.dependencies.workspace.saveSynopsisMarkdown(workspaceRootRef, placeholderPath, placeholder)
      await this.dependencies.conversation.updateSession({
        sessionId: session.sessionId,
        synopsisPath: placeholderPath,
        updatedAtMs: this.dependencies.now(),
      })
      return (await this.dependencies.conversation.findSession(session.sessionId)) ?? session
    }
    if (nextPath === session.synopsisPath) return session
    await this.dependencies.conversation.updateSession({
      sessionId: session.sessionId,
      synopsisPath: nextPath,
      ...(claimed?.title === undefined ? {} : { title: claimed.title }),
      updatedAtMs: this.dependencies.now(),
    })
    return (await this.dependencies.conversation.findSession(session.sessionId)) ?? {
      ...session,
      synopsisPath: nextPath,
      ...(claimed?.title === undefined ? {} : { title: claimed.title }),
    }
  }

  private async resolveBootstrapInput(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>,
  ): Promise<SynopsisResolveTurnInputResult> {
    const outlinePath = siblingPlanningMarkdownPath(session.synopsisPath, "outline")
      ?? deriveOutlineMarkdownPath(
        session.chapterSequence,
        session.title,
        extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
      )
    const outlineMarkdown = await this.readSynopsisFile(workspaceRootRef, outlinePath)
    const synopsisMarkdown = await this.readSynopsisFile(workspaceRootRef, session.synopsisPath)

    if (outlineMarkdown.trim().length > 0) {
      const appendix = synopsisMarkdown.trim().length > 0
        ? `\n\n---\n\n## 剧情梗概（附录·冲突以细纲为准）\n\n${synopsisMarkdown.trim()}\n`
        : ""
      return {
        chapterSequence: session.chapterSequence,
        userInput: `${outlineMarkdown.trim()}${appendix}`,
        source: "outline_file",
        synopsisPath: session.synopsisPath,
      }
    }

    if (synopsisMarkdown.trim().length > 0) {
      return {
        chapterSequence: session.chapterSequence,
        userInput: synopsisMarkdown,
        source: "synopsis_file",
        synopsisPath: session.synopsisPath,
      }
    }

    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    if (messages.length > 0) {
      return {
        chapterSequence: session.chapterSequence,
        userInput: summarizeConversation(messages),
        source: "conversation",
      }
    }
    if (session.turnBootstrapInput !== undefined && session.turnBootstrapInput.trim().length > 0) {
      return {
        chapterSequence: session.chapterSequence,
        userInput: session.turnBootstrapInput,
        source: "turn_input",
      }
    }
    throw new SynopsisInvalidStateError("梗概/细纲文件与对话均为空，请先讨论剧情梗概后再开始推演")
  }

  private async runSynopsisDiscuss(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId: string
    userMessage: string
    heading: string
    chapterSequence: number
    synopsisMarkdown: string
    outlineMarkdown: string
    chapterBodyMarkdown?: string
    latestDraftMarkdown?: string
    focusKind?: DiscussFocusKind
    focusLocked?: boolean
    outlineDigest?: string
    userEditedSinceAgent: boolean
    userEditedOutlineSinceAgent: boolean
    currentWorkDisplayName?: string
    synopsisConfirmed?: boolean
    /** Injected by ChapterPanel 批量推演. */
    batchAutomation?: boolean
    /** Creation-desk「批量推进」toggle. */
    batchProceed?: boolean
    activeGoals: readonly DeductionGoal[]
    chapterProgress: readonly Readonly<{ goalId: string; chapterSequence: number; summary: string; status: "planned" | "achieved" | "partial" | "missed" | "superseded" }>[]
    hookScheduleAudit: HookScheduleAudit
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    presentation?: Readonly<{
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    }>
    discussTrigger?: "user" | "turn_handoff"
    allowWorkflowTools?: boolean
    agentMode?: import("@worldseed/contracts").DiscussAgentMode
    signal?: AbortSignal
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<Readonly<{
    content: string
    reasoningContent?: string
    chapterTitle?: string
    titleAlignTarget?: "body" | "planning"
    volumeFolderName?: string
    workDisplayName?: string
    synopsisBody?: string
    outlineBody?: string
    bodyEdits?: Readonly<{
      target: "outline"
      baseDigest?: string
      ops: readonly Readonly<{ oldText: string; newText: string }>[]
    }>
    chapterDraftProposal?: ChapterDraftProposal
    chapterDraftProposals?: readonly ChapterDraftProposalEntry[]
    volumeChapterPlans?: readonly VolumeChapterPlan[]
    appendedDraft?: NonNullable<SynopsisConversationSendResult["appendedDraft"]>
    focusChange?: Readonly<{
      chapterSequence: number
      focusKind?: DiscussFocusKind
    }>
    continueTurn?: boolean
    choices?: SynopsisConversationSendResult["messages"][number]["choices"]
    goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
    stagingDelta?: Readonly<{
      notes?: readonly StagingEntryPatch[]
      characters?: readonly StagingEntryPatch[]
      worldRules?: readonly StagingEntryPatch[]
      promoteHints?: readonly StagingEntryPatch[]
    }>
    stagingPromote?: Readonly<{
      settingsWrites: readonly Readonly<{
        entryId: string
        relativePath: string
        markdown: string
        readmeEntry?: string
        mode: "create" | "update"
      }>[]
      goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
      reason?: string
    }>
    presentationWrites?: readonly Readonly<{
      relativePath: string
      markdown: string
      mode: "create" | "update"
    }>[]
    arcPlanMarkdown?: string
    budgetAdvisory?: SynopsisConversationBudgetAdvisory
    }>> {
    const basePhasePrompt = await this.dependencies.prompts.loadPhase("synopsis_discuss")
    const intentAppendix = chapterNarrativeIntentPhaseAppendix(input.chapterIntent, "synopsis_discuss")
    const presentationAppendix = chapterPresentationPhaseAppendix(input.presentation, "synopsis_discuss")
    const { discussAgentModePromptAppendix } = await import("./discuss-agent-mode.js")
    const modeAppendix = discussAgentModePromptAppendix(input.agentMode ?? "auto", {
      batchProceed: input.batchProceed === true || input.batchAutomation === true,
    })
    const appendix = [intentAppendix, presentationAppendix, modeAppendix].filter((part): part is string => part !== undefined)
    const phasePrompt = appendix.length === 0
      ? basePhasePrompt
      : {
          ...basePhasePrompt,
          text: `${basePhasePrompt.text}\n\n${appendix.join("\n\n")}`,
          digest: digest(`${basePhasePrompt.text}\n\n${appendix.join("\n\n")}`),
        }
    const systemRules = await this.dependencies.prompts.loadSynopsisDiscussSystemRules()
    const defaultSkillPack = await this.dependencies.prompts.loadDefaultSkillPack("synopsis_discuss")
    const turnMonitor = this.dependencies.readTurnMonitor === undefined
      ? undefined
      : await this.dependencies.readTurnMonitor()
    const discussTrigger = input.discussTrigger ?? "user"
    const settings = this.dependencies.readProjectSettings === undefined
      ? undefined
      : await this.dependencies.readProjectSettings()
    const nowMs = this.dependencies.now()
    const configuredWallMinutes = settings?.creationDesk.discussMaxWallTimeMinutes ?? 0
    const wallLimitMs = input.deadlineMs
      ?? (configuredWallMinutes > 0 ? configuredWallMinutes * 60_000 : undefined)
    // Budget schemas require a finite integer, so "unlimited" is a far-future timestamp.
    const deadlineAtMs = wallLimitMs === undefined ? Number.MAX_SAFE_INTEGER : nowMs + wallLimitMs
    const maxRetrievalRounds = settings?.execution.maxRetrievalRounds
      ?? defaultProjectSettings.execution.maxRetrievalRounds
    const maxModelCalls = Math.max(
      input.maxModelCalls ?? (maxRetrievalRounds + 3),
      maxRetrievalRounds + 3,
    )
    const catalog = await this.dependencies.catalog.createSnapshot({
      snapshotId: this.dependencies.createId(),
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      generatedAtMs: nowMs,
    })
    const titleAlignmentIssue = await this.dependencies.chapterSynopsis.detectTitleAlignmentIssue({
      workspaceRootRef: input.workspaceRootRef,
      chapterSequence: input.chapterSequence,
    })
    const storedDigests = await this.dependencies.conversation.readDiscussContextDigests(input.sessionId)
    const bootstrapDigest = computeDiscussBootstrapDigest({
      catalog,
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    })
    let storedContext = await this.dependencies.conversation.listDiscussContextMessages(input.sessionId)
    if (storedContext.length === 0) {
      await this.dependencies.conversation.appendDiscussContextMessages({
        sessionId: input.sessionId,
        projectId: input.projectId,
        createdAtMs: nowMs,
        messages: [
          {
            role: "system",
            kind: "system_rules",
            content: systemRules.text,
          },
          {
            role: "system",
            kind: "phase_instruction",
            content: defaultSkillPack.text,
          },
        ],
      })
      storedContext = [...await this.dependencies.conversation.listDiscussContextMessages(input.sessionId)]
    } else {
      const duplicateStaticIds = findExactDuplicateStaticMessageIds(storedContext)
      if (duplicateStaticIds.length > 0) {
        await this.dependencies.conversation.hideDiscussContextMessages(
          input.sessionId,
          duplicateStaticIds,
          nowMs,
        )
        storedContext = storedContext.filter((message) => !duplicateStaticIds.includes(message.messageId))
        runtimeLog("info", "synopsis-conversation", "context.static_duplicates_hidden", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          hiddenCount: duplicateStaticIds.length,
        })
      }
      // Reused sessions (pre-skill era) may lack the default pack — inject once.
      const hasSkillPack = storedContext.some((message) => {
        const content = message.content ?? ""
        return content.includes("【skill-pack:") || content.includes("synopsis-skills-v1")
      })
      if (!hasSkillPack) {
        await this.dependencies.conversation.appendDiscussContextMessages({
          sessionId: input.sessionId,
          projectId: input.projectId,
          createdAtMs: nowMs,
          messages: [{
            role: "system",
            kind: "phase_instruction",
            content: defaultSkillPack.text,
          }],
        })
        storedContext = [...await this.dependencies.conversation.listDiscussContextMessages(input.sessionId)]
        runtimeLog("info", "synopsis-conversation", "context.default_skill_pack_appended", {
          projectId: input.projectId,
          sessionId: input.sessionId,
        })
      }
    }
    const skipBootstrap = storedDigests.bootstrap === bootstrapDigest
    let readEvidence: TurnReadEvidence[] = skipBootstrap
      ? []
      : [...await this.bootstrapSynopsisEvidence({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        catalog,
        ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
      })]
    const sendTurnId = this.dependencies.createId()
    let lastRequestInputTokens = await this.dependencies.conversation.loadDiscussContextInputTokens(input.projectId, input.sessionId)
    const contextId = this.dependencies.createId()
    let retrievalGaps: TurnRetrievalGap[] = []
    let remainingCalls = maxModelCalls
    let budgetGraceUsed = false
    let accumulatedReasoning = ""
    let attempt = 0
    let missingArtifactRetries = 0
    let goalScheduleRepairs = 0
    const repairHints: string[] = []
    if (input.batchAutomation === true) {
      repairHints.push(
        "【批量推演模式】卷规划用 volumeChapterPlans 一次写齐多章 synopsisBody+outlineBody；正文默认用 chapterDraftProposals（或焦点章 chapterDraftProposal）写草稿，禁止优先 chapter_workflow；勿 publish_draft（图治理由前端按章串行）；少给需点击的 choices；禁止输出 set_focus / focusChange（焦点由前端推进）；不要停在等待用户确认梗概。",
      )
    } else if (input.synopsisConfirmed !== true) {
      repairHints.push(
        "当前梗概尚未经用户确认：禁止输出 outlineBody；戏核收窄后须同屏给出「用这份梗概写细纲」(confirm_synopsis)、「再改梗概」、可选「跳过细纲，按梗概开推」(start_turn)。",
      )
    } else if (isConfirmSynopsisUserMessage(input.userMessage)) {
      repairHints.push(
        "用户已选择用这份梗概写细纲：本轮应输出合格 outlineBody（引导 §4.1：必填章定位/分场/信息边界/风险待决；不适用节写「本节：无」；须含相对梗概的增量，禁止同构扩写），不要只改梗概；本轮不要再给 start_turn。",
      )
    }
    if (titleAlignmentIssue !== undefined) {
      repairHints.push(
        (input.agentMode ?? "auto") === "auto"
          ? `检测到标题分叉：正文「${titleAlignmentIssue.bodyHeading}」≠ 规划「${titleAlignmentIssue.planningHeading}」。Auto 模式：直接输出 titleAlignTarget=${titleAlignmentIssue.recommendedTarget} 完成对齐，不要用 choices 征询。`
          : `检测到标题分叉：正文「${titleAlignmentIssue.bodyHeading}」≠ 规划「${titleAlignmentIssue.planningHeading}」。优先用 choices 征询，用户确认后输出 titleAlignTarget（推荐 ${titleAlignmentIssue.recommendedTarget}）。`,
      )
    }
    const carriedTodos = synopsisConversationStreamHub.carriedTodos(input.projectId)
    const carriedTodoNotice = carriedTodos.length === 0
      ? undefined
      : [
          "【上轮未完成 Todo 已带入本轮】",
          ...carriedTodos.map((item) => `- [${item.status}] ${item.content}`),
          "处理完本条用户消息（如岔路选择）后，继续推进这些项；用 todo_write merge=true 更新状态。",
          "要放弃某项须显式标 cancelled，不能用新列表把它覆盖丢掉。仍有未完成项而本轮做不完时设 continueTurn=true。",
        ].join("\n")
    let latestBudgetAdvisory: SynopsisConversationBudgetAdvisory | undefined
    let latestToolDraft: SynopsisWorkflowToolResult | undefined
    let focusedDraftMarkdown = input.latestDraftMarkdown
    const projectSettingsForTools = this.dependencies.readProjectSettings === undefined
      ? undefined
      : await this.dependencies.readProjectSettings()
    const chapterWorkflowEnabled = projectSettingsForTools?.creationDesk.chapterWorkflowEnabled === true
    const toolCallbacks: SynopsisWorkflowToolCallbacks = input.allowWorkflowTools !== true
      ? {}
      : {
          ...(chapterWorkflowEnabled && this.dependencies.executeWorkflowTool !== undefined
            ? { executeWorkflowTool: this.dependencies.executeWorkflowTool }
            : {}),
          ...(this.dependencies.publishDraft === undefined
            ? {}
            : { publishDraft: this.dependencies.publishDraft }),
          ...(this.dependencies.restageChapter === undefined
            ? {}
            : { restageChapter: this.dependencies.restageChapter }),
          ...(this.dependencies.runBash === undefined
            ? {}
            : { runBash: this.dependencies.runBash }),
          ...(this.dependencies.writeTodos === undefined
            ? {}
            : { writeTodos: this.dependencies.writeTodos }),
          ...(this.dependencies.writeMemory === undefined
            ? {}
            : { writeMemory: this.dependencies.writeMemory }),
          loadSkill: async (skillInput) => {
            const loaded = await this.dependencies.prompts.loadSkill(skillInput.skillId, {
              includeReferences: skillInput.includeReferences === true,
            })
            const listed = await this.dependencies.prompts.listSkills()
            const meta = listed.find((item) => item.id === loaded.skillId)
            return {
              skillId: loaded.skillId,
              name: meta?.name ?? loaded.skillId,
              includeReferences: loaded.includeReferences,
              text: loaded.text,
              digest: loaded.digest,
            }
          },
        }

    for (;;) {
      input.signal?.throwIfAborted()
      if (isSynopsisSendCancelled(input.projectId)) throw new SynopsisSendCancelledError()
      if (this.dependencies.now() >= deadlineAtMs) {
        throw new SynopsisInvalidStateError(
          "梗概讨论超时：检索与模型调用未在截止前完成（可在 项目设置 › 执行 › 讨论最长运行时间 调整，0 为无上限）",
        )
      }
      if (attempt > maxModelCalls + maxRetrievalRounds + 8) {
        runtimeLog("warn", "synopsis-conversation", "discuss.safety_stop", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          attempt,
        })
        return finalizeDiscussReturn(
          input.projectId,
          latestBudgetAdvisory,
          buildSynopsisDiscussFallbackReturn({
            projectId: input.projectId,
            accumulatedReasoning,
            streamedContent: synopsisConversationStreamHub.peek(input.projectId).content,
          }),
        )
      }
      if (remainingCalls <= 0) {
        budgetGraceUsed = true
        remainingCalls = 1
        repairHints.push(
          "模型调用轮次较多：请 outcome=continue 直接给出完整 artifact，避免继续 request_read。",
        )
      } else if (remainingCalls === 1) {
        repairHints.push("这是最后一轮模型调用：必须 outcome=continue，禁止 request_read。")
      }
      const request = phaseRequestEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        envelopeId: this.dependencies.createId(),
        projectId: input.projectId,
        taskId: input.sessionId,
        turnId: sendTurnId,
        contextId,
        scopeId: input.sessionId,
        phase: "synopsis_discuss",
        protocolVersion: PROTOCOL_VERSION,
        promptRef: phasePrompt.ref,
        promptDigest: phasePrompt.digest,
        contextViewRef: `synopsis-discuss:${input.sessionId}:${String(attempt)}`,
        committedReadIds: readEvidence.map((item) => item.readId),
        visiblePendingIds: [],
        remainingBudget: createAssistBudget(remainingCalls, deadlineAtMs),
        input: {
          workflow: "synopsis",
          userInput: input.userMessage,
          chapterSequence: input.chapterSequence,
          allowWorkspaceChapterReads: true,
          sourceUnitIds: [],
          phaseRunIds: [],
          readEvidence,
          retrievalGaps,
          workspaceCatalog: catalog,
          ...(settings === undefined ? {} : { projectSettings: settings }),
          ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
          ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
          artifacts: {},
          synopsisDiscuss: {
            heading: input.heading,
            chapterSequence: input.chapterSequence,
            synopsisMarkdown: input.synopsisMarkdown,
            outlineMarkdown: input.outlineMarkdown,
            ...(input.chapterBodyMarkdown === undefined ? {} : { chapterBodyMarkdown: input.chapterBodyMarkdown }),
            ...(focusedDraftMarkdown === undefined ? {} : { latestDraftMarkdown: focusedDraftMarkdown }),
            ...(input.focusKind === undefined ? {} : { focusKind: input.focusKind }),
            ...(input.focusLocked === true ? { focusLocked: true } : {}),
            ...(input.outlineDigest === undefined ? {} : { outlineDigest: input.outlineDigest }),
            userEditedSinceAgent: input.userEditedSinceAgent,
            userEditedOutlineSinceAgent: input.userEditedOutlineSinceAgent,
            synopsisConfirmed: input.synopsisConfirmed === true,
            ...(input.batchAutomation === true ? { batchAutomation: true } : {}),
            ...(input.currentWorkDisplayName === undefined
              ? {}
              : { currentWorkDisplayName: input.currentWorkDisplayName }),
            activeGoals: input.activeGoals.map((goal) => ({
              goalId: goal.goalId,
              content: goal.content,
              lifecycle: goal.lifecycle,
              narrativeKind: goal.narrativeKind,
              scale: goal.scale,
              ...(goal.plantChapterSequence === undefined
                ? {}
                : { plantChapterSequence: goal.plantChapterSequence }),
              ...(goal.payoffChapterSequence === undefined
                ? {}
                : { payoffChapterSequence: goal.payoffChapterSequence }),
            })),
            chapterProgress: input.chapterProgress.map((item) => ({
              goalId: item.goalId,
              chapterSequence: item.chapterSequence,
              summary: item.summary,
              status: item.status,
            })),
            hookScheduleAudit: input.hookScheduleAudit,
            discussTrigger,
            ...(titleAlignmentIssue === undefined ? {} : { titleAlignmentIssue }),
            ...(turnMonitor === undefined ? {} : { turnMonitor }),
          },
        },
      })
      storedContext = [...await this.dependencies.conversation.listDiscussContextMessages(input.sessionId)]
      const contextMessages = [
        ...toVisibleDiscussContextMessages(storedContext),
        {
          messageId: this.dependencies.createId(),
          sequence: storedContext.length,
          role: "system" as const,
          kind: "phase_instruction" as const,
          content: synopsisToolCatalog(toolCallbacks),
        },
        ...(carriedTodoNotice === undefined
          ? []
          : [{
              messageId: this.dependencies.createId(),
              sequence: storedContext.length,
              role: "system" as const,
              kind: "system_rules" as const,
              content: carriedTodoNotice,
            }]),
        ...(attempt > 0 || readEvidence.length > 0
          ? [{
              messageId: this.dependencies.createId(),
              sequence: storedContext.length,
              role: "system" as const,
              kind: "system_rules" as const,
              content: [
                "创作台 ReAct 提醒：",
                `- 当前已可见 readEvidence ${String(readEvidence.length)} 条；优先基于这些证据给出正式结论。`,
                "- 若仍缺文件，使用 outcome=request_read；工具调用用 outcome=continue + artifact.toolRequest；否则返回最终 artifact。artifact 至少含 assistantMessage 与 finalSelfReview。",
                "- 禁止把「我先去读设定/索引」写进 assistantMessage 当作最终回复。",
                ...repairHints.slice(-2),
              ].join("\n"),
            }]
          : []),
      ]
      let streamedReasoning = ""
      let streamedContent = ""
      const thinkingRound = attempt + 1
      synopsisConversationStreamHub.beginThinkingRound(input.projectId, thinkingRound, this.dependencies.now())
      let execution
      try {
        execution = await executeWithContextCompaction({
          model: input.model,
          request,
          ...(lastRequestInputTokens === undefined ? {} : { lastRequestInputTokens }),
          triggerRatio: settings?.execution.contextCompactionThresholdRatio
            ?? defaultProjectSettings.execution.contextCompactionThresholdRatio,
          targetRatio: settings?.execution.contextCompressionTargetRatio
            ?? defaultProjectSettings.execution.contextCompressionTargetRatio,
          onCompacted: async (event) => {
            if (isSynopsisSendCancelled(input.projectId)) throw new SynopsisSendCancelledError()
            await this.dependencies.conversation.hideDiscussContextMessages(input.sessionId, event.hiddenMessageIds, this.dependencies.now())
            lastRequestInputTokens = undefined
            // Bootstrap files may have existed only in the removed history.
            const bootstrapEvidence = await this.bootstrapSynopsisEvidence({
              projectId: input.projectId, workspaceRootRef: input.workspaceRootRef, catalog,
              ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
            })
            readEvidence = [...bootstrapEvidence, ...readEvidence.filter((item) => !bootstrapEvidence.some((entry) => entry.ownerId === item.ownerId))]
            request.input = { ...request.input as object, readEvidence }
            request.committedReadIds = readEvidence.map((item) => item.readId)
            runtimeLog("info", "synopsis-conversation", "context.compaction.applied", { projectId: input.projectId, sessionId: input.sessionId, ...event })
          },
          options: {
            phasePrompt,
            forceThinking: true,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            contextChainId: input.sessionId,
            onSchemaRepair: () => {
              if (isSynopsisSendCancelled(input.projectId)) throw new SynopsisSendCancelledError()
              streamedContent = ""
              synopsisConversationStreamHub.beginSchemaRepair(input.projectId, this.dependencies.now())
            },
            onPartial: (partial) => {
              const stamp = this.dependencies.now()
              if (partial.reasoningDelta !== undefined) {
                streamedReasoning += partial.reasoningDelta
                if (streamedReasoning.trimStart().startsWith("{")) {
                  const display = normalizeThinkingDisplayText(streamedReasoning)
                    ?? normalizeThinkingDisplayText(streamedContent)
                  if (display !== undefined) {
                    synopsisConversationStreamHub.setThinking(input.projectId, display, stamp)
                  }
                } else {
                  synopsisConversationStreamHub.appendThinking(input.projectId, partial.reasoningDelta, stamp)
                }
              }
              if (partial.contentDelta !== undefined) {
                streamedContent += partial.contentDelta
                synopsisConversationStreamHub.appendContent(input.projectId, partial.contentDelta, stamp)
                if (streamedReasoning.length === 0 || streamedReasoning.trimStart().startsWith("{")) {
                  const display = normalizeThinkingDisplayText(streamedReasoning)
                    ?? normalizeThinkingDisplayText(streamedContent)
                  if (display !== undefined) {
                    synopsisConversationStreamHub.setThinking(input.projectId, display, stamp)
                  }
                }
              }
            },
            contextMessages,
          },
        })
      } catch (error) {
        if (isMissingSynopsisArtifactError(error) && missingArtifactRetries < 2 && remainingCalls > 1) {
          missingArtifactRetries += 1
          remainingCalls -= 1
          repairHints.push(
            "上一轮模型结果无效：outcome=continue 时缺少 artifact 对象。请立即返回完整 JSON，artifact 内必须有 assistantMessage 与 finalSelfReview。",
          )
          runtimeLog("warn", "synopsis-conversation", "missing_artifact.retry", {
            projectId: input.projectId,
            sessionId: input.sessionId,
            attempt,
            missingArtifactRetries,
          })
          attempt += 1
          continue
        }
        if (isMissingSynopsisArtifactError(error)) {
          throw new SynopsisInvalidStateError(
            "模型未返回完整讨论结果（缺少 artifact）。请重试发送；若反复失败，可先简化指令或检查模型是否支持 JSON 模式。",
          )
        }
        // Gate-style recovery: never dump toolRequest exclusivity to the chat UI.
        if (isRecoverableDiscussPhaseContractError(error) && remainingCalls > 1) {
          missingArtifactRetries += 1
          remainingCalls -= 1
          this.applyToolExclusiveTodoGate(input.projectId, input.sessionId, [
            "choices", "focusChange", "synopsisBody", "outlineBody", "chapterDraftProposal",
          ])
          repairHints.push(discussPhaseContractRepairHint(error))
          runtimeLog("warn", "synopsis-conversation", "phase_contract.gate_retry", {
            projectId: input.projectId,
            sessionId: input.sessionId,
            attempt,
            missingArtifactRetries,
            error: error instanceof Error ? error.message : String(error),
          })
          attempt += 1
          continue
        }
        if (isRecoverableDiscussPhaseContractError(error)) {
          this.applyToolExclusiveTodoGate(input.projectId, input.sessionId, [
            "choices", "focusChange", "synopsisBody", "outlineBody", "chapterDraftProposal",
          ])
          runtimeLog("warn", "synopsis-conversation", "phase_contract.soft_stop", {
            projectId: input.projectId,
            sessionId: input.sessionId,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          })
          const softContent = [
            "本轮工具与写入挤在同一份结果里，系统已按门禁拦住，没有落盘错误弹窗。",
            "将自动继续：先单独调工具，工具结果回来后再写章节/换焦点。",
          ].join("")
          synopsisConversationStreamHub.setContent(input.projectId, softContent, this.dependencies.now())
          synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
            content: softContent,
          })
          return finalizeDiscussReturn(input.projectId, latestBudgetAdvisory, { content: softContent })
        }
        throw error
      }
      lastRequestInputTokens = execution.usage.lastRequestInputTokens
      if (execution.contextExchange !== undefined) {
        const duplicateStaticIds = findExactDuplicateStaticMessageIds(storedContext)
        if (duplicateStaticIds.length > 0) {
          await this.dependencies.conversation.hideDiscussContextMessages(
            input.sessionId,
            duplicateStaticIds,
            this.dependencies.now(),
          )
          storedContext = storedContext.filter((message) => !duplicateStaticIds.includes(message.messageId))
        }
        const exchangeMessages = filterNovelContextExchangeMessages(storedContext, [
          ...execution.contextExchange.requestMessages,
          execution.contextExchange.responseMessage,
        ])
        if (exchangeMessages.length > 0) {
          await this.dependencies.conversation.appendDiscussContextMessages({
            sessionId: input.sessionId,
            projectId: input.projectId,
            createdAtMs: this.dependencies.now(),
            messages: exchangeMessages,
          })
          storedContext = [...await this.dependencies.conversation.listDiscussContextMessages(input.sessionId)]
        }
        await this.dependencies.conversation.saveDiscussContextDigests({
          sessionId: input.sessionId,
          synopsisDigest: digest(input.synopsisMarkdown),
          outlineDigest: input.outlineDigest ?? null,
          bootstrapDigest,
          updatedAtMs: this.dependencies.now(),
        })
      }
      remainingCalls = Math.max(0, remainingCalls - Math.max(1, execution.usage.modelCalls ?? 1))
      synopsisConversationStreamHub.addUsage(input.projectId, {
        inputTokens: execution.usage.inputTokens,
        outputTokens: execution.usage.outputTokens,
        ...(execution.usage.cacheHitInputTokens === undefined
          ? {}
          : { cacheHitInputTokens: execution.usage.cacheHitInputTokens }),
        ...(execution.usage.cacheMissInputTokens === undefined
          ? {}
          : { cacheMissInputTokens: execution.usage.cacheMissInputTokens }),
        ...(execution.usage.lastRequestInputTokens === undefined
          ? {}
          : { lastRequestInputTokens: execution.usage.lastRequestInputTokens }),
      }, this.dependencies.now())
      latestBudgetAdvisory = recordSynopsisModelCall(input.projectId, maxModelCalls) ?? latestBudgetAdvisory
      const parsedResult = phaseResultEnvelopeSchema.parse(execution.result)
      const strippedByGate = consumeDiscussToolExclusiveStrip() ?? []
      if (strippedByGate.length > 0) {
        this.applyToolExclusiveTodoGate(input.projectId, input.sessionId, strippedByGate)
        repairHints.push(DISCUSS_TOOL_EXCLUSIVE_GATE_HINT)
        await this.dependencies.conversation.appendDiscussContextMessages({
          sessionId: input.sessionId,
          projectId: input.projectId,
          createdAtMs: this.dependencies.now(),
          messages: [{
            role: "system",
            kind: "phase_instruction",
            content: JSON.stringify({
              protocol: "discuss-gate-v1",
              gate: "toolRequest_exclusive",
              strippedKeys: strippedByGate,
              message: DISCUSS_TOOL_EXCLUSIVE_GATE_HINT,
            }),
          }],
        })
        runtimeLog("info", "synopsis-conversation", "tool_exclusive.gate_applied", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          strippedKeys: strippedByGate,
        })
      }
      const reasoningChunk = execution.usage.reasoningContent?.trim()
      const envelopeThinking = [parsedResult.reason, parsedResult.selfReview]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n\n")
      const displayThinking = normalizeThinkingDisplayText(reasoningChunk)
        ?? (envelopeThinking.length === 0 ? undefined : envelopeThinking)
        ?? normalizeThinkingDisplayText(streamedContent)
      if (displayThinking !== undefined && displayThinking.length > 0) {
        accumulatedReasoning = displayThinking
        synopsisConversationStreamHub.setThinking(input.projectId, accumulatedReasoning, this.dependencies.now())
      }
      const requestedReads = parsedResult.requestedReads
      const toolArtifact = synopsisDiscussArtifactSchema.safeParse(parsedResult.artifact)
      if (toolArtifact.success && toolArtifact.data.toolRequest !== undefined) {
        if (parsedResult.outcome !== "continue" || requestedReads.length > 0) {
          repairHints.push("toolRequest 必须单独使用 outcome=continue，不能与 request_read 同回。")
          attempt += 1
          continue
        }
        if (isSynopsisSendCancelled(input.projectId)) throw new SynopsisSendCancelledError()
        const toolRequest = toolArtifact.data.toolRequest
        if (
          !isDiscussTodoBootstrapTool(toolRequest.name)
          && !discussTurnHasTodos(synopsisConversationStreamHub.peek(input.projectId, input.sessionId).todos)
        ) {
          repairHints.push(DISCUSS_TODO_REQUIRED_HINT)
          attempt += 1
          continue
        }
        const cancellation = new AbortController()
        const remainingMs = wallLimitMs === undefined
          ? undefined
          : Math.max(1, deadlineAtMs - this.dependencies.now())
        const toolSignal = AbortSignal.any([
          cancellation.signal,
          ...(remainingMs === undefined ? [] : [AbortSignal.timeout(remainingMs)]),
          ...(input.signal === undefined ? [] : [input.signal]),
        ])
        const cancellationPoll = setInterval(() => {
          if (isSynopsisSendCancelled(input.projectId)) cancellation.abort(new SynopsisSendCancelledError())
        }, 100)
        cancellationPoll.unref()
        const toolRunId = this.dependencies.createId()
        const toolRound = attempt + 1
        synopsisConversationStreamHub.upsertToolRun(input.projectId, {
          runId: toolRunId,
          name: toolRequest.name,
          action: toolRequest.action,
          ...(toolRequest.arguments === undefined ? {} : { arguments: toolRequest.arguments }),
          status: "running",
          round: toolRound,
        }, this.dependencies.now())
        try {
          // Re-read after compaction: hidden descriptions no longer grant permission.
          const visibleMessages = toVisibleDiscussContextMessages(
            await this.dependencies.conversation.listDiscussContextMessages(input.sessionId),
          )
          const toolResult = await executeSynopsisTool({
            request: toolRequest,
            context: {
              projectId: input.projectId,
              workspaceRootRef: input.workspaceRootRef,
              sessionId: input.sessionId,
              chapterSequence: input.chapterSequence,
              model: input.model,
              maxModelCalls: Math.max(1, remainingCalls),
              ...(remainingMs === undefined ? {} : { deadlineMs: remainingMs }),
              signal: toolSignal,
              ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
              ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
            },
            callbacks: toolCallbacks,
            visibleMessages,
            listDrafts: async () => {
              const revisions = this.dependencies.revisions
              if (revisions === undefined) return []
              const draft = await revisions.getDraftWorkspace({ projectId: input.projectId, chapterSequence: input.chapterSequence })
              if (draft === undefined) return []
              const listed = await revisions.listDraftVersions(draft.revisionTaskId)
              return listed.versions.map((version) => ({
                revisionTaskId: version.revisionTaskId,
                draftVersionId: version.versionId,
                draftLabel: version.label,
                heading: version.heading,
              }))
            },
          })
          const toolFailed = toolResult.status === "error"
          synopsisConversationStreamHub.upsertToolRun(input.projectId, {
            runId: toolRunId,
            name: toolRequest.name,
            action: toolRequest.action,
            ...(toolRequest.arguments === undefined ? {} : { arguments: toolRequest.arguments }),
            status: toolFailed ? "failed" : "completed",
            resultSummary: summarizeSynopsisToolRunResult(toolResult),
            round: toolRound,
          }, this.dependencies.now())
          if (toolResult.status === "draft_created") {
            latestToolDraft = toolResult.result as SynopsisWorkflowToolResult
            focusedDraftMarkdown = assembleChapterDocument(latestToolDraft.heading, latestToolDraft.body)
          }
          if (!toolFailed && !isDiscussTodoBootstrapTool(toolRequest.name)) {
            const settledTodos = settleToolGateTodos(
              synopsisConversationStreamHub.peek(input.projectId, input.sessionId).todos,
            )
            if (settledTodos !== undefined) {
              synopsisConversationStreamHub.setTodos(input.projectId, settledTodos, this.dependencies.now(), { merge: false })
            }
          }
          const toolErrorMessage = typeof toolResult.message === "string" ? toolResult.message : ""
          if (toolFailed && isPrecedingChapterPublishGateError(new Error(toolErrorMessage))) {
            const nextSequence = await this.dependencies.chapters.nextChapterSequence(input.projectId)
            this.applyChapterSequenceTodoGate(
              input.projectId,
              input.sessionId,
              nextSequence,
              [input.chapterSequence],
            )
            repairHints.push(discussChapterSequenceGateHint(nextSequence, [input.chapterSequence]))
          }
          await this.dependencies.conversation.appendDiscussContextMessages({
            sessionId: input.sessionId,
            projectId: input.projectId,
            createdAtMs: this.dependencies.now(),
            messages: [{ role: "system", kind: "phase_instruction", content: JSON.stringify(toolResult) }],
          })
          synopsisConversationStreamHub.setContent(input.projectId, "", this.dependencies.now())
        } catch (error) {
          synopsisConversationStreamHub.upsertToolRun(input.projectId, {
            runId: toolRunId,
            name: toolRequest.name,
            action: toolRequest.action,
            ...(toolRequest.arguments === undefined ? {} : { arguments: toolRequest.arguments }),
            status: "failed",
            resultSummary: error instanceof Error ? error.message : String(error),
            round: toolRound,
          }, this.dependencies.now())
          throw error
        } finally {
          clearInterval(cancellationPoll)
        }
        attempt += 1
        continue
      }
      if (parsedResult.outcome !== "request_read" || requestedReads.length === 0) {
        const artifact = synopsisDiscussArtifactSchema.safeParse(parsedResult.artifact)
        if (!artifact.success) {
          if (missingArtifactRetries < 2 && remainingCalls > 0) {
            missingArtifactRetries += 1
            const zodHint = artifact.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("；")
            repairHints.push(
              zodHint.includes("toolRequest")
                ? discussPhaseContractRepairHint(zodHint)
                : `上一轮缺少合法 artifact（${zodHint}）。请 outcome=continue 并返回完整 artifact（assistantMessage、finalSelfReview 必填）。`,
            )
            attempt += 1
            continue
          }
          throw new SynopsisInvalidStateError(
            "模型未返回完整讨论结果（缺少 artifact）。请重试发送。",
          )
        }
        const turnTodos = synopsisConversationStreamHub.peek(input.projectId, input.sessionId).todos
        if (discussArtifactRequiresTodos(artifact.data) && !discussTurnHasTodos(turnTodos)) {
          repairHints.push(DISCUSS_TODO_REQUIRED_HINT)
          attempt += 1
          continue
        }
        // Auto / Accept edits: do not end the turn with open todos (AI owns the list).
        // Plan mode may leave the checklist open as the deliverable plan.
        // continueTurn hands the open items to the auto-continued next turn.
        if (
          (input.agentMode ?? "auto") !== "plan"
          && artifact.data.continueTurn !== true
          && discussTurnHasTodos(turnTodos)
          && !discussTodosAreSettled(turnTodos)
        ) {
          repairHints.push(DISCUSS_TODO_INCOMPLETE_HINT)
          attempt += 1
          continue
        }
        // Process gate: hook schedule (起势章/兑现章) — let the model fill it in instead of failing on apply.
        if (artifact.data.goalProposals !== undefined && artifact.data.goalProposals.length > 0 && goalScheduleRepairs < 2) {
          const scheduleIssues = await this.dependencies.goals.auditProposalSchedules(
            input.projectId,
            artifact.data.goalProposals,
          )
          if (scheduleIssues.length > 0) {
            goalScheduleRepairs += 1
            runtimeLog("info", "synopsis-conversation", "goal_schedule.gate_retry", {
              projectId: input.projectId,
              sessionId: input.sessionId,
              issues: scheduleIssues.length,
            })
            repairHints.push([
              "【门禁·钩子时限】goalProposals 中以下伏笔/高潮缺起势章或兑现章（设置要求完整）：",
              ...scheduleIssues.map((issue) => `- ${issue}`),
              "请根据卷规划/细纲自行推断并补齐 plantChapterSequence 与 payoffChapterSequence（起势 ≤ 兑现），重新输出完整 artifact；",
              "确实无法确定的，改为 narrativeKind=general 或暂不提该条，不要询问用户。",
            ].join("\n"))
            attempt += 1
            continue
          }
        }
        // Process gate: cannot open draft N+k before chapter N is published — auto-defer / self-correct.
        const nextDraftSequence = await this.dependencies.chapters.nextChapterSequence(input.projectId)
        const indexedSequences = new Set(
          (await this.dependencies.chapterIndex.list(input.projectId)).map((chapter) => chapter.sequence),
        )
        const rawDraftProposals = artifact.data.chapterDraftProposals
        const focusDraftRequested = artifact.data.chapterDraftProposal !== undefined
        const draftSequences = [
          ...(rawDraftProposals?.map((proposal) => proposal.chapterSequence) ?? []),
          ...(focusDraftRequested ? [input.chapterSequence] : []),
        ]
        const { deferred: deferredDraftSequences } = partitionChapterDraftSequences(
          draftSequences,
          nextDraftSequence,
          indexedSequences,
        )
        const allowedDraftProposals = rawDraftProposals?.filter((proposal) => (
          indexedSequences.has(proposal.chapterSequence) || proposal.chapterSequence <= nextDraftSequence
        ))
        const focusDraftAllowed = !focusDraftRequested
          || indexedSequences.has(input.chapterSequence)
          || input.chapterSequence <= nextDraftSequence
        if (deferredDraftSequences.length > 0) {
          this.applyChapterSequenceTodoGate(
            input.projectId,
            input.sessionId,
            nextDraftSequence,
            deferredDraftSequences,
          )
          const gateHint = discussChapterSequenceGateHint(nextDraftSequence, deferredDraftSequences)
          await this.dependencies.conversation.appendDiscussContextMessages({
            sessionId: input.sessionId,
            projectId: input.projectId,
            createdAtMs: this.dependencies.now(),
            messages: [{
              role: "system",
              kind: "phase_instruction",
              content: JSON.stringify({
                protocol: "discuss-gate-v1",
                gate: "chapter_sequence_publish",
                nextSequence: nextDraftSequence,
                deferredSequences: deferredDraftSequences,
                message: gateHint,
              }),
            }],
          })
          const hasOtherWrites = artifact.data.synopsisBody !== undefined
            || artifact.data.outlineBody !== undefined
            || artifact.data.bodyEdits !== undefined
            || artifact.data.volumeChapterPlans !== undefined
            || artifact.data.stagingDelta !== undefined
            || artifact.data.stagingPromote !== undefined
            || artifact.data.presentationWrites !== undefined
            || artifact.data.arcPlan !== undefined
            || artifact.data.goalProposals !== undefined
          const hadDraftIntent = focusDraftRequested
            || (rawDraftProposals !== undefined && rawDraftProposals.length > 0)
          const allowedAnyDraft = (focusDraftRequested && focusDraftAllowed)
            || (allowedDraftProposals !== undefined && allowedDraftProposals.length > 0)
            || latestToolDraft !== undefined
          if (hadDraftIntent && !allowedAnyDraft && !hasOtherWrites && remainingCalls > 1) {
            repairHints.push(gateHint)
            runtimeLog("warn", "synopsis-conversation", "chapter_sequence.gate_retry", {
              projectId: input.projectId,
              sessionId: input.sessionId,
              nextSequence: nextDraftSequence,
              deferredSequences: deferredDraftSequences,
            })
            remainingCalls -= 1
            attempt += 1
            continue
          }
        }
        synopsisConversationStreamHub.setContent(input.projectId, artifact.data.assistantMessage, this.dependencies.now())
        synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
          ...(accumulatedReasoning.length === 0 ? {} : { thinking: accumulatedReasoning }),
          content: artifact.data.assistantMessage,
        })
        return finalizeDiscussReturn(input.projectId, latestBudgetAdvisory, {
          content: artifact.data.assistantMessage,
          ...(accumulatedReasoning.length === 0 ? {} : { reasoningContent: accumulatedReasoning }),
          ...(artifact.data.chapterTitle === undefined ? {} : { chapterTitle: artifact.data.chapterTitle }),
          ...(artifact.data.titleAlignTarget === undefined
            ? {}
            : { titleAlignTarget: artifact.data.titleAlignTarget }),
          ...(artifact.data.volumeFolderName === undefined
            ? {}
            : { volumeFolderName: artifact.data.volumeFolderName }),
          ...(artifact.data.workDisplayName === undefined
            ? {}
            : { workDisplayName: artifact.data.workDisplayName }),
          ...(artifact.data.synopsisBody === undefined ? {} : { synopsisBody: artifact.data.synopsisBody }),
          ...(artifact.data.outlineBody === undefined ? {} : { outlineBody: artifact.data.outlineBody }),
          ...(artifact.data.bodyEdits === undefined
            ? {}
            : {
                bodyEdits: {
                  target: artifact.data.bodyEdits.target,
                  ...(artifact.data.bodyEdits.baseDigest === undefined
                    ? {}
                    : { baseDigest: artifact.data.bodyEdits.baseDigest }),
                  ops: artifact.data.bodyEdits.ops,
                },
              }),
          ...mapArtifactChapterDraftProposal(
            focusDraftAllowed ? artifact.data.chapterDraftProposal : undefined,
          ),
          ...mapArtifactChapterDraftProposals(allowedDraftProposals),
          ...mapArtifactVolumeChapterPlans(artifact.data.volumeChapterPlans),
          ...(latestToolDraft === undefined ? {} : { appendedDraft: {
            revisionTaskId: latestToolDraft.revisionTaskId,
            chapterId: latestToolDraft.chapterId,
            draftVersionId: latestToolDraft.draftVersionId,
            draftLabel: latestToolDraft.draftLabel,
          } }),
          ...mapArtifactFocusChange(artifact.data.focusChange),
          ...(artifact.data.continueTurn === true ? { continueTurn: true } : {}),
          ...(artifact.data.choices === undefined ? {} : { choices: artifact.data.choices }),
          ...(artifact.data.stagingDelta === undefined
            ? {}
            : { stagingDelta: mapSynopsisStagingDelta(artifact.data.stagingDelta) }),
          ...(artifact.data.stagingPromote === undefined
            ? {}
            : { stagingPromote: mapSynopsisStagingPromote(artifact.data.stagingPromote) }),
          ...(artifact.data.presentationWrites !== undefined
            ? { presentationWrites: mapSynopsisPresentationWrites(artifact.data.presentationWrites) }
            : {}),
          ...(artifact.data.arcPlan === undefined
            ? {}
            : { arcPlanMarkdown: artifact.data.arcPlan.markdown }),
          ...(artifact.data.goalProposals === undefined
            ? {}
            : {
                goalProposals: artifact.data.goalProposals.map((proposal) => ({
                  payload: proposal.payload,
                  ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
                })),
              }),
        })
      }

      if (attempt >= maxRetrievalRounds || budgetGraceUsed) {
        runtimeLog("warn", "synopsis-conversation", "retrieval.exhausted", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          attempt,
          requestedReadCount: requestedReads.length,
        })
        const artifact = synopsisDiscussArtifactSchema.safeParse(parsedResult.artifact)
        if (artifact.success) {
          synopsisConversationStreamHub.setContent(input.projectId, artifact.data.assistantMessage, this.dependencies.now())
          synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
            ...(accumulatedReasoning.length === 0 ? {} : { thinking: accumulatedReasoning }),
            content: artifact.data.assistantMessage,
          })
          return finalizeDiscussReturn(input.projectId, latestBudgetAdvisory, {
            content: artifact.data.assistantMessage,
            ...(accumulatedReasoning.length === 0 ? {} : { reasoningContent: accumulatedReasoning }),
            ...(artifact.data.chapterTitle === undefined ? {} : { chapterTitle: artifact.data.chapterTitle }),
            ...(artifact.data.titleAlignTarget === undefined
              ? {}
              : { titleAlignTarget: artifact.data.titleAlignTarget }),
            ...(artifact.data.volumeFolderName === undefined
              ? {}
              : { volumeFolderName: artifact.data.volumeFolderName }),
            ...(artifact.data.workDisplayName === undefined
              ? {}
              : { workDisplayName: artifact.data.workDisplayName }),
            ...(artifact.data.synopsisBody === undefined ? {} : { synopsisBody: artifact.data.synopsisBody }),
            ...(artifact.data.outlineBody === undefined ? {} : { outlineBody: artifact.data.outlineBody }),
            ...(artifact.data.bodyEdits === undefined
              ? {}
              : {
                  bodyEdits: {
                    target: artifact.data.bodyEdits.target,
                    ...(artifact.data.bodyEdits.baseDigest === undefined
                      ? {}
                      : { baseDigest: artifact.data.bodyEdits.baseDigest }),
                    ops: artifact.data.bodyEdits.ops,
                  },
                }),
            ...mapArtifactChapterDraftProposal(artifact.data.chapterDraftProposal),
            ...mapArtifactChapterDraftProposals(artifact.data.chapterDraftProposals),
            ...mapArtifactVolumeChapterPlans(artifact.data.volumeChapterPlans),
            ...mapArtifactFocusChange(artifact.data.focusChange),
            ...(artifact.data.continueTurn === true ? { continueTurn: true } : {}),
            ...(artifact.data.choices === undefined ? {} : { choices: artifact.data.choices }),
            ...(artifact.data.stagingDelta === undefined
              ? {}
              : { stagingDelta: mapSynopsisStagingDelta(artifact.data.stagingDelta) }),
            ...(artifact.data.stagingPromote === undefined
              ? {}
              : { stagingPromote: mapSynopsisStagingPromote(artifact.data.stagingPromote) }),
            ...(artifact.data.presentationWrites === undefined
              ? {}
              : { presentationWrites: mapSynopsisPresentationWrites(artifact.data.presentationWrites) }),
            ...(artifact.data.arcPlan === undefined
              ? {}
              : { arcPlanMarkdown: artifact.data.arcPlan.markdown }),
            ...(artifact.data.goalProposals === undefined
              ? {}
              : {
                  goalProposals: artifact.data.goalProposals.map((proposal) => ({
                    payload: proposal.payload,
                    ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
                  })),
                }),
          })
        }
        const fallback = finalizeDiscussReturn(
          input.projectId,
          latestBudgetAdvisory,
          buildSynopsisDiscussFallbackReturn({
            projectId: input.projectId,
            accumulatedReasoning,
            streamedContent: synopsisConversationStreamHub.peek(input.projectId).content,
          }),
        )
        synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
          ...(fallback.reasoningContent === undefined ? {} : { thinking: fallback.reasoningContent }),
          content: fallback.content,
        })
        return fallback
      }

      if (!discussTurnHasTodos(synopsisConversationStreamHub.peek(input.projectId, input.sessionId).todos)) {
        repairHints.push(DISCUSS_TODO_REQUIRED_HINT)
        attempt += 1
        continue
      }

      const searchRound = attempt + 1
      for (const read of requestedReads) {
        const label = synopsisSearchLabel(read)
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: label,
          status: "running",
          round: searchRound,
          ...temporalSearchMeta(read),
        }, this.dependencies.now())
      }

      const webReads = requestedReads.filter((read) => read.query.sourceKinds.includes("web"))
      let webEvidence: TurnReadEvidence[] = []
      if (webReads.length > 0 && this.dependencies.webResearch !== undefined) {
        webEvidence = [...await executeSynopsisWebReads({
          requests: webReads,
          existingEvidence: readEvidence,
          createId: this.dependencies.createId,
          webResearch: this.dependencies.webResearch,
          ...(settings === undefined ? {} : { settings }),
        })]
      } else if (webReads.length > 0) {
        for (const read of webReads) {
          const query = [...read.query.exactKeys, ...read.query.semanticTexts]
            .map((term) => term.trim())
            .find((term) => term.length > 0) ?? "web"
          synopsisConversationStreamHub.upsertSearch(input.projectId, {
            query: `web: ${query}`,
            status: "failed",
            resultSummary: "联网检索端口未配置",
            round: searchRound,
          }, this.dependencies.now())
        }
      }

      const temporalReads = requestedReads
        .filter((read) => isTemporalReadRequest(read))
        .slice(0, MAX_TEMPORAL_READS_PER_ROUND)
      const workspaceReads = requestedReads.filter((read) => (
        !isTemporalReadRequest(read) && !read.query.sourceKinds.includes("web")
      ))

      const temporalEvidence = await executeSynopsisTemporalReads({
        projectId: input.projectId,
        sessionChapterSequence: input.chapterSequence,
        catalog,
        requests: temporalReads,
        existingEvidence: readEvidence,
        settingsLineage: this.dependencies.settingsLineage,
        chapterIndex: this.dependencies.chapterIndex,
        documents: this.dependencies.documents,
        internalStore: this.dependencies.internalStore,
        chapterTemporal: this.dependencies.chapterTemporal,
        createId: this.dependencies.createId,
        maxCandidates: settings?.retrieval.maxCandidates ?? defaultProjectSettings.retrieval.maxCandidates,
      })
      readEvidence = [...readEvidence, ...temporalEvidence, ...webEvidence]

      const workspaceEvidence = workspaceReads.length === 0
        ? []
        : await executeSynopsisWorkspaceReads({
          workspace: this.dependencies.workspace,
          workspaceRootRef: input.workspaceRootRef,
          catalog,
          requests: workspaceReads,
          existingEvidence: readEvidence,
          createId: this.dependencies.createId,
          maxCandidates: settings?.retrieval.maxCandidates ?? defaultProjectSettings.retrieval.maxCandidates,
          maxRequestsPerRound: settings?.retrieval.maxRequestsPerRound
            ?? defaultProjectSettings.retrieval.maxRequestsPerRound,
          allowWorkspaceChapterReads: true,
        })
      readEvidence = [...readEvidence, ...workspaceEvidence]
      const newEvidence = [...temporalEvidence, ...webEvidence, ...workspaceEvidence]

      for (const read of requestedReads) {
        const label = synopsisSearchLabel(read)
        const matched = newEvidence.filter((item) => evidenceMatchesRead(item, read))
        const isWeb = read.query.sourceKinds.includes("web")
        const summary = matched.length === 0
          ? (isWeb ? "联网检索无可用证据" : "未命中可读内容")
          : matched.map((item) => {
              if (item.ownerKind.startsWith("web:")) {
                const preview = item.semanticText.split("\n").slice(0, 4).join("\n")
                return `${item.ownerId}（${String(item.semanticText.length)} 字）\n${preview}`
              }
              const temporalNote = item.temporalRole === "as_of" && item.asOfChapterSequence !== undefined
                ? `第${String(item.asOfChapterSequence)}章视角 · `
                : ""
              return `${temporalNote}${item.ownerId}（${item.semanticText.length} 字）`
            }).join("\n")
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: label,
          status: matched.length === 0 && !isWeb ? "failed" : "completed",
          resultSummary: summary,
          round: searchRound,
          ...temporalSearchMeta(read),
        }, this.dependencies.now())
      }

      if (newEvidence.length === 0 && webReads.length === 0) {
        retrievalGaps = [
          ...retrievalGaps,
          ...requestedReads.map((read) => ({
            typeId: "system:retrieval-gap" as const,
            requestId: read.requestId,
            expectedEvidence: read.expectedEvidence,
            reason: read.reason,
            query: read.query,
          })),
        ]
        runtimeLog("debug", "synopsis-conversation", "retrieval.no_new_evidence", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          attempt,
          gapCount: requestedReads.length,
        })
      }

      runtimeLog("debug", "synopsis-conversation", "retrieval.round_completed", {
        projectId: input.projectId,
        sessionId: input.sessionId,
        attempt,
        newEvidenceCount: newEvidence.length,
        totalEvidenceCount: readEvidence.length,
      })
      attempt += 1
    }
  }

  private async bootstrapSynopsisEvidence(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    catalog: WorkspaceCatalogSnapshot
    presentation?: Readonly<{
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    }>
  }>): Promise<readonly TurnReadEvidence[]> {
    const bootstrapPaths = ["设定集/readme.md", "参考文件/readme.md", AGENT_MEMORY_INDEX_PATH]
    const descriptionPaths = resolveDescriptionRulePaths(
      input.presentation?.descriptionRulePath,
      input.catalog.entries,
    )
    const prosePath = input.presentation?.proseStyleRulePath?.trim()
    const presentationPaths = [
      ...descriptionPaths,
      ...(prosePath !== undefined && prosePath.length > 0 && isPresentationRuleMarkdownPath(prosePath)
        ? [prosePath]
        : []),
    ]
    const overlayPaths = listWorkDescriptionRuleFiles(input.catalog.entries).map((entry) => entry.relativePath)
    const userRulePaths = listUserRuleMarkdownPaths(input.catalog.entries)
    const bootstrapCap = bootstrapPaths.length
      + presentationPaths.length
      + overlayPaths.length
      + userRulePaths.length
    const bootstrapRequest = {
      requestId: this.dependencies.createId(),
      reason: "Bootstrap settings, reference indexes, agent memory, user rules, and selected presentation rules for synopsis discuss",
      expectedEvidence: "设定集/参考索引、Agent 记忆索引、用户规则与本轮描写笔风规则",
      query: {
        exactKeys: [...bootstrapPaths, ...presentationPaths, ...overlayPaths, ...userRulePaths],
        semanticTexts: [
          "设定集索引",
          "参考文件索引",
          "Agent记忆",
          ...presentationPaths,
          ...overlayPaths,
          ...userRulePaths,
        ],
        anchorIds: [] as string[],
        directions: ["both" as const],
        maxCandidates: bootstrapCap,
        maxDepth: 1,
        // Always include rule so Agent记忆（world_rules）is readable even when no user/presentation rules.
        sourceKinds: ["reference" as const, "rule" as const],
      },
    }
    const label = formatSynopsisSearchLabel(bootstrapRequest)
    synopsisConversationStreamHub.upsertSearch(input.projectId, {
      query: label,
      status: "running",
      round: 0,
    }, this.dependencies.now())
    try {
      const evidence = await executeSynopsisWorkspaceReads({
        workspace: this.dependencies.workspace,
        workspaceRootRef: input.workspaceRootRef,
        catalog: input.catalog,
        requests: [bootstrapRequest],
        existingEvidence: [],
        createId: this.dependencies.createId,
        maxCandidates: bootstrapCap,
        maxRequestsPerRound: 1,
        allowWorkspaceChapterReads: true,
      })
      const capped = evidence.map((item) => {
        if (item.ownerId !== AGENT_MEMORY_INDEX_PATH) return item
        const truncated = truncateAgentMemoryIndex(item.semanticText)
        if (!truncated.truncated) return item
        return {
          ...item,
          semanticText: truncated.text,
          digest: digest(truncated.text),
        }
      })
      synopsisConversationStreamHub.upsertSearch(input.projectId, {
        query: label,
        status: capped.length === 0 ? "failed" : "completed",
        round: 0,
        resultSummary: capped.length === 0
          ? "未找到设定集/参考索引"
          : capped.map((item) => `${item.ownerId}（${item.semanticText.length} 字）`).join("\n"),
      }, this.dependencies.now())
      return capped
    } catch (error) {
      synopsisConversationStreamHub.upsertSearch(input.projectId, {
        query: label,
        status: "failed",
        round: 0,
        resultSummary: error instanceof Error ? error.message : String(error),
      }, this.dependencies.now())
      return []
    }
  }

  private applyToolExclusiveTodoGate(
    projectId: ProjectId,
    sessionId: string,
    strippedKeys: readonly string[],
  ): void {
    if (strippedKeys.length === 0) return
    const current = synopsisConversationStreamHub.peek(projectId, sessionId).todos
    const aligned = alignTodosForToolExclusiveGate(current, strippedKeys)
    synopsisConversationStreamHub.setTodos(projectId, aligned, this.dependencies.now(), { merge: false })
  }

  /** Wait for pending publication so `targetSequence` becomes reachable; returns the next open sequence. */
  private async waitForChapterSequenceGate(
    projectId: ProjectId,
    targetSequence: number,
    timeoutMs = 240_000,
  ): Promise<number> {
    let nextSequence = await this.dependencies.chapters.nextChapterSequence(projectId)
    if (targetSequence <= nextSequence || this.dependencies.waitForPendingPublications === undefined) {
      return nextSequence
    }
    runtimeLog("info", "synopsis-conversation", "chapter_sequence.gate_wait", { projectId, targetSequence, nextSequence })
    await this.dependencies.waitForPendingPublications({ timeoutMs })
    nextSequence = await this.dependencies.chapters.nextChapterSequence(projectId)
    return nextSequence
  }

  private applyChapterSequenceTodoGate(
    projectId: ProjectId,
    sessionId: string,
    nextSequence: number,
    deferredSequences: readonly number[],
  ): void {
    if (deferredSequences.length === 0) return
    const current = synopsisConversationStreamHub.peek(projectId, sessionId).todos
    const aligned = alignTodosForChapterSequenceGate(current, nextSequence, deferredSequences)
    synopsisConversationStreamHub.setTodos(projectId, aligned, this.dependencies.now(), { merge: false })
  }

  private emitDiscussEdit(projectId: ProjectId, edit: SynopsisConversationStreamEdit): void {
    synopsisConversationStreamHub.upsertEdit(projectId, edit, this.dependencies.now())
  }

  private async applyPresentationWrites(input: Readonly<{
    workspaceRootRef: string
    writes: readonly Readonly<{
      relativePath: string
      markdown: string
      mode: "create" | "update"
    }>[]
  }>): Promise<void> {
    const inventory = (await this.dependencies.workspace.validate(input.workspaceRootRef)).inventory
    try {
      assertWorkDescriptionWriteBatch({
        existingPaths: inventory.filter((entry) => entry.kind === "file").map((entry) => entry.path),
        writes: input.writes,
      })
    } catch (error) {
      throw new SynopsisInvalidStateError(error instanceof Error ? error.message : String(error))
    }
    for (const write of input.writes) {
      const path = write.relativePath.trim().replace(/\\/gu, "/")
      assertWorkspaceMutationAllowed(path, "file", "user")
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        path,
        write.markdown,
      )
    }
  }

  private async applyStagingDelta(input: Readonly<{
    workspaceRootRef: string
    sourceMessageId: string
    delta: Readonly<{
      notes?: readonly StagingEntryPatch[]
      characters?: readonly StagingEntryPatch[]
      worldRules?: readonly StagingEntryPatch[]
      promoteHints?: readonly StagingEntryPatch[]
    }>
  }>): Promise<readonly string[]> {
    const settings = this.dependencies.readProjectSettings === undefined
      ? undefined
      : await this.dependencies.readProjectSettings()
    const maxChars = settings?.staging.maxChars ?? defaultProjectSettings.staging.maxChars
    const nowMs = this.dependencies.now()
    const fileSpecs: ReadonlyArray<{
      path: string
      patches: readonly StagingEntryPatch[] | undefined
    }> = [
      { path: STAGING_FILE_KEYS.notes, patches: input.delta.notes },
      { path: STAGING_FILE_KEYS.characters, patches: input.delta.characters },
      { path: STAGING_FILE_KEYS.world, patches: input.delta.worldRules },
      { path: STAGING_FILE_KEYS.promoteIndex, patches: input.delta.promoteHints },
    ]
    const mergedByPath: Record<string, StagingEntry[]> = {}
    for (const spec of fileSpecs) {
      const raw = await this.readSynopsisFile(input.workspaceRootRef, spec.path)
      const existing = parseStagingEntries(raw)
      const patches = (spec.patches ?? []).map((patch) => ({
        ...patch,
        ...(patch.status === undefined ? {} : { status: patch.status }),
      }))
      mergedByPath[spec.path] = mergeStagingPatches(
        existing,
        patches,
        nowMs,
        this.dependencies.createId,
      ).map((entry) => (
        entry.sourceMessageId === undefined
          ? { ...entry, sourceMessageId: input.sourceMessageId }
          : entry
      ))
    }
    const evicted = evictStagingEntries(
      mergedByPath,
      maxChars,
      (fileKey, entries) => serializeStagingEntries(stagingFileTitle(fileKey), entries),
    )
    if (evicted.removedTitles.length > 0) {
      const notesPath = STAGING_FILE_KEYS.notes
      const notes = evicted.files[notesPath] ?? []
      notes.push({
        entryId: this.dependencies.createId(),
        title: "系统清理记录",
        body: evicted.removedTitles.map((title) => `[系统] 已清理暂存条目 ${title}（超字数上限）`).join("\n"),
        status: "settled",
        updatedAtMs: nowMs,
        settledAtMs: nowMs,
      })
      evicted.files[notesPath] = notes
    }
    const writtenPaths: string[] = []
    for (const [relativePath, entries] of Object.entries(evicted.files)) {
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        relativePath,
        serializeStagingEntries(stagingFileTitle(relativePath), entries),
      )
      writtenPaths.push(relativePath)
    }
    return writtenPaths
  }

  private resolveFocusChapterSequence(input: Readonly<{
    chapterSequence?: number
    relativePath?: string
  }>): number {
    if (input.chapterSequence !== undefined) return input.chapterSequence
    const relativePath = input.relativePath?.replaceAll("\\", "/")
    if (relativePath === undefined || relativePath.length === 0) {
      throw new SynopsisInvalidStateError("setFocus requires chapterSequence or relativePath")
    }
    const synopsis = parseSynopsisMarkdownPath(relativePath)
    if (synopsis?.sequence !== undefined) return synopsis.sequence
    const outline = parseOutlineMarkdownPath(relativePath)
    if (outline?.sequence !== undefined) return outline.sequence
    const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.md$/u, "")
    const sequence = parseChapterSequenceFromLabel(filename)
    if (sequence !== undefined) return sequence
    throw new SynopsisInvalidStateError(`无法从路径解析章序号：${relativePath}`)
  }

  private resolveFocusKindFromPath(relativePath: string | undefined): DiscussFocusKind | undefined {
    if (relativePath === undefined || relativePath.length === 0) return undefined
    const normalized = relativePath.replaceAll("\\", "/")
    if (isSynopsisMarkdownPath(normalized)) return "plot_synopsis"
    if (isOutlineMarkdownPath(normalized)) return "plot_outline"
    if (isChapterBodyMarkdownPath(normalized)) return "chapter_body"
    return undefined
  }

  private async findExistingSynopsisForSequence(
    workspaceRootRef: string,
    chapterSequence: number,
  ): Promise<Readonly<{ path: string; title?: string }> | undefined> {
    const report = await this.dependencies.workspace.validate(workspaceRootRef)
    const matches = report.inventory
      .filter((entry) => entry.kind === "file")
      .map((entry) => {
        const validation = validateSynopsisMarkdownPath(entry.path)
        if (!validation.ok || validation.sequence !== chapterSequence) return undefined
        return {
          path: validation.path,
          ...(validation.title === undefined ? {} : { title: validation.title }),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
    return matches[0]
  }

  public async recordTurnHandoff(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    brief: TurnHandoffBrief
    model: AIModelPort
    runAutoAnalysis?: boolean
    chapterIntent?: ChapterNarrativeIntent
  }>): Promise<void> {
    const started = await this.start({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
    })
    const session = started.session
    const nowMs = this.dependencies.now()
    await this.dependencies.conversation.appendMessage({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "system",
      content: formatTurnHandoffSystemMessage(input.brief),
      createdAtMs: nowMs,
    })
    if (input.runAutoAnalysis === false) {
      await this.setFocus({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        chapterSequence: input.brief.chapterSequence + 1,
        focusKind: "plot_synopsis",
      })
      return
    }

    const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
    const outlinePathForHandoff = siblingPlanningMarkdownPath(session.synopsisPath, "outline")
      ?? deriveOutlineMarkdownPath(
        session.chapterSequence,
        session.title,
        extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
      )
    const outlineMarkdown = await this.readSynopsisFile(input.workspaceRootRef, outlinePathForHandoff)
    const outlineDigest = outlineMarkdown.trim().length === 0 ? undefined : digest(outlineMarkdown)
    const chapterBodyMarkdown = await this.readFocusedCommittedBody(
      input.projectId,
      input.workspaceRootRef,
      session.chapterSequence,
    )
    const userEditedOutlineSinceAgent = session.lastOutlineAgentDigest !== undefined
      && outlineDigest !== undefined
      && session.lastOutlineAgentDigest !== outlineDigest
    const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
    const activeGoals = selectGoalsForChapterContext(goalsSnapshot.goals, session.chapterSequence)
    const chapterProgress = goalsSnapshot.progress.filter(
      (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
    )
    const hookScheduleAudit = await this.dependencies.goals.auditHookSchedules(input.projectId)
    const assist = await this.runSynopsisDiscuss({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      sessionId: session.sessionId,
      userMessage: [
        "正式推演已完成，请根据系统交接消息分析正文落成情况。",
        "更新弧大纲/暂存区笔记，并建议下一章梗概修订；禁止开始正式推演。",
        "",
        formatTurnHandoffSystemMessage(input.brief),
      ].join("\n"),
      heading: session.title,
      chapterSequence: session.chapterSequence,
      synopsisMarkdown,
      outlineMarkdown,
      ...(chapterBodyMarkdown === undefined ? {} : { chapterBodyMarkdown }),
      ...(outlineDigest === undefined ? {} : { outlineDigest }),
      userEditedSinceAgent: false,
      userEditedOutlineSinceAgent,
      synopsisConfirmed: session.synopsisConfirmedAtMs !== undefined,
      activeGoals,
      chapterProgress,
      hookScheduleAudit,
      model: input.model,
      discussTrigger: "turn_handoff",
      ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
    })
    const assistantMessageId = this.dependencies.createId()
    if (assist.stagingDelta !== undefined) {
      await this.applyStagingDelta({
        workspaceRootRef: input.workspaceRootRef,
        delta: assist.stagingDelta,
        sourceMessageId: assistantMessageId,
      })
    }
    if (assist.arcPlanMarkdown !== undefined) {
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        ARC_PLAN_STAGING_PATH,
        assist.arcPlanMarkdown,
      )
      const handoffVolume = extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        volumeOutlinePlanPath(handoffVolume),
        assist.arcPlanMarkdown,
      )
    }
    if (assist.presentationWrites !== undefined && assist.presentationWrites.length > 0) {
      await this.applyPresentationWrites({
        workspaceRootRef: input.workspaceRootRef,
        writes: assist.presentationWrites,
      })
    }
    if (assist.synopsisBody !== undefined) {
      await this.dependencies.workspace.saveSynopsisMarkdown(
        input.workspaceRootRef,
        session.synopsisPath,
        assist.synopsisBody,
      )
      await this.dependencies.conversation.updateSession({
        sessionId: session.sessionId,
        lastAgentDigest: digest(assist.synopsisBody),
        updatedAtMs: this.dependencies.now(),
      })
    }
    await this.dependencies.conversation.appendMessage({
      messageId: assistantMessageId,
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "assistant",
      content: assist.content,
      ...(assist.reasoningContent === undefined ? {} : { reasoningContent: assist.reasoningContent }),
      ...(assist.choices === undefined ? {} : { choices: assist.choices }),
      createdAtMs: this.dependencies.now(),
    })
    await this.setFocus({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      chapterSequence: input.brief.chapterSequence + 1,
      focusKind: "plot_synopsis",
    })
  }

  private async applyVolumeFolderChange(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    synopsisPath: string
    fromFolderName: string
    toFolderName: string
  }>): Promise<Readonly<{
    synopsisPath: string
    volumeFolderName: string
    cleanupEmptyFolderName?: string
  }>> {
    const fromValidated = validateVolumeFolderName(input.fromFolderName)
    const toValidated = validateVolumeFolderName(input.toFolderName)
    if (!fromValidated.ok) throw new SynopsisInvalidStateError(fromValidated.reason)
    if (!toValidated.ok) throw new SynopsisInvalidStateError(toValidated.reason)
    if (fromValidated.folderName === toValidated.folderName) {
      return {
        synopsisPath: input.synopsisPath,
        volumeFolderName: toValidated.folderName,
      }
    }

    const existing = await this.dependencies.workspace.listVolumeFolderNames(input.workspaceRootRef)
    const uniqueness = assertUniqueVolumeSequence(toValidated.folderName, existing, {
      excludeFolderName: fromValidated.folderName,
    })
    if (!uniqueness.ok) {
      throw new SynopsisInvalidStateError(uniqueness.reason)
    }

    if (fromValidated.sequence === toValidated.sequence) {
      await this.dependencies.workspace.renameVolumeDirectory(
        input.workspaceRootRef,
        fromValidated.folderName,
        toValidated.folderName,
      )
      await this.remapPublishedPathsForVolumeRename(
        input.projectId,
        fromValidated.folderName,
        toValidated.folderName,
      )
      return {
        synopsisPath: remapPathVolumeFolder(
          input.synopsisPath,
          fromValidated.folderName,
          toValidated.folderName,
        ),
        volumeFolderName: toValidated.folderName,
      }
    }

    return {
      synopsisPath: input.synopsisPath,
      volumeFolderName: toValidated.folderName,
      cleanupEmptyFolderName: fromValidated.folderName,
    }
  }

  private async remapPublishedPathsForVolumeRename(
    projectId: ProjectId,
    fromFolderName: string,
    toFolderName: string,
  ): Promise<void> {
    const chapters = await this.dependencies.chapterIndex.list(projectId)
    for (const chapter of chapters) {
      const nextPath = remapPathVolumeFolder(
        chapter.currentPublishPath,
        fromFolderName,
        toFolderName,
      )
      if (nextPath === chapter.currentPublishPath) continue
      await this.dependencies.chapterIndex.updateCurrent({
        projectId,
        chapterId: chapter.chapterId,
        currentSourceId: chapter.currentSourceId,
        currentPublishPath: nextPath,
      })
    }
  }

  private async tryRemoveEmptyVolumeDirectory(
    workspaceRootRef: string,
    folderName: string,
  ): Promise<void> {
    try {
      await this.dependencies.workspace.removeEmptyVolumeDirectory(
        workspaceRootRef,
        deriveVolumeDirectoryPath(folderName),
      )
    } catch (error) {
      runtimeLog("debug", "synopsis-conversation", "skip-empty-volume-cleanup", {
        folderName,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async relocateOutlineBesideSynopsis(
    workspaceRootRef: string,
    oldSynopsisPath: string,
    newSynopsisPath: string,
  ): Promise<void> {
    const oldOutline = siblingPlanningMarkdownPath(oldSynopsisPath, "outline")
    const newOutline = siblingPlanningMarkdownPath(newSynopsisPath, "outline")
    if (oldOutline === undefined || newOutline === undefined || oldOutline === newOutline) return
    const content = await this.readSynopsisFile(workspaceRootRef, oldOutline)
    if (content.trim().length === 0) return
    await this.dependencies.workspace.saveSynopsisMarkdown(workspaceRootRef, newOutline, content)
    await this.dependencies.workspace.removeSynopsisMarkdown(workspaceRootRef, oldOutline)
  }

  private async readSynopsisFile(workspaceRootRef: string, synopsisPath: string): Promise<string> {
    try {
      return await this.dependencies.workspace.readMarkdown(workspaceRootRef, synopsisPath)
    } catch {
      return ""
    }
  }

  private async readFocusedCommittedBody(
    projectId: ProjectId,
    workspaceRootRef: string,
    sequence: number,
  ): Promise<string | undefined> {
    const indexed = await this.dependencies.chapterIndex.findBySequence(projectId, sequence)
    if (indexed === undefined) return undefined
    const version = await this.dependencies.documents.findStoredVersion(projectId, indexed.currentSourceId)
    if (version !== undefined) {
      try {
        const content = await this.dependencies.internalStore.readDocument(version.contentRef)
        if (content.trim().length > 0) return content
      } catch {
        // Fall through to the published workspace file the user can already open.
      }
    }
    try {
      const published = await this.dependencies.workspace.readMarkdown(
        workspaceRootRef,
        indexed.currentPublishPath,
      )
      return published.trim().length === 0 ? undefined : published
    } catch {
      return undefined
    }
  }

  private async readFocusedLatestDraft(
    projectId: ProjectId,
    sequence: number,
  ): Promise<string | undefined> {
    const revisions = this.dependencies.revisions
    if (revisions === undefined) return undefined
    const indexed = await this.dependencies.chapterIndex.findBySequence(projectId, sequence)
    const active = indexed === undefined
      ? await revisions.getDraftWorkspace({ projectId, chapterSequence: sequence })
      : await revisions.findActiveRevision(projectId, indexed.chapterId)
    if (active === undefined) return undefined
    const listed = await revisions.listDraftVersions(active.revisionTaskId)
    const latest = listed.versions.find((version) => version.isLatest) ?? listed.versions.at(-1)
    if (latest === undefined || latest.body.trim().length === 0) return undefined
    return assembleChapterDocument(latest.heading, latest.body)
  }

  private async persistVolumeChapterPlan(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    plan: VolumeChapterPlan
    volumeFolderName: string
  }>): Promise<Readonly<{ synopsisPath: string; outlinePath: string; title: string }>> {
    const title = input.plan.chapterTitle?.trim()
      || extractSynopsisTitleFromDocument(input.plan.synopsisBody)
      || formatChapterSequenceLabel(input.plan.chapterSequence)
    const synopsisPath = deriveSynopsisMarkdownPath(
      input.plan.chapterSequence,
      title,
      input.volumeFolderName,
    )
    const outlinePath = deriveOutlineMarkdownPath(
      input.plan.chapterSequence,
      title,
      input.volumeFolderName,
    )
    this.emitDiscussEdit(input.projectId, {
      path: synopsisPath,
      kind: "synopsis",
      status: "running",
      summary: `正在写入第 ${String(input.plan.chapterSequence)} 章梗概`,
    })
    await this.dependencies.workspace.saveSynopsisMarkdown(
      input.workspaceRootRef,
      synopsisPath,
      input.plan.synopsisBody,
    )
    this.emitDiscussEdit(input.projectId, {
      path: synopsisPath,
      kind: "synopsis",
      status: "completed",
      summary: `已写入第 ${String(input.plan.chapterSequence)} 章梗概`,
    })
    this.emitDiscussEdit(input.projectId, {
      path: outlinePath,
      kind: "outline",
      status: "running",
      summary: `正在写入第 ${String(input.plan.chapterSequence)} 章细纲`,
    })
    await this.dependencies.workspace.saveSynopsisMarkdown(
      input.workspaceRootRef,
      outlinePath,
      input.plan.outlineBody,
    )
    this.emitDiscussEdit(input.projectId, {
      path: outlinePath,
      kind: "outline",
      status: "completed",
      summary: `已写入第 ${String(input.plan.chapterSequence)} 章细纲`,
    })
    return { synopsisPath, outlinePath, title }
  }

  private async applyDiscussChapterDraft(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterSequence: number
    proposal?: ChapterDraftProposal
    volumeFolderName?: string
    messageId: string
  }>): Promise<Readonly<{
    appended?: NonNullable<SynopsisConversationSendResult["appendedDraft"]>
    notice?: string
    deferredSequence?: number
  }>> {
    if (input.proposal === undefined) return {}
    const revisions = this.dependencies.revisions
    if (revisions === undefined) {
      return { notice: "本章修订服务不可用，修订正文未写入草稿。" }
    }
    const indexed = await this.dependencies.chapterIndex.findBySequence(input.projectId, input.chapterSequence)
    if (indexed === undefined) {
      const nextSequence = await this.waitForChapterSequenceGate(input.projectId, input.chapterSequence)
      if (input.chapterSequence > nextSequence) {
        this.emitDiscussEdit(input.projectId, {
          path: deriveChapterPublishPath(
            `${formatChapterSequenceLabel(input.chapterSequence)} 待命名`,
            input.volumeFolderName ?? DEFAULT_VOLUME_FOLDER_NAME,
          ),
          kind: "draft",
          status: "failed",
          summary: `门禁延后：须先发布第${String(nextSequence)}章`,
        })
        return {
          notice: discussChapterSequenceGateHint(nextSequence, [input.chapterSequence]),
          deferredSequence: input.chapterSequence,
        }
      }
      const shortHeading = normalizeDiscussDraftHeading(input.proposal.heading, "待命名")
        .replace(/^第(?:\d+|[零一二三四五六七八九十百千万]+)章\s*/u, "")
      const heading = `${formatChapterSequenceLabel(input.chapterSequence)} ${shortHeading}`
      const body = stripHeadingFromDraftBody(input.proposal.heading, input.proposal.body)
      if (body.trim().length === 0) return { notice: "正文为空，未写入草稿。" }
      try {
        const stored = await revisions.startForChapterSequence({
          projectId: input.projectId,
          workspaceRootRef: input.workspaceRootRef,
          chapterSequence: input.chapterSequence,
          heading,
          body,
          volumeFolderName: input.volumeFolderName ?? DEFAULT_VOLUME_FOLDER_NAME,
          source: "agent",
          messageId: input.messageId,
        })
        const draft = await revisions.readRevision(stored.revisionTaskId)
        this.emitDiscussEdit(input.projectId, {
          path: draft.publishPath ?? deriveChapterPublishPath(heading, input.volumeFolderName ?? DEFAULT_VOLUME_FOLDER_NAME),
          kind: "draft",
          status: "completed",
          summary: `已写入草稿 ${stored.label}`,
        })
        return { appended: {
          revisionTaskId: stored.revisionTaskId,
          chapterId: draft.chapterId,
          draftVersionId: stored.versionId,
          draftLabel: stored.label,
        } }
      } catch (error) {
        if (
          error instanceof RevisionInvalidStateError
          || isPrecedingChapterPublishGateError(error)
        ) {
          const allowed = await this.dependencies.chapters.nextChapterSequence(input.projectId)
          this.emitDiscussEdit(input.projectId, {
            path: deriveChapterPublishPath(heading, input.volumeFolderName ?? DEFAULT_VOLUME_FOLDER_NAME),
            kind: "draft",
            status: "failed",
            summary: `门禁延后：须先发布第${String(allowed)}章`,
          })
          return {
            notice: discussChapterSequenceGateHint(allowed, [input.chapterSequence]),
            deferredSequence: input.chapterSequence,
          }
        }
        throw error
      }
    }
    const current = await revisions.read(input.projectId, indexed.chapterId)
    const heading = normalizeDiscussDraftHeading(input.proposal.heading, current.heading)
    const body = stripHeadingFromDraftBody(heading, input.proposal.body)
    if (body.trim().length === 0) {
      return { notice: "修订正文为空，未写入草稿。" }
    }
    const active = await revisions.findActiveRevision(input.projectId, indexed.chapterId)
    const started = active ?? await revisions.start({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      chapterId: indexed.chapterId,
      baseSourceId: current.sourceId,
      heading: current.heading,
      body: current.body,
      inputMode: "agent",
    })
    const listed = await revisions.listDraftVersions(started.revisionTaskId)
    const latest = listed.versions.find((version) => version.isLatest) ?? listed.versions.at(-1)
    if (latest !== undefined && latest.heading === heading && latest.body === body) {
      this.emitDiscussEdit(input.projectId, {
        path: indexed.currentPublishPath,
        kind: "draft",
        status: "completed",
        summary: `草稿未变（仍为 ${latest.label}）`,
      })
      return {
        appended: {
          revisionTaskId: started.revisionTaskId,
          chapterId: indexed.chapterId,
          draftVersionId: latest.versionId,
          draftLabel: latest.label,
        },
      }
    }
    this.emitDiscussEdit(input.projectId, {
      path: indexed.currentPublishPath,
      kind: "draft",
      status: "running",
      summary: "正在写入修订草稿",
    })
    const stored = await revisions.appendDraftVersion({
      revisionTaskId: started.revisionTaskId,
      source: "agent",
      heading,
      body,
      messageId: input.messageId,
      ...(input.proposal.base === "draft" && input.proposal.baseDraftVersionId !== undefined
        ? { parentVersionId: input.proposal.baseDraftVersionId }
        : {}),
    })
    this.emitDiscussEdit(input.projectId, {
      path: indexed.currentPublishPath,
      kind: "draft",
      status: "completed",
      summary: `已写入草稿 ${stored.label}`,
    })
    return {
      appended: {
        revisionTaskId: stored.revisionTaskId,
        chapterId: indexed.chapterId,
        draftVersionId: stored.versionId,
        draftLabel: stored.label,
      },
    }
  }

  private async synopsisFileExists(workspaceRootRef: string, synopsisPath: string): Promise<boolean> {
    const content = await this.readSynopsisFile(workspaceRootRef, synopsisPath)
    return content.length > 0
  }

  private async applyTitleAlignTarget(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterSequence: number
    target: "body" | "planning"
    synopsisPath: string
    sessionTitle: string
    volumeFolderName: string
  }>): Promise<Readonly<{
    synopsisPath: string
    sessionTitle: string
    notices: readonly string[]
  }>> {
    const notices: string[] = []
    if (input.target === "body") {
      const indexed = await this.dependencies.chapterIndex.findBySequence(input.projectId, input.chapterSequence)
      const issue = await this.dependencies.chapterSynopsis.detectTitleAlignmentIssue({
        workspaceRootRef: input.workspaceRootRef,
        chapterSequence: input.chapterSequence,
      })
      const onDiskBody = indexed?.currentPublishPath === undefined && issue === undefined
        ? await this.dependencies.chapterSynopsis.findBodyFile({
            workspaceRootRef: input.workspaceRootRef,
            chapterSequence: input.chapterSequence,
          })
        : undefined
      const bodyPath = indexed?.currentPublishPath ?? issue?.bodyPath ?? onDiskBody?.path
      const bodyHeading = issue?.bodyHeading
        ?? (bodyPath === undefined
          ? undefined
          : bodyPath.replaceAll("\\", "/").split("/").at(-1)?.replace(/\.md$/u, ""))
      if (bodyPath === undefined || bodyHeading === undefined) {
        notices.push("本章还没有正文文件，无需按正文对齐标题。")
        return { synopsisPath: input.synopsisPath, sessionTitle: input.sessionTitle, notices }
      }
      if (issue === undefined) {
        const planning = await this.dependencies.chapterSynopsis.findPlanningHeading({
          workspaceRootRef: input.workspaceRootRef,
          chapterSequence: input.chapterSequence,
        })
        const planningShort = planning === undefined
          ? undefined
          : parseSynopsisTitleFromLabel(planning.titleLabel) ?? planning.titleLabel
        const bodyShort = parseSynopsisTitleFromLabel(bodyHeading) ?? bodyHeading
        if (planningShort === bodyShort) {
          notices.push(`标题已一致（${bodyHeading}），无需再对齐。`)
          return { synopsisPath: input.synopsisPath, sessionTitle: input.sessionTitle, notices }
        }
      }
      await this.dependencies.chapterSynopsis.alignPlanningTitlesToPublishedHeading({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        chapterSequence: input.chapterSequence,
        chapterHeading: bodyHeading,
        chapterPath: bodyPath,
      })
      const shortTitle = parseSynopsisTitleFromLabel(bodyHeading) ?? bodyHeading
      const nextSynopsis = deriveSynopsisMarkdownPath(
        input.chapterSequence,
        shortTitle,
        extractVolumeFolderNameFromPath(bodyPath) ?? input.volumeFolderName,
      )
      notices.push(
        `已按正文标题对齐梗概/细纲（→ ${bodyHeading}）。请刷新文件树验收：同章应只剩一个折叠入口，关联栏梗概/细纲应变为已创建。`,
      )
      return { synopsisPath: nextSynopsis, sessionTitle: shortTitle, notices }
    }

    const planning = await this.dependencies.chapterSynopsis.findPlanningHeading({
      workspaceRootRef: input.workspaceRootRef,
      chapterSequence: input.chapterSequence,
    })
    const indexed = await this.dependencies.chapterIndex.findBySequence(input.projectId, input.chapterSequence)
    const issue = await this.dependencies.chapterSynopsis.detectTitleAlignmentIssue({
      workspaceRootRef: input.workspaceRootRef,
      chapterSequence: input.chapterSequence,
    })
    const currentBodyPath = indexed?.currentPublishPath ?? issue?.bodyPath
    if (planning === undefined || currentBodyPath === undefined) {
      notices.push("未能同时找到规划文件与正文，titleAlignTarget=planning 未执行。")
      return { synopsisPath: input.synopsisPath, sessionTitle: input.sessionTitle, notices }
    }
    const nextBodyPath = deriveChapterPublishPath(planning.titleLabel, planning.volumeFolderName)
    if (currentBodyPath !== nextBodyPath) {
      const content = await this.dependencies.workspace.readMarkdown(
        input.workspaceRootRef,
        currentBodyPath,
      )
      await this.dependencies.workspace.replacePublishedChapter(
        input.workspaceRootRef,
        currentBodyPath,
        nextBodyPath,
        digest(content),
        content,
      )
      if (indexed !== undefined) {
        await this.dependencies.chapterIndex.updateCurrent({
          projectId: input.projectId,
          chapterId: indexed.chapterId,
          currentSourceId: indexed.currentSourceId,
          currentPublishPath: nextBodyPath,
        })
      }
    }
    const shortTitle = parseSynopsisTitleFromLabel(planning.titleLabel) ?? planning.titleLabel
    const nextSynopsis = deriveSynopsisMarkdownPath(
      input.chapterSequence,
      shortTitle,
      planning.volumeFolderName,
    )
    notices.push(
      `已按细纲/梗概标题重命名正文（→ ${planning.titleLabel}）。请刷新文件树验收：同章应只剩一个折叠入口。`,
    )
    return {
      synopsisPath: nextSynopsis,
      sessionTitle: shortTitle,
      notices,
    }
  }

}

function summarizeSynopsisToolRunResult(result: Record<string, unknown>): string {
  const status = typeof result.status === "string" ? result.status : "unknown"
  if (status === "error") {
    const message = typeof result.message === "string" ? result.message.trim() : ""
    return message.length === 0 ? "tool_failed" : truncateToolRunSummary(message)
  }
  if (status === "described") return "described"
  if (status === "bash_completed") {
    const payload = result.result
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const bash = payload as Record<string, unknown>
      const exit = bash.exitCode === null || bash.exitCode === undefined ? "?" : String(bash.exitCode)
      const stdout = typeof bash.stdout === "string" ? bash.stdout.trim() : ""
      const stderr = typeof bash.stderr === "string" ? bash.stderr.trim() : ""
      const body = stdout.length > 0 ? stdout : stderr
      const timedOut = bash.timedOut === true ? " timedOut" : ""
      if (body.length === 0) return `exit=${exit}${timedOut}`
      return truncateToolRunSummary(`exit=${exit}${timedOut}\n${body}`)
    }
  }
  return truncateToolRunSummary(status)
}

function truncateToolRunSummary(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").trim()
  if (normalized.length <= 1_200) return normalized
  return `${normalized.slice(0, 1_199)}…`
}

function summarizeConversation(messages: readonly Readonly<{ role: string; content: string }>[]): string {
  const lines = messages.map((message) => {
    const speaker = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : "系统"
    return `${speaker}：${message.content}`
  })
  return `# 剧情梗概讨论记录\n\n${lines.join("\n\n")}`
}

function isMissingSynopsisArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("expected object, received undefined")
    || message.includes("Invalid input: expected object")
    || (message.includes("assistantMessage") && message.includes("invalid_type"))
    || message.includes("synopsisDiscussArtifact")
}

/** Schema / phase-contract failures that the discuss loop can still recover from. */
export function isRecoverableDiscussPhaseContractError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes("phase contract") && !message.includes("toolRequest 不可与")) return false
  // Network/config failures must still surface; only schema-shaped contract errors retry.
  if (error !== null && typeof error === "object" && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind
    if (kind !== undefined && kind !== "schema") return false
  }
  return true
}

export function discussPhaseContractRepairHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("toolRequest")) {
    return [
      "上一轮 phase contract 失败：toolRequest 不可与章节写入、草稿提案、choices、focusChange 等动作同回。",
      "本轮只做一件事：若需工具，outcome=continue 且 artifact 仅含 assistantMessage、finalSelfReview、toolRequest；",
      "若已可交付，不要带 toolRequest，直接返回写入类字段。先等工具结果再继续。",
    ].join("")
  }
  return `上一轮 phase contract 失败：${message.slice(0, 400)}。请按校验错误整份重写合法 artifact，不要复述无效 JSON。`
}

function mapSynopsisStagingPatch(patch: {
  entryId?: string | undefined
  title: string
  body: string
  promoteTargetPath?: string | undefined
  status?: StagingEntryPatch["status"] | undefined
}): StagingEntryPatch {
  return {
    title: patch.title,
    body: patch.body,
    ...(patch.entryId === undefined ? {} : { entryId: patch.entryId }),
    ...(patch.promoteTargetPath === undefined ? {} : { promoteTargetPath: patch.promoteTargetPath }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
  }
}

function mapSynopsisStagingDelta(delta: {
  notes?: readonly {
    entryId?: string | undefined
    title: string
    body: string
    promoteTargetPath?: string | undefined
    status?: StagingEntryPatch["status"] | undefined
  }[] | undefined
  characters?: readonly {
    entryId?: string | undefined
    title: string
    body: string
    promoteTargetPath?: string | undefined
    status?: StagingEntryPatch["status"] | undefined
  }[] | undefined
  worldRules?: readonly {
    entryId?: string | undefined
    title: string
    body: string
    promoteTargetPath?: string | undefined
    status?: StagingEntryPatch["status"] | undefined
  }[] | undefined
  promoteHints?: readonly {
    entryId?: string | undefined
    title: string
    body: string
    promoteTargetPath?: string | undefined
    status?: StagingEntryPatch["status"] | undefined
  }[] | undefined
}): Readonly<{
  notes?: readonly StagingEntryPatch[]
  characters?: readonly StagingEntryPatch[]
  worldRules?: readonly StagingEntryPatch[]
  promoteHints?: readonly StagingEntryPatch[]
}> {
  return {
    ...(delta.notes === undefined ? {} : { notes: delta.notes.map(mapSynopsisStagingPatch) }),
    ...(delta.characters === undefined ? {} : { characters: delta.characters.map(mapSynopsisStagingPatch) }),
    ...(delta.worldRules === undefined ? {} : { worldRules: delta.worldRules.map(mapSynopsisStagingPatch) }),
    ...(delta.promoteHints === undefined ? {} : { promoteHints: delta.promoteHints.map(mapSynopsisStagingPatch) }),
  }
}

function mapSynopsisStagingPromote(promote: {
  settingsWrites: readonly {
    entryId: string
    relativePath: string
    markdown: string
    readmeEntry?: string | undefined
    mode: "create" | "update"
  }[]
  goalProposals?: readonly {
    payload: GoalProposalPayload
    reason?: string | undefined
  }[] | undefined
  reason?: string | undefined
}): Readonly<{
  settingsWrites: readonly Readonly<{
    entryId: string
    relativePath: string
    markdown: string
    readmeEntry?: string
    mode: "create" | "update"
  }>[]
  goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
  reason?: string
}> {
  return {
    settingsWrites: promote.settingsWrites.map((write) => ({
      entryId: write.entryId,
      relativePath: write.relativePath,
      markdown: write.markdown,
      mode: write.mode,
      ...(write.readmeEntry === undefined ? {} : { readmeEntry: write.readmeEntry }),
    })),
    ...(promote.goalProposals === undefined
      ? {}
      : {
          goalProposals: promote.goalProposals.map((proposal) => ({
            payload: proposal.payload,
            ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
          })),
        }),
    ...(promote.reason === undefined ? {} : { reason: promote.reason }),
  }
}

function mapSynopsisPresentationWrites(
  writes: readonly Readonly<{
    relativePath: string
    markdown: string
    mode: "create" | "update"
  }>[],
): readonly Readonly<{
  relativePath: string
  markdown: string
  mode: "create" | "update"
}>[] {
  return writes.map((write) => ({
    relativePath: write.relativePath.trim().replace(/\\/gu, "/"),
    markdown: write.markdown,
    mode: write.mode,
  }))
}

function synopsisSearchLabel(read: import("@worldseed/contracts").ReadRequest): string {
  return isTemporalReadRequest(read) ? formatTemporalSearchLabel(read) : formatSynopsisSearchLabel(read)
}

function evidenceMatchesRead(
  item: TurnReadEvidence,
  read: import("@worldseed/contracts").ReadRequest,
): boolean {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replaceAll("\\", "/")
  const path = normalize(item.ownerId)
  const evidenceKeys = item.exactKeys.map(normalize)
  const terms = [...read.query.exactKeys, ...read.query.semanticTexts, ...(read.query.entityHints ?? [])]
    .map(normalize)
    .filter((term) => term.length > 0)
  if (terms.length === 0) return true
  if (item.ownerKind.startsWith("web:")) {
    return terms.some((term) => path.includes(term) || evidenceKeys.some((key) => key === term))
  }
  return terms.some((term) => (
    path === term
    || path.includes(term)
    || path.split("/").at(-1) === term
    || evidenceKeys.some((key) => key === term || key.includes(term) || term.includes(key))
    || path.includes(`chapter-seq-${term}`)
    || path.includes(`as-of-${term}`)
  ))
}

function resolveRefreshTargetMessage(
  messages: readonly SynopsisConversationMessage[],
  messageId: string | undefined,
): SynopsisConversationMessage | undefined {
  if (messageId !== undefined) {
    const exact = messages.find((message) => message.messageId === messageId)
    if (exact?.role === "assistant" && (exact.choices?.length ?? 0) > 0 && exact.hidden !== true) {
      return exact
    }
    return undefined
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && (message.choices?.length ?? 0) > 0 && message.hidden !== true) {
      return message
    }
  }
  return undefined
}

export function buildRefreshChoicesPrompt(choices: readonly SynopsisConversationChoice[]): string {
  const labels = choices.map((choice) => `- ${choice.label}`).join("\n")
  return [
    "请换一批决策选项。",
    "要求：",
    "1. 新选项的含义不得与下列已有选项重复，也避免同义改写：",
    labels,
    "2. 仍用 choices 返回可点选按钮；方向类用 continue_discuss，结构性动作（如 confirm_synopsis / confirm_arc_plan / start_turn / promote_staging）仅在仍适用时保留。",
    "3. assistantMessage 一两句说明换了什么方向即可，不要长篇铺垫，也不要改写梗概文件，除非为支撑新选项所必需。",
    "4. 这是静默刷新：只产出新 choices，不要假设用户会看到完整对话气泡。",
  ].join("\n")
}

export function mergeSynopsisChoices(
  existing: readonly SynopsisConversationChoice[],
  incoming: readonly SynopsisConversationChoice[],
  maxChoices = 16,
): SynopsisConversationChoice[] {
  const seen = new Set(existing.map((choice) => choice.label.trim()))
  const merged = [...existing]
  for (const choice of incoming) {
    const label = choice.label.trim()
    if (label.length === 0 || seen.has(label)) continue
    seen.add(label)
    merged.push(choice)
    if (merged.length >= maxChoices) break
  }
  return merged
}

function createAssistBudget(maxCalls: number, deadlineAtMs: number) {
  const safeCalls = Math.max(1, maxCalls)
  return {
    maxCalls: safeCalls,
    remainingCalls: safeCalls,
    maxInputTokens: 1_000_000,
    remainingInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
    remainingOutputTokens: 64_000,
    deadlineAtMs,
    modelRequestDeadlineAtMs: deadlineAtMs,
  }
}

function finalizeDiscussReturn(
  projectId: ProjectId,
  latest: SynopsisConversationBudgetAdvisory | undefined,
  result: Readonly<{
    content: string
    reasoningContent?: string
    chapterTitle?: string
    titleAlignTarget?: "body" | "planning"
    volumeFolderName?: string
    workDisplayName?: string
    synopsisBody?: string
    outlineBody?: string
    bodyEdits?: Readonly<{
      target: "outline"
      baseDigest?: string
      ops: readonly Readonly<{ oldText: string; newText: string }>[]
    }>
    chapterDraftProposal?: ChapterDraftProposal
    chapterDraftProposals?: readonly ChapterDraftProposalEntry[]
    volumeChapterPlans?: readonly VolumeChapterPlan[]
    focusChange?: Readonly<{
      chapterSequence: number
      focusKind?: DiscussFocusKind
    }>
    continueTurn?: boolean
    choices?: SynopsisConversationSendResult["messages"][number]["choices"]
    goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
    stagingDelta?: Readonly<{
      notes?: readonly StagingEntryPatch[]
      characters?: readonly StagingEntryPatch[]
      worldRules?: readonly StagingEntryPatch[]
      promoteHints?: readonly StagingEntryPatch[]
    }>
    stagingPromote?: Readonly<{
      settingsWrites: readonly Readonly<{
        entryId: string
        relativePath: string
        markdown: string
        readmeEntry?: string
        mode: "create" | "update"
      }>[]
      goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
      reason?: string
    }>
    presentationWrites?: readonly Readonly<{
      relativePath: string
      markdown: string
      mode: "create" | "update"
    }>[]
    arcPlanMarkdown?: string
  }>,
): Readonly<{
  content: string
  reasoningContent?: string
  chapterTitle?: string
  titleAlignTarget?: "body" | "planning"
  volumeFolderName?: string
  workDisplayName?: string
  synopsisBody?: string
  outlineBody?: string
  bodyEdits?: Readonly<{
    target: "outline"
    baseDigest?: string
    ops: readonly Readonly<{ oldText: string; newText: string }>[]
  }>
  chapterDraftProposal?: ChapterDraftProposal
  chapterDraftProposals?: readonly ChapterDraftProposalEntry[]
  volumeChapterPlans?: readonly VolumeChapterPlan[]
  focusChange?: Readonly<{
    chapterSequence: number
    focusKind?: DiscussFocusKind
  }>
  continueTurn?: boolean
  choices?: SynopsisConversationSendResult["messages"][number]["choices"]
  goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
  stagingDelta?: Readonly<{
    notes?: readonly StagingEntryPatch[]
    characters?: readonly StagingEntryPatch[]
    worldRules?: readonly StagingEntryPatch[]
    promoteHints?: readonly StagingEntryPatch[]
  }>
  stagingPromote?: Readonly<{
    settingsWrites: readonly Readonly<{
      entryId: string
      relativePath: string
      markdown: string
      readmeEntry?: string
      mode: "create" | "update"
    }>[]
    goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
    reason?: string
  }>
  presentationWrites?: readonly Readonly<{
    relativePath: string
    markdown: string
    mode: "create" | "update"
  }>[]
  arcPlanMarkdown?: string
  budgetAdvisory?: SynopsisConversationBudgetAdvisory
}> {
  const budgetAdvisory = latest ?? peekSynopsisModelBudgetAdvisory(projectId)
  return budgetAdvisory === undefined ? result : { ...result, budgetAdvisory }
}

function buildSynopsisDiscussFallbackReturn(input: Readonly<{
  projectId: ProjectId
  accumulatedReasoning: string
  streamedContent: string
}>): Readonly<{ content: string; reasoningContent?: string }> {
  const streamed = normalizeThinkingDisplayText(input.streamedContent.trim())
  const content = (streamed !== undefined && !streamed.trimStart().startsWith("{") ? streamed : undefined)
    ?? (input.accumulatedReasoning.length > 0 ? input.accumulatedReasoning.slice(0, 4_000) : undefined)
    ?? "本轮讨论与检索轮次较多，已先停在本阶段。你可以继续发送更具体的指令，我会基于已有上下文接着推进。"
  return input.accumulatedReasoning.length === 0
    ? { content }
    : { content, reasoningContent: input.accumulatedReasoning }
}

function mapArtifactChapterDraftProposal(
  proposal: Readonly<{
    base?: "body" | "draft"
    baseDraftVersionId?: string | undefined
    heading: string
    body: string
  }> | undefined,
): { chapterDraftProposal?: ChapterDraftProposal } {
  if (proposal === undefined) return {}
  return {
    chapterDraftProposal: {
      base: proposal.base ?? "body",
      heading: proposal.heading,
      body: proposal.body,
      ...(proposal.baseDraftVersionId === undefined ? {} : { baseDraftVersionId: proposal.baseDraftVersionId }),
    },
  }
}

function mapArtifactChapterDraftProposals(
  proposals: readonly Readonly<{
    chapterSequence: number
    base?: "body" | "draft"
    baseDraftVersionId?: string | undefined
    heading: string
    body: string
  }>[] | undefined,
): { chapterDraftProposals?: readonly ChapterDraftProposalEntry[] } {
  if (proposals === undefined || proposals.length === 0) return {}
  return {
    chapterDraftProposals: proposals.map((proposal) => ({
      chapterSequence: proposal.chapterSequence,
      base: proposal.base ?? "body",
      heading: proposal.heading,
      body: proposal.body,
      ...(proposal.baseDraftVersionId === undefined ? {} : { baseDraftVersionId: proposal.baseDraftVersionId }),
    })),
  }
}

function mapArtifactVolumeChapterPlans(
  plans: readonly Readonly<{
    chapterSequence: number
    chapterTitle?: string | undefined
    synopsisBody: string
    outlineBody: string
  }>[] | undefined,
): { volumeChapterPlans?: readonly VolumeChapterPlan[] } {
  if (plans === undefined || plans.length === 0) return {}
  return {
    volumeChapterPlans: plans.map((plan) => ({
      chapterSequence: plan.chapterSequence,
      synopsisBody: plan.synopsisBody,
      outlineBody: plan.outlineBody,
      ...(plan.chapterTitle === undefined || plan.chapterTitle.length === 0
        ? {}
        : { chapterTitle: plan.chapterTitle }),
    })),
  }
}

function mapArtifactFocusChange(
  change: Readonly<{
    chapterSequence: number
    focusKind?: DiscussFocusKind | undefined
  }> | undefined,
): { focusChange?: Readonly<{ chapterSequence: number; focusKind?: DiscussFocusKind }> } {
  if (change === undefined) return {}
  return {
    focusChange: {
      chapterSequence: change.chapterSequence,
      ...(change.focusKind === undefined ? {} : { focusKind: change.focusKind }),
    },
  }
}

function withPromoteDraftChoice(
  choices: SynopsisConversationChoice[] | undefined,
  draftLabel: string | undefined,
): SynopsisConversationChoice[] | undefined {
  if (draftLabel === undefined) return choices
  const label = `是否确认用草稿(${draftLabel})经图治理覆盖正式正文`
  const rest = (choices ?? []).filter((choice) => choice.action !== "promote_draft_to_body")
  return [...rest, { label, action: "promote_draft_to_body" }]
}

export function filterDiscussChoices(
  choices: SynopsisConversationChoice[] | undefined,
  input: Readonly<{ focusLocked: boolean; appliedFocusSequence?: number }>,
): SynopsisConversationChoice[] | undefined {
  if (choices === undefined) return undefined
  const filtered = choices.filter((choice) => {
    if (input.focusLocked && (choice.action === "set_focus" || choice.action === "start_turn")) {
      return false
    }
    // Drop redundant confirm buttons once focus already moved this turn.
    if (
      choice.action === "set_focus"
      && input.appliedFocusSequence !== undefined
      && choice.chapterSequence === input.appliedFocusSequence
    ) {
      return false
    }
    return true
  })
  return filtered.length === 0 ? undefined : filtered
}

function stripHeadingFromDraftBody(heading: string, body: string): string {
  try {
    return readChapterBody(heading, body).trim()
  } catch {
    return body.replaceAll("\r\n", "\n").trim()
  }
}

function normalizeDiscussDraftHeading(proposed: string, fallback: string): string {
  const trimmed = proposed.trim().replace(/^#+\s*/u, "")
  return trimmed.length === 0 ? fallback : trimmed
}

/** User clicked confirm_synopsis or typed an equivalent confirmation. */
export function isConfirmSynopsisUserMessage(message: string): boolean {
  const text = message.trim()
  if (text.length === 0) return false
  return /用这份梗概写细纲/u.test(text)
    || /确认(?:本章)?梗概/u.test(text)
    || /开始写细纲/u.test(text)
    || /确认梗概[，,]?\s*开始写细纲/u.test(text)
    || /按(?:照)?(?:这份)?梗概重写(?:整个)?细纲/u.test(text)
}

/** User confirmed outline → allow chapter body draft (逐步确认第二闸). */
export function isConfirmOutlineUserMessage(message: string): boolean {
  const text = message.trim()
  if (text.length === 0) return false
  return /按细纲写正文/u.test(text)
    || /确认(?:本章)?细纲/u.test(text)
    || /开始写正文/u.test(text)
    || /按(?:照)?(?:这份)?细纲开推/u.test(text)
}

/** Skip outline and start body from synopsis. */
export function isSkipOutlineStartTurnMessage(message: string): boolean {
  const text = message.trim()
  if (text.length === 0) return false
  return /跳过细纲/u.test(text)
    || /按梗概开推/u.test(text)
    || /按这份梗概开推/u.test(text)
}

function mergeConfirmOutlineChoice(
  choices: SynopsisConversationSendResult["messages"][number]["choices"] | undefined,
): SynopsisConversationSendResult["messages"][number]["choices"] {
  const rest = (choices ?? []).filter((choice) => choice.label !== "按细纲写正文")
  return [...rest, { label: "按细纲写正文", action: "continue_discuss" as const }]
}
