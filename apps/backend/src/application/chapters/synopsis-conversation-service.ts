import {
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ProjectId,
  type ProjectSettings,
  type ChapterNarrativeIntent,
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
  selectGoalsForChapterContext,
} from "@worldseed/contracts"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"
import { defaultProjectSettings } from "@worldseed/config"

import {
  assembleSynopsisPlaceholderDocument,
  assertUniqueVolumeSequence,
  DEFAULT_VOLUME_FOLDER_NAME,
  deriveOutlineMarkdownPath,
  deriveSynopsisMarkdownPath,
  deriveVolumeDirectoryPath,
  extractSynopsisTitleFromDocument,
  extractVolumeFolderNameFromPath,
  formatChapterSequenceLabel,
  digest,
  pickPreferredVolumeFolderName,
  remapPathVolumeFolder,
  siblingPlanningMarkdownPath,
  validateSynopsisMarkdownPath,
  validateVolumeFolderName,
  assertWorkspaceMutationAllowed,
} from "../../core/index.js"
import type { GoalProposalPayload } from "@worldseed/contracts"
import type { AIModelPort, PromptResourcePort, TurnReadEvidence, TurnRetrievalGap } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort, InternalStorePort } from "../workspace/index.js"
import type { WorkspaceCatalogPort } from "../retrieval/ports/workspace-catalog.js"
import type { WebResearchPort } from "../retrieval/ports/web-research-port.js"
import type { ChapterResolveService } from "./chapter-resolve-service.js"
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
import { normalizeThinkingDisplayText } from "./synopsis-thinking-text.js"
import { applySearchReplace } from "./markdown-search-replace.js"
import {
  executeSynopsisWebReads,
} from "./synopsis-web-reads.js"
import {
  executeSynopsisWorkspaceReads,
  formatSynopsisSearchLabel,
  isPresentationRuleMarkdownPath,
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

export type SynopsisConversationServiceDependencies = Readonly<{
  chapters: ChapterResolveService
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
    const maxSessionSequence = await this.dependencies.conversation.maxChapterSequence(input.projectId)
    const chapterSequence = Math.max(fromIndex, (maxSessionSequence ?? 0) + 1)
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

  public peekStream(projectId: ProjectId, sessionId?: string): SynopsisConversationStreamSnapshot {
    const snapshot = synopsisConversationStreamHub.peek(projectId, sessionId)
    const budgetAdvisory = peekSynopsisModelBudgetAdvisory(projectId)
    return budgetAdvisory === undefined
      ? snapshot
      : { ...snapshot, budgetAdvisory }
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
  }>): Promise<SynopsisConversationSendResult> {
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
    clearSynopsisSendCancellation(input.projectId)
    await this.hydrateDiscussUsage(input.projectId)
    // Reset stream hub before any further awaits so concurrent streamPeek cannot
    // resurface the previous turn's completed thinking/content.
    const streamStartedAtMs = this.dependencies.now()
    synopsisConversationStreamHub.begin(input.projectId, session.sessionId, streamStartedAtMs)
    try {
      const priorMessages = await this.dependencies.conversation.listMessages(session.sessionId)
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
      const assist = await this.runSynopsisDiscuss({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        sessionId: session.sessionId,
        userMessage: input.message,
        heading: session.title,
        chapterSequence: session.chapterSequence,
        synopsisMarkdown,
        outlineMarkdown,
        ...(outlineDigest === undefined ? {} : { outlineDigest }),
        userEditedSinceAgent,
        userEditedOutlineSinceAgent,
        synopsisConfirmed,
        ...(currentWorkDisplayName === undefined ? {} : { currentWorkDisplayName }),
        conversationHistory: priorMessages.map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: message.content,
        })),
        activeGoals,
        chapterProgress,
        model: input.model,
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

      const outlineWriteAllowed = synopsisConfirmed || confirmingSynopsis
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

      if (wroteSynopsisBody && !confirmingSynopsis) {
        nextSynopsisConfirmedAtMs = undefined
      }
      if (confirmingSynopsis) {
        nextSynopsisConfirmedAtMs = nextSynopsisConfirmedAtMs ?? nowMs
      }

      if (volumeCleanupFolder !== undefined) {
        await this.tryRemoveEmptyVolumeDirectory(input.workspaceRootRef, volumeCleanupFolder)
      }

      const assistantContent = writeNotices.length === 0
        ? assist.content
        : `${assist.content}\n\n——\n${writeNotices.join("\n")}`
      const assistantMessageId = this.dependencies.createId()
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
        ...(assist.choices === undefined ? {} : { choices: assist.choices }),
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
        await this.dependencies.goals.approveProposals({
          projectId: input.projectId,
          proposalIds: createdProposals.map((proposal) => proposal.proposalId),
        })
        pendingProposals = []
      }
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
        ...(lastOutlineAgentDigest === undefined ? {} : { lastOutlineAgentDigest }),
        synopsisConfirmedAtMs: nextSynopsisConfirmedAtMs === undefined ? null : nextSynopsisConfirmedAtMs,
        updatedAtMs: nowMs + 1,
      })
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
      }
    } catch (error) {
      if (error instanceof SynopsisSendCancelledError || isSynopsisSendCancelled(input.projectId)) {
        synopsisConversationStreamHub.clear(input.projectId)
        clearSynopsisSendCancellation(input.projectId)
        throw error instanceof SynopsisSendCancelledError ? error : new SynopsisSendCancelledError()
      }
      synopsisConversationStreamHub.fail(
        input.projectId,
        error instanceof Error ? error.message : String(error),
        this.dependencies.now(),
      )
      throw error
    }
  }

  /**
   * Stop an in-flight / timed-out user turn: remove the last visible user message and
   * any following messages from conversation context, and cancel an active send.
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
      await this.dependencies.conversation.deleteLastVisibleUserTurn(session.sessionId)
    }
    synopsisConversationStreamHub.fail(input.projectId, "用户停止对话", this.dependencies.now())
    synopsisConversationStreamHub.clear(input.projectId)
    return this.list({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
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
      ...(outlineDigest === undefined ? {} : { outlineDigest }),
      userEditedSinceAgent,
      userEditedOutlineSinceAgent,
      synopsisConfirmed: session.synopsisConfirmedAtMs !== undefined,
      conversationHistory: priorMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      })),
      activeGoals,
      chapterProgress,
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
    outlineDigest?: string
    userEditedSinceAgent: boolean
    userEditedOutlineSinceAgent: boolean
    currentWorkDisplayName?: string
    synopsisConfirmed?: boolean
    conversationHistory: readonly Readonly<{ role: "user" | "assistant"; content: string }>[]
    activeGoals: readonly DeductionGoal[]
    chapterProgress: readonly Readonly<{ goalId: string; chapterSequence: number; summary: string; status: "planned" | "achieved" | "partial" | "missed" | "superseded" }>[]
    model: AIModelPort
    chapterIntent?: ChapterNarrativeIntent
    presentation?: Readonly<{
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    }>
    discussTrigger?: "user" | "turn_handoff"
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<Readonly<{
    content: string
    reasoningContent?: string
    chapterTitle?: string
    volumeFolderName?: string
    workDisplayName?: string
    synopsisBody?: string
    outlineBody?: string
    bodyEdits?: Readonly<{
      target: "outline"
      baseDigest?: string
      ops: readonly Readonly<{ oldText: string; newText: string }>[]
    }>
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
    const appendix = [intentAppendix, presentationAppendix].filter((part): part is string => part !== undefined)
    const phasePrompt = appendix.length === 0
      ? basePhasePrompt
      : {
          ...basePhasePrompt,
          text: `${basePhasePrompt.text}\n\n${appendix.join("\n\n")}`,
          digest: digest(`${basePhasePrompt.text}\n\n${appendix.join("\n\n")}`),
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
      input.maxModelCalls ?? (maxRetrievalRounds + 3),
      maxRetrievalRounds + 3,
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
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    })]
    let retrievalGaps: TurnRetrievalGap[] = []
    let remainingCalls = maxModelCalls
    let budgetGraceUsed = false
    let accumulatedReasoning = ""
    let attempt = 0
    let missingArtifactRetries = 0
    const repairHints: string[] = []
    if (input.synopsisConfirmed !== true) {
      repairHints.push(
        "当前梗概尚未经用户确认：禁止输出 outlineBody；戏核收窄后须同屏给出「用这份梗概写细纲」(confirm_synopsis)、「再改梗概」、可选「跳过细纲，按梗概开推」(start_turn)。",
      )
    } else if (isConfirmSynopsisUserMessage(input.userMessage)) {
      repairHints.push(
        "用户已选择用这份梗概写细纲：本轮应输出合格 outlineBody（引导 §4.1：必填章定位/分场/信息边界/风险待决；不适用节写「本节：无」；须含相对梗概的增量，禁止同构扩写），不要只改梗概；本轮不要再给 start_turn。",
      )
    }
    let latestBudgetAdvisory: SynopsisConversationBudgetAdvisory | undefined

    for (;;) {
      if (this.dependencies.now() >= deadlineAtMs) {
        throw new SynopsisInvalidStateError("梗概讨论超时：检索与模型调用未在截止前完成")
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
          ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
          ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
          artifacts: {},
          synopsisDiscuss: {
            heading: input.heading,
            chapterSequence: input.chapterSequence,
            synopsisMarkdown: input.synopsisMarkdown,
            outlineMarkdown: input.outlineMarkdown,
            ...(input.outlineDigest === undefined ? {} : { outlineDigest: input.outlineDigest }),
            userEditedSinceAgent: input.userEditedSinceAgent,
            userEditedOutlineSinceAgent: input.userEditedOutlineSinceAgent,
            synopsisConfirmed: input.synopsisConfirmed === true,
            ...(input.currentWorkDisplayName === undefined
              ? {}
              : { currentWorkDisplayName: input.currentWorkDisplayName }),
            conversationHistory: input.conversationHistory,
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
      const thinkingRound = attempt + 1
      synopsisConversationStreamHub.beginThinkingRound(input.projectId, thinkingRound, this.dependencies.now())
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
        synopsisConversationStreamHub.complete(input.projectId, this.dependencies.now(), {
          ...(accumulatedReasoning.length === 0 ? {} : { thinking: accumulatedReasoning }),
          content: artifact.data.assistantMessage,
        })
        return finalizeDiscussReturn(input.projectId, latestBudgetAdvisory, {
          content: artifact.data.assistantMessage,
          ...(accumulatedReasoning.length === 0 ? {} : { reasoningContent: accumulatedReasoning }),
          ...(artifact.data.chapterTitle === undefined ? {} : { chapterTitle: artifact.data.chapterTitle }),
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
          allowWorkspaceChapterReads: false,
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
    const bootstrapPaths = ["设定集/readme.md", "参考文件/readme.md"]
    const presentationPaths = [
      input.presentation?.descriptionRulePath,
      input.presentation?.proseStyleRulePath,
    ]
      .map((path) => path?.trim())
      .filter((path): path is string => path !== undefined && path.length > 0 && isPresentationRuleMarkdownPath(path))
    const bootstrapRequest = {
      requestId: this.dependencies.createId(),
      reason: "Bootstrap settings, reference indexes, and selected presentation rules for synopsis discuss",
      expectedEvidence: "设定集/参考索引与本轮描写笔风规则",
      query: {
        exactKeys: [...bootstrapPaths, ...presentationPaths],
        semanticTexts: ["设定集索引", "参考文件索引", ...presentationPaths],
        anchorIds: [] as string[],
        directions: ["both" as const],
        maxCandidates: 8,
        maxDepth: 1,
        sourceKinds: presentationPaths.length === 0
          ? ["reference" as const]
          : ["reference" as const, "rule" as const],
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
        maxCandidates: 8,
        maxRequestsPerRound: 1,
        allowWorkspaceChapterReads: false,
      })
      synopsisConversationStreamHub.upsertSearch(input.projectId, {
        query: label,
        status: evidence.length === 0 ? "failed" : "completed",
        round: 0,
        resultSummary: evidence.length === 0
          ? "未找到设定集/参考索引"
          : evidence.map((item) => `${item.ownerId}（${item.semanticText.length} 字）`).join("\n"),
      }, this.dependencies.now())
      return evidence
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
    for (const write of input.writes) {
      const path = write.relativePath.trim().replace(/\\/gu, "/")
      if (!isPresentationRuleMarkdownPath(path)) {
        throw new SynopsisInvalidStateError(
          `表现规则写入路径非法（仅允许 表现输出/描写规则|笔风规则/*.md）：${write.relativePath}`,
        )
      }
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
    if (input.runAutoAnalysis === false) return

    const priorMessages = await this.dependencies.conversation.listMessagesForProject(input.projectId)
    const synopsisMarkdown = await this.readSynopsisFile(input.workspaceRootRef, session.synopsisPath)
    const outlinePathForHandoff = siblingPlanningMarkdownPath(session.synopsisPath, "outline")
      ?? deriveOutlineMarkdownPath(
        session.chapterSequence,
        session.title,
        extractVolumeFolderNameFromPath(session.synopsisPath) ?? DEFAULT_VOLUME_FOLDER_NAME,
      )
    const outlineMarkdown = await this.readSynopsisFile(input.workspaceRootRef, outlinePathForHandoff)
    const outlineDigest = outlineMarkdown.trim().length === 0 ? undefined : digest(outlineMarkdown)
    const userEditedOutlineSinceAgent = session.lastOutlineAgentDigest !== undefined
      && outlineDigest !== undefined
      && session.lastOutlineAgentDigest !== outlineDigest
    const goalsSnapshot = await this.dependencies.goals.list(input.projectId)
    const activeGoals = selectGoalsForChapterContext(goalsSnapshot.goals, session.chapterSequence)
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
      outlineMarkdown,
      ...(outlineDigest === undefined ? {} : { outlineDigest }),
      userEditedSinceAgent: false,
      userEditedOutlineSinceAgent,
      synopsisConfirmed: session.synopsisConfirmedAtMs !== undefined,
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
  const path = item.ownerId.toLocaleLowerCase()
  const terms = [...read.query.exactKeys, ...read.query.semanticTexts, ...(read.query.entityHints ?? [])]
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
  if (terms.length === 0) return true
  if (item.ownerKind.startsWith("web:")) {
    return terms.some((term) => path.includes(term)
      || item.exactKeys.some((key) => key.toLocaleLowerCase() === term))
  }
  return terms.some((term) => path === term || path.includes(term) || path.split("/").at(-1) === term
    || path.includes(`chapter-seq-${term}`) || path.includes(`as-of-${term}`))
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
    volumeFolderName?: string
    workDisplayName?: string
    synopsisBody?: string
    outlineBody?: string
    bodyEdits?: Readonly<{
      target: "outline"
      baseDigest?: string
      ops: readonly Readonly<{ oldText: string; newText: string }>[]
    }>
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
  volumeFolderName?: string
  workDisplayName?: string
  synopsisBody?: string
  outlineBody?: string
  bodyEdits?: Readonly<{
    target: "outline"
    baseDigest?: string
    ops: readonly Readonly<{ oldText: string; newText: string }>[]
  }>
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

/** User clicked confirm_synopsis or typed an equivalent confirmation. */
export function isConfirmSynopsisUserMessage(message: string): boolean {
  const text = message.trim()
  if (text.length === 0) return false
  return /用这份梗概写细纲/u.test(text)
    || /确认(?:本章)?梗概/u.test(text)
    || /开始写细纲/u.test(text)
    || /确认梗概[，,]?\s*开始写细纲/u.test(text)
}
