import {
  phaseRequestEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ChapterRevision,
  type ChapterRevisionConversationListResult,
  type ChapterRevisionConversationSendResult,
  type ProjectId,
} from "@worldseed/contracts"
import { revisionAssistArtifactSchema } from "@worldseed/prompt-contracts"

import type { AIModelPort, PromptResourcePort } from "../turns/ports/ai-model-port.js"
import { RevisionConflictError, RevisionInvalidStateError, type ChapterRevisionService } from "./chapter-revision-service.js"
import type { SqliteRevisionConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-revision-conversation-repository.js"
import type { ChapterRevisionRepository } from "./ports/chapter-revision-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"

export type ChapterRevisionConversationServiceDependencies = Readonly<{
  chapters: ChapterRevisionService
  revisions: ChapterRevisionRepository
  conversation: SqliteRevisionConversationRepository
  prompts: PromptResourcePort
  createId: () => string
  now: () => number
}>

export class ChapterRevisionConversationService {
  public constructor(private readonly dependencies: ChapterRevisionConversationServiceDependencies) {}

  public async list(projectId: ProjectId, chapterId: string): Promise<ChapterRevisionConversationListResult> {
    const revision = await this.findAgentRevision(projectId, chapterId)
    if (revision === undefined) return { messages: [] }
    const messages = await this.dependencies.conversation.listByRevision(revision.revisionTaskId)
    return { revisionTaskId: revision.revisionTaskId, messages: [...messages] }
  }

  public async send(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterId: string
    message: string
    model: AIModelPort
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<ChapterRevisionConversationSendResult> {
    const committed = await this.dependencies.chapters.read(input.projectId, input.chapterId)
    const revision = await this.ensureAgentRevision({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      chapterId: input.chapterId,
      baseSourceId: committed.sourceId,
      heading: committed.heading,
      body: committed.body,
    })
    const revisionDetail = await this.dependencies.chapters.readRevision(revision.revisionTaskId)
    const storedRevision = await this.dependencies.revisions.find(revision.revisionTaskId)
    const priorMessages = await this.dependencies.conversation.listByRevision(revision.revisionTaskId)
    const nowMs = this.dependencies.now()
    await this.dependencies.conversation.append({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      revisionTaskId: revision.revisionTaskId,
      role: "user",
      content: input.message,
      createdAtMs: nowMs,
    })
    const assist = await this.runRevisionAssist({
      projectId: input.projectId,
      revisionTaskId: revision.revisionTaskId,
      scopeId: storedRevision?.contentScopeId ?? revision.revisionTaskId,
      userMessage: input.message,
      heading: revisionDetail.heading,
      committed,
      workingBody: revisionDetail.proposedBody,
      conversationHistory: priorMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      })),
      model: input.model,
      ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }),
      ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    })
    await this.dependencies.conversation.append({
      messageId: this.dependencies.createId(),
      projectId: input.projectId,
      revisionTaskId: revision.revisionTaskId,
      role: "assistant",
      content: assist.content,
      proposal: assist.proposal,
      createdAtMs: nowMs + 1,
    })
    const messages = await this.dependencies.conversation.listByRevision(revision.revisionTaskId)
    runtimeLog("debug", "chapter-revision-conversation", "sent", {
      projectId: input.projectId,
      chapterId: input.chapterId,
      revisionTaskId: revision.revisionTaskId,
      messageCount: messages.length,
    })
    return { revision, messages: [...messages] }
  }

  public async apply(input: Readonly<{
    projectId: ProjectId
    revisionTaskId: string
    messageId: string
  }>): Promise<ChapterRevision> {
    const message = await this.dependencies.conversation.findMessage(input.messageId)
    if (message === undefined || message.revisionTaskId !== input.revisionTaskId) {
      throw new RevisionInvalidStateError("Conversation message not found for this revision")
    }
    if (message.proposal === undefined) {
      throw new RevisionInvalidStateError("This message does not contain an applicable draft")
    }
    const revision = await this.dependencies.revisions.find(input.revisionTaskId)
    if (revision === undefined || revision.projectId !== input.projectId) {
      throw new RevisionInvalidStateError("Chapter revision not found")
    }
    const heading = message.proposal.heading ?? revision.heading
    const updated = await this.dependencies.chapters.update(
      input.revisionTaskId,
      heading,
      message.proposal.body,
    )
    runtimeLog("debug", "chapter-revision-conversation", "applied", {
      projectId: input.projectId,
      revisionTaskId: input.revisionTaskId,
      messageId: input.messageId,
    })
    return updated
  }

  private async runRevisionAssist(input: Readonly<{
    projectId: ProjectId
    revisionTaskId: string
    scopeId: string
    userMessage: string
    heading: string
    committed: Awaited<ReturnType<ChapterRevisionService["read"]>>
    workingBody: string
    conversationHistory: readonly Readonly<{ role: "user" | "assistant"; content: string }>[]
    model: AIModelPort
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<Readonly<{ content: string; proposal: { heading: string; body: string } }>> {
    const phasePrompt = await this.dependencies.prompts.loadPhase("revision_assist")
    const nowMs = this.dependencies.now()
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 600_000)
    const request = phaseRequestEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      envelopeId: this.dependencies.createId(),
      projectId: input.projectId,
      taskId: input.revisionTaskId,
      turnId: this.dependencies.createId(),
      contextId: this.dependencies.createId(),
      scopeId: input.scopeId,
      phase: "revision_assist",
      protocolVersion: PROTOCOL_VERSION,
      promptRef: phasePrompt.ref,
      promptDigest: phasePrompt.digest,
      contextViewRef: `chapter-revision-assist:${input.revisionTaskId}`,
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: createAssistBudget(input.maxModelCalls ?? 1, deadlineAtMs),
      input: {
        workflow: "revision",
        userInput: input.userMessage,
        chapterSequence: 0,
        allowWorkspaceChapterReads: false,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
        revision: {
          chapterId: input.committed.chapterId,
          baseSourceId: input.committed.sourceId,
          proposedSourceId: input.committed.sourceId,
          baseContent: input.committed.content,
          proposedContent: input.committed.content,
        },
        revisionAssist: {
          chapterId: input.committed.chapterId,
          heading: input.heading,
          committedBody: input.committed.body,
          workingBody: input.workingBody,
          conversationHistory: input.conversationHistory,
        },
      },
    })
    const execution = await input.model.execute(request)
    const artifact = revisionAssistArtifactSchema.parse(execution.result.artifact)
    const proposedHeading = artifact.proposedHeading ?? input.heading
    return {
      content: artifact.assistantMessage,
      proposal: { heading: proposedHeading, body: artifact.proposedBody },
    }
  }

  private async ensureAgentRevision(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterId: string
    baseSourceId: string
    heading: string
    body: string
  }>): Promise<ChapterRevision> {
    const active = await this.dependencies.revisions.findActiveForChapter(input.projectId, input.chapterId)
    if (active !== undefined) {
      if (active.inputMode === "agent") {
        return this.dependencies.chapters.readRevision(active.revisionTaskId)
      }
      throw new RevisionConflictError("请先完成或放弃当前直接修订，再使用章节对话")
    }
    return this.dependencies.chapters.start({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      chapterId: input.chapterId,
      baseSourceId: input.baseSourceId,
      heading: input.heading,
      body: input.body,
      inputMode: "agent",
    })
  }

  private async findAgentRevision(projectId: ProjectId, chapterId: string) {
    const active = await this.dependencies.revisions.findActiveForChapter(projectId, chapterId)
    if (active === undefined || active.inputMode !== "agent") return undefined
    return active
  }
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
