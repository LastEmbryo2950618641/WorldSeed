import {
  phaseRequestEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ProjectId,
  type SynopsisConversationListResult,
  type SynopsisConversationSendResult,
  type SynopsisConversationStartResult,
  type SynopsisResolveTurnInputResult,
} from "@worldseed/contracts"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"

import {
  assembleSynopsisPlaceholderDocument,
  deriveSynopsisMarkdownPath,
  extractSynopsisTitleFromDocument,
  formatChapterSequenceLabel,
  digest,
} from "../../core/index.js"
import type { GoalProposalPayload } from "@worldseed/contracts"
import type { AIModelPort, PromptResourcePort } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort } from "../workspace/index.js"
import type { ChapterResolveService } from "./chapter-resolve-service.js"
import type { DeductionGoalsService } from "./deduction-goals-service.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"

export class SynopsisInvalidStateError extends Error {}

export type SynopsisConversationServiceDependencies = Readonly<{
  chapters: ChapterResolveService
  conversation: SqliteSynopsisConversationRepository
  goals: DeductionGoalsService
  workspace: WorkspacePort
  prompts: PromptResourcePort
  createId: () => string
  now: () => number
}>

export class SynopsisConversationService {
  public constructor(private readonly dependencies: SynopsisConversationServiceDependencies) {}

  public async list(projectId: ProjectId): Promise<SynopsisConversationListResult> {
    const session = await this.dependencies.conversation.findActiveSession(projectId)
    if (session === undefined) return { messages: [] }
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    return { session, messages: [...messages] }
  }

  public async start(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    title?: string
  }>): Promise<SynopsisConversationStartResult> {
    const existing = await this.dependencies.conversation.findActiveSession(input.projectId)
    if (existing !== undefined) {
      const messages = await this.dependencies.conversation.listMessages(existing.sessionId)
      return { session: existing, messages: [...messages] }
    }
    const chapterSequence = await this.dependencies.chapters.nextChapterSequence(input.projectId)
    const title = input.title?.trim() ?? ""
    const synopsisPath = deriveSynopsisMarkdownPath(chapterSequence, title)
    const placeholder = assembleSynopsisPlaceholderDocument(chapterSequence, title)
    await this.dependencies.workspace.saveSynopsisMarkdown(input.workspaceRootRef, synopsisPath, placeholder)
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
    })
    return { session, messages: [] }
  }

  public async send(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    message: string
    model: AIModelPort
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<SynopsisConversationSendResult> {
    const session = await this.ensureActiveSession(input.projectId, input.workspaceRootRef)
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
    await this.dependencies.conversation.appendMessage({
      messageId: assistantMessageId,
      projectId: input.projectId,
      sessionId: session.sessionId,
      role: "assistant",
      content: assist.content,
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
    await this.dependencies.conversation.updateSession({
      sessionId: session.sessionId,
      synopsisPath,
      title: sessionTitle,
      ...(lastAgentDigest === undefined ? {} : { lastAgentDigest }),
      updatedAtMs: nowMs + 1,
    })
    const updatedSession = (await this.dependencies.conversation.findSession(session.sessionId)) as NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findSession"]>>>
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    return {
      session: updatedSession,
      messages: [...messages],
      ...(pendingProposals.length === 0 ? {} : { pendingProposals: [...pendingProposals] }),
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
    maxModelCalls?: number
    deadlineMs?: number
  }>): Promise<Readonly<{
    content: string
    chapterTitle?: string
    synopsisBody?: string
    choices?: SynopsisConversationSendResult["messages"][number]["choices"]
    goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
  }>> {
    const phasePrompt = await this.dependencies.prompts.loadPhase("synopsis_discuss")
    const nowMs = this.dependencies.now()
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 600_000)
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
      contextViewRef: `synopsis-discuss:${input.sessionId}`,
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: createAssistBudget(input.maxModelCalls ?? 1, deadlineAtMs),
      input: {
        workflow: "synopsis",
        userInput: input.userMessage,
        chapterSequence: input.chapterSequence,
        allowWorkspaceChapterReads: false,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
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
        },
      },
    })
    const execution = await input.model.execute(request)
    const artifact = synopsisDiscussArtifactSchema.parse(execution.result.artifact)
    return {
      content: artifact.assistantMessage,
      ...(artifact.chapterTitle === undefined ? {} : { chapterTitle: artifact.chapterTitle }),
      ...(artifact.synopsisBody === undefined ? {} : { synopsisBody: artifact.synopsisBody }),
      ...(artifact.choices === undefined ? {} : { choices: artifact.choices }),
      ...(artifact.goalProposals === undefined
        ? {}
        : {
            goalProposals: artifact.goalProposals.map((proposal) => ({
              payload: proposal.payload,
              ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
            })),
          }),
    }
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
