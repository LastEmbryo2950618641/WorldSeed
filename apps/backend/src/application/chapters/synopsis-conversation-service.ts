import {
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ProjectId,
  type ProjectSettings,
  type PhaseResultEnvelope,
  type ChapterNarrativeIntent,
  type SynopsisConversationListResult,
  type SynopsisConversationMessage,
  type SynopsisConversationSendResult,
  type SynopsisConversationStartResult,
  type SynopsisConversationStreamSnapshot,
  type SynopsisConversationChoice,
  type SynopsisResolveTurnInputResult,
  type TurnHandoffBrief,
  type TurnMonitorPhaseSnapshot,
  type WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"
import { defaultProjectSettings } from "@worldseed/config"

import {
  assembleSynopsisPlaceholderDocument,
  deriveSynopsisMarkdownPath,
  extractSynopsisTitleFromDocument,
  formatChapterSequenceLabel,
  parseSynopsisMarkdownPath,
  digest,
} from "../../core/index.js"
import type { GoalProposalPayload } from "@worldseed/contracts"
import type { AIModelPort, PromptResourcePort, TurnReadEvidence, TurnRetrievalGap } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort } from "../workspace/index.js"
import type { WorkspaceCatalogPort } from "../retrieval/ports/workspace-catalog.js"
import type { WebResearchPort } from "../retrieval/ports/web-research-port.js"
import type { ChapterResolveService } from "./chapter-resolve-service.js"
import type { DeductionGoalsService } from "./deduction-goals-service.js"
import type { StagingPromoteService } from "./staging-promote-service.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"
import { synopsisConversationStreamHub } from "./synopsis-conversation-stream-hub.js"
import { normalizeThinkingDisplayText } from "./synopsis-thinking-text.js"
import {
  executeSynopsisWorkspaceReads,
  formatSynopsisSearchLabel,
} from "./synopsis-workspace-reads.js"
import {
  ARC_PLAN_STAGING_PATH,
  STAGING_FILE_KEYS,
  evictStagingEntries,
  mergeStagingPatches,
  parseStagingEntries,
  serializeStagingEntries,
  stagingFileTitle,
  type StagingEntry,
  type StagingEntryPatch,
} from "./staging-entries.js"
import { chapterNarrativeIntentPhaseAppendix } from "../settings/chapter-narrative-intent-policy.js"
import {
  formatTurnHandoffSystemMessage,
} from "./turn-handoff.js"

export class SynopsisInvalidStateError extends Error {}

export type SynopsisConversationServiceDependencies = Readonly<{
  chapters: ChapterResolveService
  conversation: SqliteSynopsisConversationRepository
  goals: DeductionGoalsService
  stagingPromote: StagingPromoteService
  workspace: WorkspacePort
  catalog: WorkspaceCatalogPort
  prompts: PromptResourcePort
  webResearch?: WebResearchPort
  readProjectSettings?: () => Promise<ProjectSettings>
  readTurnMonitor?: () => Promise<Readonly<{
    taskId: string
    status: string
    phases: readonly TurnMonitorPhaseSnapshot[]
  }> | undefined>
  createId: () => string
  now: () => number
}>

export class SynopsisConversationService {
  public constructor(private readonly dependencies: SynopsisConversationServiceDependencies) {}

  public async list(projectId: ProjectId): Promise<SynopsisConversationListResult> {
    const session = await this.dependencies.conversation.findActiveSession(projectId)
    const messages = await this.dependencies.conversation.listMessagesForProject(projectId)
    if (session === undefined) return { messages: [...messages] }
    return { session, messages: [...messages] }
  }

  public async start(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    title?: string
  }>): Promise<SynopsisConversationStartResult> {
    const existing = await this.dependencies.conversation.findActiveSession(input.projectId)
    if (existing !== undefined) {
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      return { session: existing, messages: [...messages] }
    }
    const fromIndex = await this.dependencies.chapters.nextChapterSequence(input.projectId)
    const maxSessionSequence = await this.dependencies.conversation.maxChapterSequence(input.projectId)
    const chapterSequence = Math.max(fromIndex, (maxSessionSequence ?? 0) + 1)
    const claimed = await this.findExistingSynopsisForSequence(input.workspaceRootRef, chapterSequence)
    const title = input.title?.trim()
      || claimed?.title
      || ""
    const synopsisPath = claimed?.path ?? deriveSynopsisMarkdownPath(chapterSequence, title)
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
    return { session, messages: [...messages] }
  }

  public peekStream(projectId: ProjectId, sessionId?: string): SynopsisConversationStreamSnapshot {
    return synopsisConversationStreamHub.peek(projectId, sessionId)
  }

  public async send(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    message: string
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<SynopsisConversationSendResult> {
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
    // Reset stream hub before any further awaits so concurrent streamPeek cannot
    // resurface the previous turn's completed thinking/content.
    const streamStartedAtMs = this.dependencies.now()
    synopsisConversationStreamHub.begin(input.projectId, session.sessionId, streamStartedAtMs)
    try {
      const priorMessages = await this.dependencies.conversation.listMessages(session.sessionId)
      const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
      const synopsisDigest = digest(synopsisMarkdown)
      const userEditedSinceAgent = session.lastAgentDigest !== undefined && session.lastAgentDigest !== synopsisDigest
      const nowMs = this.dependencies.now()
      const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
      const activeGoals = goalsSnapshot.goals.filter((goal) => goal.lifecycle === "active")
      const chapterProgress = goalsSnapshot.progress.filter(
        (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
      )
      await this.dependencies.conversation.appendMessage({
        messageId: this.dependencies.createId(),
        projectId: input.projectId,
        sessionId: session.sessionId,
        role: "user",
        content: input.message,
        createdAtMs: nowMs,
      })
      const assist = await this.runSynopsisDiscuss({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        sessionId: session.sessionId,
        userMessage: input.message,
        heading: session.title,
        chapterSequence: session.chapterSequence,
        synopsisMarkdown,
        userEditedSinceAgent,
        conversationHistory: priorMessages.map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: message.content,
        })),
        activeGoals,
        chapterProgress,
        model: input.model,
        ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
        ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }),
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      })
      let synopsisPath = session.synopsisPath
      let sessionTitle = session.title
      let lastAgentDigest = session.lastAgentDigest
      if (assist.synopsisBody !== undefined && !userEditedSinceAgent) {
        const resolvedTitle = assist.chapterTitle?.trim()
          ?? extractSynopsisTitleFromDocument(assist.synopsisBody)
        if (resolvedTitle !== undefined && resolvedTitle.length > 0) {
          const nextPath = deriveSynopsisMarkdownPath(session.chapterSequence, resolvedTitle)
          if (nextPath !== synopsisPath) {
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              nextPath,
              assist.synopsisBody,
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
        } else {
          await this.dependencies.workspace.saveSynopsisMarkdown(
            input.workspaceRootRef,
            synopsisPath,
            assist.synopsisBody,
          )
        }
        lastAgentDigest = digest(assist.synopsisBody)
      } else if (assist.synopsisBody !== undefined && userEditedSinceAgent) {
        runtimeLog("debug", "synopsis-conversation", "skipped-agent-overwrite", {
          projectId: input.projectId,
          sessionId: session.sessionId,
        })
      } else if (assist.chapterTitle !== undefined && !userEditedSinceAgent) {
        const resolvedTitle = assist.chapterTitle.trim()
        if (resolvedTitle.length > 0) {
          const nextPath = deriveSynopsisMarkdownPath(session.chapterSequence, resolvedTitle)
          if (nextPath !== synopsisPath) {
            const currentBody = await this.readSynopsisFile(input.workspaceRootRef, synopsisPath)
            await this.dependencies.workspace.saveSynopsisMarkdown(
              input.workspaceRootRef,
              nextPath,
              currentBody,
            )
            await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, synopsisPath)
            synopsisPath = nextPath
            sessionTitle = resolvedTitle
          }
        }
      }
      const assistantMessageId = this.dependencies.createId()
      if (assist.stagingDelta !== undefined) {
        await this.applyStagingDelta({
          workspaceRootRef: input.workspaceRootRef,
          delta: assist.stagingDelta,
          sourceMessageId: assistantMessageId,
        })
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: "staging: 暂存区",
          status: "completed",
          resultSummary: "已更新暂存区草稿",
        }, this.dependencies.now())
      }
      if (assist.arcPlanMarkdown !== undefined) {
        await this.dependencies.workspace.saveUserMarkdown(
          input.workspaceRootRef,
          ARC_PLAN_STAGING_PATH,
          assist.arcPlanMarkdown,
        )
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: `staging: ${ARC_PLAN_STAGING_PATH}`,
          status: "completed",
          resultSummary: "已写入弧线规划",
        }, this.dependencies.now())
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
        content: assist.content,
        ...(persistedThinking === undefined ? {} : { reasoningContent: persistedThinking }),
        ...(streamPeek.searching.length === 0 ? {} : { searching: streamPeek.searching }),
        ...(assist.choices === undefined ? {} : { choices: assist.choices }),
        createdAtMs: nowMs + 1,
      })
      const pendingProposals = assist.goalProposals === undefined || assist.goalProposals.length === 0
        ? []
        : await this.dependencies.goals.createProposalsFromArtifact({
            projectId: input.projectId,
            proposals: assist.goalProposals,
            sourceMessageId: assistantMessageId,
          })
      const pendingStagingPromotes = assist.stagingPromote === undefined
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
      await this.dependencies.conversation.updateSession({
        sessionId: session.sessionId,
        synopsisPath,
        title: sessionTitle,
        ...(lastAgentDigest === undefined ? {} : { lastAgentDigest }),
        updatedAtMs: nowMs + 1,
      })
      const updatedSession = (await this.dependencies.conversation.findSession(session.sessionId)) as NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>
      const messages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
      synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
        thinking: assist.reasoningContent ?? streamPeek.thinking,
        content: assist.content,
      })
      // Drop completed snapshot so the next send cannot briefly re-show this turn.
      synopsisConversationStreamHub.clear(input.projectId)
      return {
        session: updatedSession,
        messages: [...messages],
        ...(pendingProposals.length === 0 ? {} : { pendingProposals: [...pendingProposals] }),
        ...(pendingStagingPromotes.length === 0
          ? {}
          : { pendingStagingPromotes: [...pendingStagingPromotes] }),
      }
    } catch (error) {
      synopsisConversationStreamHub.fail(
        input.projectId,
        error instanceof Error ? error.message : String(error),
        this.dependencies.now(),
      )
      throw error
    }
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
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<SynopsisConversationSendResult> {
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
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
    const activeGoals = goalsSnapshot.goals.filter((goal) => goal.lifecycle === "active")
    const chapterProgress = goalsSnapshot.progress.filter(
      (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
    )
    await this.dependencies.conversation.appendMessage({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "user",
      content: refreshPrompt,
      hidden: true,
      createdAtMs: nowMs,
    })
    const assist = await this.runSynopsisDiscuss({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      sessionId: session.sessionId,
      userMessage: refreshPrompt,
      heading: session.title,
      chapterSequence: session.chapterSequence,
      synopsisMarkdown,
      userEditedSinceAgent,
      conversationHistory: priorMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      })),
      activeGoals,
      chapterProgress,
      model: input.model,
      ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
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
    return {
      session: updatedSession,
      messages: [...messages],
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
    const reconcile = await this.dependencies.goals.reconcileForTurn({
      projectId: input.projectId,
      chapterSequence: resolved.chapterSequence,
      synopsisMarkdown: resolved.userInput,
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
    if (reconcile.blocking.length > 0 && input.forceOverride !== true) {
      throw new SynopsisInvalidStateError(
        `推演目标与梗概存在冲突，无法开始推演：${reconcile.blocking.map((issue) => issue.message).join("；")}`,
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

  private async ensureActiveSession(projectId: ProjectId, workspaceRootRef: string) {
    const active = await this.dependencies.conversation.findActiveSession(projectId)
    if (active !== undefined) return active
    const started = await this.start({ projectId, workspaceRootRef })
    return started.session
  }

  private async resolveBootstrapInput(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>,
  ): Promise<SynopsisResolveTurnInputResult> {
    const fileExists = await this.synopsisFileExists(workspaceRootRef, session.synopsisPath)
    if (fileExists) {
      const userInput = await this.readSynopsisFile(workspaceRootRef, session.synopsisPath)
      if (userInput.trim().length > 0) {
        return {
          chapterSequence: session.chapterSequence,
          userInput,
          source: "synopsis_file",
          synopsisPath: session.synopsisPath,
        }
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
    throw new SynopsisInvalidStateError("梗概文件与对话均为空，请先讨论剧情梗概后再开始推演")
  }

  private async runSynopsisDiscuss(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    sessionId: string
    userMessage: string
    heading: string
    chapterSequence: number
    synopsisMarkdown: string
    userEditedSinceAgent: boolean
    conversationHistory: readonly Readonly<{ role: "user" | "assistant"; content: string }>[]
    activeGoals: readonly Readonly<{ goalId: string; content: string; lifecycle: "active" | "completed" | "removed" }>[]
    chapterProgress: readonly Readonly<{ goalId: string; chapterSequence: number; summary: string; status: "planned" | "achieved" | "partial" | "missed" | "superseded" }>[]
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    discussTrigger?: "user" | "turn_handoff"
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<Readonly<{
    content: string
    reasoningContent?: string
    chapterTitle?: string
    synopsisBody?: string
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
    arcPlanMarkdown?: string
  }>> {
    const basePhasePrompt = await this.dependencies.prompts.loadPhase("synopsis_discuss")
    const intentAppendix = chapterNarrativeIntentPhaseAppendix(input.chapterIntent, "synopsis_discuss")
    const phasePrompt = intentAppendix === undefined
      ? basePhasePrompt
      : {
          ...basePhasePrompt,
          text: `${basePhasePrompt.text}\n\n${intentAppendix}`,
          digest: digest(`${basePhasePrompt.text}\n\n${intentAppendix}`),
        }
    const systemRules = await this.dependencies.prompts.loadSynopsisDiscussSystemRules()
    const turnMonitor = this.dependencies.readTurnMonitor === undefined
      ? undefined
      : await this.dependencies.readTurnMonitor()
    const discussTrigger = input.discussTrigger ?? "user"
    const settings = this.dependencies.readProjectSettings === undefined
      ? undefined
      : await this.dependencies.readProjectSettings()
    const nowMs = this.dependencies.now()
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 600_000)
    const maxRetrievalRounds = settings?.execution.maxRetrievalRounds
      ?? defaultProjectSettings.execution.maxRetrievalRounds
    const maxModelCalls = Math.max(
      input.maxModelCalls ?? (maxRetrievalRounds + 1),
      maxRetrievalRounds + 1,
    )
    const catalog = await this.dependencies.catalog.createSnapshot({
      snapshotId: this.dependencies.createId(),
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      generatedAtMs: nowMs,
    })
    let readEvidence: TurnReadEvidence[] = [...await this.bootstrapSynopsisEvidence({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      catalog,
    })]
    let retrievalGaps: TurnRetrievalGap[] = []
    let remainingCalls = maxModelCalls
    let accumulatedReasoning = ""
    let attempt = 0
    let missingArtifactRetries = 0
    const repairHints: string[] = []

    for (;;) {
      if (this.dependencies.now() >= deadlineAtMs) {
        throw new SynopsisInvalidStateError("梗概讨论超时：检索与模型调用未在截止前完成")
      }
      if (remainingCalls <= 0) {
        throw new SynopsisInvalidStateError("梗概讨论模型调用预算已耗尽")
      }
      const request = phaseRequestEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        envelopeId: this.dependencies.createId(),
        projectId: input.projectId,
        taskId: input.sessionId,
        turnId: this.dependencies.createId(),
        contextId: this.dependencies.createId(),
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
          allowWorkspaceChapterReads: false,
          sourceUnitIds: [],
          phaseRunIds: [],
          readEvidence,
          retrievalGaps,
          workspaceCatalog: catalog,
          ...(settings === undefined ? {} : { projectSettings: settings }),
          artifacts: {},
          synopsisDiscuss: {
            heading: input.heading,
            chapterSequence: input.chapterSequence,
            synopsisMarkdown: input.synopsisMarkdown,
            userEditedSinceAgent: input.userEditedSinceAgent,
            conversationHistory: input.conversationHistory,
            activeGoals: input.activeGoals.map((goal) => ({
              goalId: goal.goalId,
              content: goal.content,
              lifecycle: goal.lifecycle,
            })),
            chapterProgress: input.chapterProgress.map((item) => ({
              goalId: item.goalId,
              chapterSequence: item.chapterSequence,
              summary: item.summary,
              status: item.status,
            })),
            discussTrigger,
            ...(turnMonitor === undefined ? {} : { turnMonitor }),
          },
        },
      })
      const contextMessages = [
        {
          messageId: this.dependencies.createId(),
          sequence: 0,
          role: "system" as const,
          kind: "system_rules" as const,
          content: systemRules.text,
        },
        ...(attempt > 0 || readEvidence.length > 0
          ? [{
              messageId: this.dependencies.createId(),
              sequence: 1,
              role: "system" as const,
              kind: "system_rules" as const,
              content: [
                "创作台 ReAct 提醒：",
                `- 当前已可见 readEvidence ${String(readEvidence.length)} 条；优先基于这些证据给出正式结论。`,
                "- 若仍缺文件，使用 outcome=request_read；否则必须 outcome=continue，且 artifact 为对象，至少含 assistantMessage 与 finalSelfReview。",
                "- 禁止把「我先去读设定/索引」写进 assistantMessage 当作最终回复。",
                ...repairHints.slice(-2),
              ].join("\n"),
            }]
          : []),
      ]
      let streamedReasoning = ""
      let streamedContent = ""
      let execution
      try {
        execution = await input.model.execute(request, {
          phasePrompt,
          forceThinking: true,
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
        throw error
      }
      remainingCalls = Math.max(0, remainingCalls - Math.max(1, execution.usage.modelCalls ?? 1))
      const parsedResult = phaseResultEnvelopeSchema.parse(execution.result)
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
      if (parsedResult.outcome !== "request_read" || requestedReads.length === 0) {
        const artifact = synopsisDiscussArtifactSchema.safeParse(parsedResult.artifact)
        if (!artifact.success) {
          if (missingArtifactRetries < 2 && remainingCalls > 0) {
            missingArtifactRetries += 1
            repairHints.push(
              "上一轮缺少合法 artifact。请 outcome=continue 并返回完整 artifact（assistantMessage、finalSelfReview 必填）。",
            )
            attempt += 1
            continue
          }
          throw new SynopsisInvalidStateError(
            "模型未返回完整讨论结果（缺少 artifact）。请重试发送。",
          )
        }
        synopsisConversationStreamHub.setContent(input.projectId, artifact.data.assistantMessage, this.dependencies.now())
        return {
          content: artifact.data.assistantMessage,
          ...(accumulatedReasoning.length === 0 ? {} : { reasoningContent: accumulatedReasoning }),
          ...(artifact.data.chapterTitle === undefined ? {} : { chapterTitle: artifact.data.chapterTitle }),
          ...(artifact.data.synopsisBody === undefined ? {} : { synopsisBody: artifact.data.synopsisBody }),
          ...(artifact.data.choices === undefined ? {} : { choices: artifact.data.choices }),
          ...(artifact.data.stagingDelta === undefined
            ? {}
            : { stagingDelta: mapSynopsisStagingDelta(artifact.data.stagingDelta) }),
          ...(artifact.data.stagingPromote === undefined
            ? {}
            : { stagingPromote: mapSynopsisStagingPromote(artifact.data.stagingPromote) }),
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
        }
      }

      if (attempt >= maxRetrievalRounds) {
        runtimeLog("warn", "synopsis-conversation", "retrieval.exhausted", {
          projectId: input.projectId,
          sessionId: input.sessionId,
          attempt,
          requestedReadCount: requestedReads.length,
        })
        const artifact = synopsisDiscussArtifactSchema.safeParse(parsedResult.artifact)
        if (artifact.success) {
          synopsisConversationStreamHub.setContent(input.projectId, artifact.data.assistantMessage, this.dependencies.now())
          return {
            content: artifact.data.assistantMessage,
            ...(accumulatedReasoning.length === 0 ? {} : { reasoningContent: accumulatedReasoning }),
            ...(artifact.data.chapterTitle === undefined ? {} : { chapterTitle: artifact.data.chapterTitle }),
            ...(artifact.data.synopsisBody === undefined ? {} : { synopsisBody: artifact.data.synopsisBody }),
            ...(artifact.data.choices === undefined ? {} : { choices: artifact.data.choices }),
            ...(artifact.data.stagingDelta === undefined
              ? {}
              : { stagingDelta: mapSynopsisStagingDelta(artifact.data.stagingDelta) }),
            ...(artifact.data.stagingPromote === undefined
              ? {}
              : { stagingPromote: mapSynopsisStagingPromote(artifact.data.stagingPromote) }),
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
          }
        }
        throw new SynopsisInvalidStateError("梗概讨论检索轮次已耗尽，且模型未给出正式回复")
      }

      for (const read of requestedReads) {
        const label = formatSynopsisSearchLabel(read)
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: label,
          status: "running",
        }, this.dependencies.now())
      }

      const webReads = requestedReads.filter((read) => read.query.sourceKinds.includes("web"))
      if (webReads.length > 0) {
        await this.fulfillSynopsisWebReads(input.projectId, webReads, settings)
      }

      const workspaceEvidence = await executeSynopsisWorkspaceReads({
        workspace: this.dependencies.workspace,
        workspaceRootRef: input.workspaceRootRef,
        catalog,
        requests: requestedReads,
        existingEvidence: readEvidence,
        createId: this.dependencies.createId,
        maxCandidates: settings?.retrieval.maxCandidates ?? defaultProjectSettings.retrieval.maxCandidates,
        maxRequestsPerRound: settings?.retrieval.maxRequestsPerRound
          ?? defaultProjectSettings.retrieval.maxRequestsPerRound,
        allowWorkspaceChapterReads: false,
      })
      readEvidence = [...readEvidence, ...workspaceEvidence]

      for (const read of requestedReads) {
        const label = formatSynopsisSearchLabel(read)
        const matched = workspaceEvidence.filter((item) => {
          const path = item.ownerId.toLocaleLowerCase()
          const terms = [...read.query.exactKeys, ...read.query.semanticTexts]
            .map((term) => term.trim().toLocaleLowerCase())
            .filter((term) => term.length > 0)
          if (terms.length === 0) return true
          return terms.some((term) => path === term || path.includes(term) || path.split("/").at(-1) === term)
        })
        const summary = matched.length === 0
          ? (read.query.sourceKinds.includes("web") ? "已尝试联网查询" : "未命中工作区文件")
          : matched.map((item) => `${item.ownerId}（${item.semanticText.length} 字）`).join("\n")
        synopsisConversationStreamHub.upsertSearch(input.projectId, {
          query: label,
          status: matched.length === 0 && !read.query.sourceKinds.includes("web") ? "failed" : "completed",
          resultSummary: summary,
        }, this.dependencies.now())
      }

      if (workspaceEvidence.length === 0 && webReads.length === 0) {
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
        newEvidenceCount: workspaceEvidence.length,
        totalEvidenceCount: readEvidence.length,
      })
      attempt += 1
    }
  }

  private async bootstrapSynopsisEvidence(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    catalog: WorkspaceCatalogSnapshot
  }>): Promise<readonly TurnReadEvidence[]> {
    const bootstrapRequest = {
      requestId: this.dependencies.createId(),
      reason: "Bootstrap settings and reference indexes for synopsis discuss",
      expectedEvidence: "设定集与参考文件索引",
      query: {
        exactKeys: ["设定集/readme.md", "参考文件/readme.md"],
        semanticTexts: ["设定集索引", "参考文件索引"],
        anchorIds: [] as string[],
        directions: ["both" as const],
        maxCandidates: 4,
        maxDepth: 1,
        sourceKinds: ["reference" as const],
      },
    }
    const label = formatSynopsisSearchLabel(bootstrapRequest)
    synopsisConversationStreamHub.upsertSearch(input.projectId, {
      query: label,
      status: "running",
    }, this.dependencies.now())
    try {
      const evidence = await executeSynopsisWorkspaceReads({
        workspace: this.dependencies.workspace,
        workspaceRootRef: input.workspaceRootRef,
        catalog: input.catalog,
        requests: [bootstrapRequest],
        existingEvidence: [],
        createId: this.dependencies.createId,
        maxCandidates: 4,
        maxRequestsPerRound: 1,
        allowWorkspaceChapterReads: false,
      })
      synopsisConversationStreamHub.upsertSearch(input.projectId, {
        query: label,
        status: evidence.length === 0 ? "failed" : "completed",
        resultSummary: evidence.length === 0
          ? "未找到设定集/参考索引"
          : evidence.map((item) => `${item.ownerId}（${item.semanticText.length} 字）`).join("\n"),
      }, this.dependencies.now())
      return evidence
    } catch (error) {
      synopsisConversationStreamHub.upsertSearch(input.projectId, {
        query: label,
        status: "failed",
        resultSummary: error instanceof Error ? error.message : String(error),
      }, this.dependencies.now())
      return []
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
  }>): Promise<void> {
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
    for (const [relativePath, entries] of Object.entries(evicted.files)) {
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        relativePath,
        serializeStagingEntries(stagingFileTitle(relativePath), entries),
      )
    }
  }

  private async fulfillSynopsisWebReads(
    projectId: ProjectId,
    requests: PhaseResultEnvelope["requestedReads"],
    settings: ProjectSettings | undefined,
  ): Promise<void> {
    const port = this.dependencies.webResearch
    if (port === undefined) return
    if (settings !== undefined && !settings.retrieval.webResearchEnabled) return
    for (const request of requests) {
      const query = [...request.query.exactKeys, ...request.query.semanticTexts]
        .map((term) => term.trim())
        .find((term) => term.length > 0)
        ?? request.expectedEvidence.slice(0, 200)
      if (query.length === 0) continue
      const label = `web: ${query}`
      synopsisConversationStreamHub.upsertSearch(projectId, { query: label, status: "running" }, this.dependencies.now())
      try {
        const maxResults = Math.min(
          request.query.maxCandidates,
          settings?.retrieval.maxWebResults ?? defaultProjectSettings.retrieval.maxWebResults,
        )
        const hits = await port.search({
          query,
          maxResults,
          signal: AbortSignal.timeout(8_000),
        })
        synopsisConversationStreamHub.upsertSearch(projectId, {
          query: label,
          status: hits.length === 0 ? "failed" : "completed",
          resultSummary: hits.length === 0
            ? "未找到可用公开资料"
            : hits.map((hit, index) => `${String(index + 1)}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n"),
        }, this.dependencies.now())
      } catch (error) {
        synopsisConversationStreamHub.upsertSearch(projectId, {
          query: label,
          status: "failed",
          resultSummary: error instanceof Error ? error.message : String(error),
        }, this.dependencies.now())
      }
    }
  }

  private async findExistingSynopsisForSequence(
    workspaceRootRef: string,
    chapterSequence: number,
  ): Promise<Readonly<{ path: string; title?: string }> | undefined> {
    const report = await this.dependencies.workspace.validate(workspaceRootRef)
    const matches = report.inventory
      .filter((entry) => entry.kind === "file")
      .map((entry) => {
        const parsed = parseSynopsisMarkdownPath(entry.path)
        if (parsed?.sequence !== chapterSequence) return undefined
        return {
          path: entry.path,
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
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
    if (input.runAutoAnalysis === false) return

    const priorMessages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
    const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
    const activeGoals = goalsSnapshot.goals.filter((goal) => goal.lifecycle === "active")
    const chapterProgress = goalsSnapshot.progress.filter(
      (item) => item.chapterSequence === session.chapterSequence && item.status !== "superseded",
    )
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
      userEditedSinceAgent: false,
      conversationHistory: priorMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      })),
      activeGoals,
      chapterProgress,
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
  }

  private async readSynopsisFile(workspaceRootRef: string, synopsisPath: string): Promise<string> {
    try {
      return await this.dependencies.workspace.readMarkdown(workspaceRootRef, synopsisPath)
    } catch {
      return ""
    }
  }

  private async synopsisFileExists(workspaceRootRef: string, synopsisPath: string): Promise<boolean> {
    const content = await this.readSynopsisFile(workspaceRootRef, synopsisPath)
    return content.length > 0
  }
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
    "2. 仍用 choices 返回可点选按钮；方向类用 continue_discuss，结构性动作（如 confirm_arc_plan / start_turn / promote_staging）仅在仍适用时保留。",
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
