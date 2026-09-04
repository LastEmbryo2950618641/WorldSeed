import {
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ProjectId,
  type ProjectSuggestDisplayNameResult,
} from "@worldseed/contracts"
import { workNamingArtifactSchema } from "@worldseed/prompt-contracts"

import type { AIModelPort, PromptResourcePort } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort } from "../workspace/index.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import type { ChapterRevisionService } from "../chapters/chapter-revision-service.js"

export const DEFAULT_WORK_DISPLAY_NAME = "新建作品"
export const PLACEHOLDER_WORK_NAMES = new Set(["新建作品", "待命名"])

export class WorkNameSuggestError extends Error {}

export type WorkNameSuggestServiceDependencies = Readonly<{
  workspace: WorkspacePort
  chapters: ChapterRevisionService
  conversation: SqliteSynopsisConversationRepository
  prompts: PromptResourcePort
  readDisplayName: () => Promise<string>
  createId: () => string
  now: () => number
}>

export class WorkNameSuggestService {
  public constructor(private readonly dependencies: WorkNameSuggestServiceDependencies) {}

  public async suggest(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    model: AIModelPort
    historyNames?: readonly string[]
  }>): Promise<ProjectSuggestDisplayNameResult> {
    const currentDisplayName = (await this.dependencies.readDisplayName()).trim() || DEFAULT_WORK_DISPLAY_NAME
    const context = await this.collectContext(input.projectId, input.workspaceRootRef)
    const avoidNames = uniqueNonEmpty([
      currentDisplayName,
      ...(input.historyNames ?? []),
      ...PLACEHOLDER_WORK_NAMES,
    ])
    const phasePrompt = await this.dependencies.prompts.loadPhase("work_naming")
    const systemRules = await this.dependencies.prompts.loadBaseRules()
    const deadlineAtMs = this.dependencies.now() + 120_000
    const request = phaseRequestEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      envelopeId: this.dependencies.createId(),
      projectId: input.projectId,
      taskId: this.dependencies.createId(),
      turnId: this.dependencies.createId(),
      contextId: this.dependencies.createId(),
      scopeId: input.projectId,
      phase: "work_naming",
      protocolVersion: PROTOCOL_VERSION,
      promptRef: phasePrompt.ref,
      promptDigest: phasePrompt.digest,
      contextViewRef: `work-naming:${input.projectId}`,
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: {
        maxCalls: 1,
        remainingCalls: 1,
        maxInputTokens: 200_000,
        remainingInputTokens: 200_000,
        maxOutputTokens: 4_000,
        remainingOutputTokens: 4_000,
        deadlineAtMs,
        modelRequestDeadlineAtMs: deadlineAtMs,
      },
      input: {
        workflow: "synopsis",
        userInput: [
          "请为当前作品生成一个新的作品名。",
          `当前作品名：${currentDisplayName}`,
          `请避开：${avoidNames.join("、")}`,
        ].join("\n"),
        chapterSequence: 1,
        allowWorkspaceChapterReads: false,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
        workNaming: {
          currentDisplayName,
          avoidNames,
          volumeNames: context.volumeNames,
          chapterHeadings: context.chapterHeadings,
          synopsisExcerpts: context.synopsisExcerpts,
          recentDiscussion: context.recentDiscussion,
        },
      },
    })
    const execution = await input.model.execute(request, {
      phasePrompt,
      forceThinking: false,
      contextMessages: [{
        messageId: this.dependencies.createId(),
        sequence: 0,
        role: "system" as const,
        kind: "system_rules" as const,
        content: systemRules.text,
      }],
    })
    const parsed = phaseResultEnvelopeSchema.parse(execution.result)
    const artifact = workNamingArtifactSchema.safeParse(parsed.artifact)
    if (!artifact.success) {
      throw new WorkNameSuggestError("模型未返回合法作品名，请重试刷新生成")
    }
    const displayName = sanitizeSuggestedWorkName(artifact.data.displayName, avoidNames)
      ?? artifact.data.alternatives
        ?.map((entry) => sanitizeSuggestedWorkName(entry, avoidNames))
        .find((entry): entry is string => entry !== undefined)
    if (displayName === undefined) {
      throw new WorkNameSuggestError("模型给出的作品名不可用，请重试或手动输入")
    }
    const alternatives = (artifact.data.alternatives ?? [])
      .map((entry) => sanitizeSuggestedWorkName(entry, avoidNames))
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, 5)
    return alternatives.length === 0
      ? { displayName }
      : { displayName, alternatives }
  }

  private async collectContext(
    projectId: ProjectId,
    workspaceRootRef: string,
  ): Promise<Readonly<{
    volumeNames: readonly string[]
    chapterHeadings: readonly string[]
    synopsisExcerpts: readonly string[]
    recentDiscussion: readonly string[]
  }>> {
    const [report, volumeFolders, chapters, messages] = await Promise.all([
      this.dependencies.workspace.validate(workspaceRootRef),
      this.dependencies.workspace.listVolumeFolderNames(workspaceRootRef),
      this.dependencies.chapters.list(projectId),
      this.dependencies.conversation.listMessagesForProject(projectId),
    ])
    const volumeNames = uniqueNonEmpty(
      volumeFolders
        .map((folder) => stripVolumePrefix(folder))
        .filter((name) => name.length > 0 && !PLACEHOLDER_WORK_NAMES.has(name)),
    )
    const chapterHeadings = uniqueNonEmpty(
      chapters
        .map((chapter) => stripChapterPrefix(chapter.heading))
        .filter((name) => name.length > 0 && !PLACEHOLDER_WORK_NAMES.has(name)),
    )
    const synopsisPaths = report.inventory
      .filter((node) => node.kind === "file" && /\[剧情梗概\]\.md$/u.test(node.path))
      .map((node) => node.path)
      .slice(0, 3)
    const synopsisExcerpts: string[] = []
    for (const path of synopsisPaths) {
      try {
        const body = await this.dependencies.workspace.readMarkdown(workspaceRootRef, path)
        const excerpt = body.trim().slice(0, 1_200)
        if (excerpt.length > 0) synopsisExcerpts.push(`${path}\n${excerpt}`)
      } catch {
        // Skip unreadable synopsis files.
      }
    }
    const recentDiscussion = messages
      .slice(-8)
      .map((message) => `${message.role === "assistant" ? "Agent" : "你"}: ${message.content.trim().slice(0, 400)}`)
      .filter((line) => line.length > 4)
    return {
      volumeNames,
      chapterHeadings,
      synopsisExcerpts,
      recentDiscussion,
    }
  }
}

export function sanitizeSuggestedWorkName(
  value: string,
  avoidNames: readonly string[],
): string | undefined {
  const trimmed = value.trim().replace(/^[《「『]+|[》」』]+$/gu, "").trim()
  if (trimmed.length === 0 || trimmed.length > 200) return undefined
  if (PLACEHOLDER_WORK_NAMES.has(trimmed)) return undefined
  if (avoidNames.some((entry) => entry.trim() === trimmed)) return undefined
  return trimmed
}

function stripChapterPrefix(heading: string): string {
  return heading
    .replace(/^第[零一二三四五六七八九十百千0-9]+章\s*/u, "")
    .replace(/\s*\[剧情(?:梗概|细纲)\]\s*$/u, "")
    .replace(/\.md$/iu, "")
    .trim()
}

function stripVolumePrefix(folderName: string): string {
  return folderName
    .replace(/^第(?:\d+|[零一二三四五六七八九十百]+)卷\s+/u, "")
    .trim()
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    next.push(trimmed)
  }
  return next
}
