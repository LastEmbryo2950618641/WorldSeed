import type { ChapterSynopsis, ProjectId } from "@worldseed/contracts"

import type { WorkspacePort } from "../workspace/index.js"
import type { SqliteChapterSynopsisRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-synopsis-repository.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import { DEFAULT_VOLUME_FOLDER_NAME, extractVolumeFolderNameFromPath } from "../../core/chapters/chapter-volume.js"
import { normalizeChapterHeading, parseChapterSequenceFromLabel } from "../../core/chapters/chapter-document.js"
import {
  deriveOutlineMarkdownPath,
  deriveSynopsisMarkdownPath,
  isChapterBodyMarkdownPath,
  isChapterPlanningMarkdownPath,
  isOutlineMarkdownPath,
  isSynopsisMarkdownPath,
  isSynopsisPlaceholderDocument,
  parseOutlineMarkdownPath,
  parseSynopsisMarkdownPath,
  parseSynopsisTitleFromLabel,
} from "../../core/chapters/synopsis-path.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"

export type ChapterSynopsisServiceDependencies = Readonly<{
  synopsis: SqliteChapterSynopsisRepository
  conversation: SqliteSynopsisConversationRepository
  workspace: WorkspacePort
  now: () => number
}>

export type CapturedSynopsisRematerialize = Readonly<{
  relativePath: string
  markdown: string
  chapterSequence?: number
  sessionId?: string
}>

export type PlanningChapterHeading = Readonly<{
  titleLabel: string
  volumeFolderName: string
  sourcePath: string
}>

/** Injected into synopsisDiscuss when body vs planning titles diverge for the same sequence. */
export type TitleAlignmentIssue = Readonly<{
  chapterSequence: number
  bodyPath: string
  bodyHeading: string
  planningHeading: string
  planningPaths: readonly string[]
  recommendedTarget: "body" | "planning"
  remediation: string
}>

export class ChapterSynopsisService {
  public constructor(private readonly dependencies: ChapterSynopsisServiceDependencies) {}

  public async get(input: Readonly<{
    projectId: ProjectId
    chapterId?: string
    publishPath?: string
  }>): Promise<ChapterSynopsis | undefined> {
    if (input.chapterId !== undefined) {
      return this.dependencies.synopsis.findByChapterId(input.projectId, input.chapterId)
    }
    if (input.publishPath !== undefined) {
      return this.dependencies.synopsis.findByChapterPath(input.projectId, input.publishPath)
    }
    return undefined
  }

  /**
   * Prefer existing 细纲/梗概 title for the sequence so publish cannot invent a divergent heading.
   * Outline wins over synopsis when both exist.
   */
  public async findPlanningHeading(input: Readonly<{
    workspaceRootRef: string
    chapterSequence: number
  }>): Promise<PlanningChapterHeading | undefined> {
    const candidates = await this.listPlanningFilesForSequence(input.workspaceRootRef, input.chapterSequence)
    const outline = candidates.find((entry) => entry.kind === "outline")
    const synopsis = candidates.find((entry) => entry.kind === "synopsis")
    const preferred = outline ?? synopsis
    if (preferred === undefined) return undefined
    return {
      titleLabel: preferred.titleLabel,
      volumeFolderName: preferred.volumeFolderName,
      sourcePath: preferred.path,
    }
  }

  /**
   * Detect same-sequence body vs 梗概/细纲 filename stem mismatch (UI related rail "尚未创建").
   */
  public async detectTitleAlignmentIssue(input: Readonly<{
    workspaceRootRef: string
    chapterSequence: number
  }>): Promise<TitleAlignmentIssue | undefined> {
    const planning = await this.findPlanningHeading(input)
    const body = await this.findBodyForSequence(input.workspaceRootRef, input.chapterSequence)
    if (planning === undefined || body === undefined) return undefined
    const planningShort = parseSynopsisTitleFromLabel(planning.titleLabel) ?? planning.titleLabel
    const bodyShort = parseSynopsisTitleFromLabel(body.heading) ?? body.heading
    if (planningShort === bodyShort || planning.titleLabel === body.heading) return undefined
    const candidates = await this.listPlanningFilesForSequence(input.workspaceRootRef, input.chapterSequence)
    return {
      chapterSequence: input.chapterSequence,
      bodyPath: body.path,
      bodyHeading: body.heading,
      planningHeading: planning.titleLabel,
      planningPaths: candidates.map((entry) => entry.path),
      recommendedTarget: "body",
      remediation: [
        "同章正文与梗概/细纲标题不一致；右侧关联栏可能误显示「尚未创建」。",
        "先用 choices 请用户选择统一到正文或统一到细纲。",
        "用户确认后输出 titleAlignTarget=body|planning（可辅以 chapterTitle）。",
        "验收：文件树同章只剩一个折叠入口，关联栏梗概/细纲变为已创建。",
      ].join(" "),
    }
  }

  /**
   * Rename on-disk 梗概/细纲 so their title stem matches the published body heading.
   * Design: 三文件共享同一标题主干.
   */
  public async alignPlanningTitlesToPublishedHeading(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterSequence: number
    chapterHeading: string
    chapterPath: string
  }>): Promise<void> {
    const heading = normalizeChapterHeading(input.chapterHeading)
    const volumeFolderName = extractVolumeFolderNameFromPath(input.chapterPath)
      ?? DEFAULT_VOLUME_FOLDER_NAME
    const targetSynopsis = deriveSynopsisMarkdownPath(input.chapterSequence, heading, volumeFolderName)
    const targetOutline = deriveOutlineMarkdownPath(input.chapterSequence, heading, volumeFolderName)
    const candidates = await this.listPlanningFilesForSequence(input.workspaceRootRef, input.chapterSequence)

    for (const entry of candidates) {
      const target = entry.kind === "outline" ? targetOutline : targetSynopsis
      if (entry.path === target) continue
      const content = await this.readPlanningFile(input.workspaceRootRef, entry.path)
      if (content.trim().length === 0) {
        await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, entry.path).catch(() => undefined)
        continue
      }
      const existingTarget = await this.readPlanningFile(input.workspaceRootRef, target)
      if (existingTarget.trim().length === 0) {
        await this.dependencies.workspace.saveSynopsisMarkdown(input.workspaceRootRef, target, content)
      }
      if (entry.path !== target) {
        await this.dependencies.workspace.removeSynopsisMarkdown(input.workspaceRootRef, entry.path).catch(() => undefined)
      }
    }

    const session = await this.dependencies.conversation.findBySequence(input.projectId, input.chapterSequence)
    if (session !== undefined && (session.synopsisPath !== targetSynopsis || session.title !== heading)) {
      const shortTitle = parseSynopsisTitleFromLabel(heading) ?? heading
      await this.dependencies.conversation.updateSession({
        sessionId: session.sessionId,
        synopsisPath: targetSynopsis,
        title: shortTitle,
        updatedAtMs: this.dependencies.now(),
      })
    }

    runtimeLog("debug", "chapter-synopsis", "aligned_planning_titles", {
      projectId: input.projectId,
      chapterSequence: input.chapterSequence,
      chapterHeading: heading,
      targetSynopsis,
      targetOutline,
    })
  }

  public async linkAfterPublish(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterId: string
    chapterSequence: number
    chapterPath: string
  }>): Promise<void> {
    const chapterHeading = input.chapterPath
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.md$/u, "")
    if (chapterHeading !== undefined && chapterHeading.length > 0) {
      await this.alignPlanningTitlesToPublishedHeading({
        projectId: input.projectId,
        workspaceRootRef: input.workspaceRootRef,
        chapterSequence: input.chapterSequence,
        chapterHeading,
        chapterPath: input.chapterPath,
      })
    }

    const session = await this.dependencies.conversation.findBySequence(input.projectId, input.chapterSequence)
    if (session === undefined) return

    const synopsisMarkdown = await this.resolveArchiveMarkdown(input.workspaceRootRef, session)
    if (synopsisMarkdown.trim().length === 0) {
      // Keep workspace planning files; only complete the discussion session.
      await this.completeSession(session.sessionId)
      return
    }

    const source = await this.resolveArchiveSource(input.workspaceRootRef, session)
    await this.dependencies.synopsis.upsert(input.projectId, {
      chapterId: input.chapterId,
      chapterSequence: input.chapterSequence,
      chapterPath: input.chapterPath,
      synopsisMarkdown,
      source,
      originalSynopsisPath: session.synopsisPath,
      ...(session.turnBootstrapInput === undefined ? {} : { turnBootstrapInput: session.turnBootstrapInput }),
      linkedAtMs: this.dependencies.now(),
    })
    // Design 2026-09-02: keep [剧情梗概]/[剧情细纲] on disk; tree folds under body.
    await this.completeSession(session.sessionId)
    runtimeLog("debug", "chapter-synopsis", "linked", {
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterSequence: input.chapterSequence,
      source,
    })
  }

  /** Snapshot filled synopsis sources before history checkout wipes the workspace. */
  public async captureSynopsisForRematerialize(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
  }>): Promise<readonly CapturedSynopsisRematerialize[]> {
    const byPath = new Map<string, CapturedSynopsisRematerialize>()

    const report = await this.dependencies.workspace.validate(input.workspaceRootRef)
    for (const entry of report.inventory) {
      if (entry.kind !== "file" || !isSynopsisMarkdownPath(entry.path)) continue
      let markdown = ""
      try {
        markdown = await this.dependencies.workspace.readMarkdown(input.workspaceRootRef, entry.path)
      } catch {
        continue
      }
      if (isSynopsisPlaceholderDocument(markdown)) continue
      const parsed = parseSynopsisMarkdownPath(entry.path)
      byPath.set(entry.path, {
        relativePath: entry.path,
        markdown,
        ...(parsed?.sequence === undefined ? {} : { chapterSequence: parsed.sequence }),
      })
    }

    const active = await this.dependencies.conversation.findActiveSession(input.projectId)
    const maxSequence = await this.dependencies.conversation.maxChapterSequence(input.projectId)
    const sessions = [
      ...(active === undefined ? [] : [active]),
      ...(maxSequence === undefined
        ? []
        : [await this.dependencies.conversation.findBySequence(input.projectId, maxSequence)]),
    ].filter((session): session is NonNullable<typeof session> => session !== undefined)

    for (const session of sessions) {
      if (byPath.has(session.synopsisPath)) {
        const existing = byPath.get(session.synopsisPath)!
        byPath.set(session.synopsisPath, {
          ...existing,
          chapterSequence: existing.chapterSequence ?? session.chapterSequence,
          sessionId: existing.sessionId ?? session.sessionId,
        })
        continue
      }
      const markdown = await this.resolveArchiveMarkdown(input.workspaceRootRef, session)
      if (markdown.trim().length === 0 || isSynopsisPlaceholderDocument(markdown)) continue
      byPath.set(session.synopsisPath, {
        relativePath: session.synopsisPath,
        markdown,
        chapterSequence: session.chapterSequence,
        sessionId: session.sessionId,
      })
    }

    const archived = await this.dependencies.synopsis.listByProject(input.projectId)
    for (const row of archived) {
      if (row.synopsisMarkdown.trim().length === 0 || isSynopsisPlaceholderDocument(row.synopsisMarkdown)) continue
      const relativePath = row.originalSynopsisPath
        ?? deriveSynopsisMarkdownPath(row.chapterSequence, "")
      if (byPath.has(relativePath)) continue
      const session = await this.dependencies.conversation.findBySequence(input.projectId, row.chapterSequence)
      byPath.set(relativePath, {
        relativePath,
        markdown: row.synopsisMarkdown,
        chapterSequence: row.chapterSequence,
        ...(session === undefined ? {} : { sessionId: session.sessionId }),
      })
    }

    return [...byPath.values()]
  }

  /** After return_previous_round restore, rewrite filled synopsis over placeholder/missing files. */
  public async rematerializeAfterHistoryCheckout(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    captured: readonly CapturedSynopsisRematerialize[]
  }>): Promise<number> {
    let rematerialized = 0
    for (const item of input.captured) {
      if (item.markdown.trim().length === 0 || isSynopsisPlaceholderDocument(item.markdown)) continue
      let current: string | undefined
      try {
        current = await this.dependencies.workspace.readMarkdown(input.workspaceRootRef, item.relativePath)
      } catch {
        current = undefined
      }
      if (current !== undefined && !isSynopsisPlaceholderDocument(current)) continue

      await this.dependencies.workspace.saveSynopsisMarkdown(
        input.workspaceRootRef,
        item.relativePath,
        item.markdown,
      )
      rematerialized += 1

      const session = item.sessionId === undefined
        ? (item.chapterSequence === undefined
          ? undefined
          : await this.dependencies.conversation.findBySequence(input.projectId, item.chapterSequence))
        : await this.dependencies.conversation.findSession(item.sessionId)
      if (session !== undefined && session.status === "completed") {
        await this.reactivateSession(input.projectId, session.sessionId)
      }
    }
    if (rematerialized > 0) {
      runtimeLog("info", "chapter-synopsis", "rematerialized_after_checkout", {
        projectId: input.projectId,
        pathCount: rematerialized,
      })
    }
    return rematerialized
  }

  private async reactivateSession(projectId: ProjectId, sessionId: string): Promise<void> {
    const active = await this.dependencies.conversation.findActiveSession(projectId)
    if (active !== undefined && active.sessionId !== sessionId) {
      await this.dependencies.conversation.updateSession({
        sessionId: active.sessionId,
        status: "completed",
        updatedAtMs: this.dependencies.now(),
      })
    }
    await this.dependencies.conversation.updateSession({
      sessionId,
      status: "active",
      updatedAtMs: this.dependencies.now(),
    })
  }

  private async resolveArchiveMarkdown(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findBySequence"]>>>,
  ): Promise<string> {
    try {
      const fileContent = await this.dependencies.workspace.readMarkdown(workspaceRootRef, session.synopsisPath)
      if (fileContent.trim().length > 0) return fileContent
    } catch {
      // fall through
    }
    if (session.turnBootstrapInput !== undefined && session.turnBootstrapInput.trim().length > 0) {
      return session.turnBootstrapInput
    }
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    if (messages.length === 0) return ""
    return messages.map((message) => {
      const speaker = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : "系统"
      return `${speaker}：${message.content}`
    }).join("\n\n")
  }

  private async resolveArchiveSource(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findBySequence"]>>>,
  ): Promise<"synopsis_file" | "conversation" | "turn_input"> {
    try {
      const fileContent = await this.dependencies.workspace.readMarkdown(workspaceRootRef, session.synopsisPath)
      if (fileContent.trim().length > 0) return "synopsis_file"
    } catch {
      // fall through
    }
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    if (messages.length > 0) return "conversation"
    return "turn_input"
  }

  private async completeSession(sessionId: string): Promise<void> {
    await this.dependencies.conversation.updateSession({
      sessionId,
      status: "completed",
      updatedAtMs: this.dependencies.now(),
    })
  }

  private async findBodyForSequence(
    workspaceRootRef: string,
    chapterSequence: number,
  ): Promise<Readonly<{ path: string; heading: string; volumeFolderName: string }> | undefined> {
    const report = await this.dependencies.workspace.validate(workspaceRootRef)
    for (const entry of report.inventory) {
      if (entry.kind !== "file" || !isChapterBodyMarkdownPath(entry.path)) continue
      const normalized = entry.path.replaceAll("\\", "/")
      const filename = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.md$/u, "")
      if (parseChapterSequenceFromLabel(filename) !== chapterSequence) continue
      return {
        path: normalized,
        heading: filename,
        volumeFolderName: extractVolumeFolderNameFromPath(normalized) ?? DEFAULT_VOLUME_FOLDER_NAME,
      }
    }
    return undefined
  }

  private async listPlanningFilesForSequence(
    workspaceRootRef: string,
    chapterSequence: number,
  ): Promise<readonly Readonly<{
    path: string
    kind: "synopsis" | "outline"
    titleLabel: string
    volumeFolderName: string
  }>[]> {
    const report = await this.dependencies.workspace.validate(workspaceRootRef)
    const found: Array<{
      path: string
      kind: "synopsis" | "outline"
      titleLabel: string
      volumeFolderName: string
    }> = []
    for (const entry of report.inventory) {
      if (entry.kind !== "file" || !isChapterPlanningMarkdownPath(entry.path)) continue
      const parsed = isOutlineMarkdownPath(entry.path)
        ? parseOutlineMarkdownPath(entry.path)
        : parseSynopsisMarkdownPath(entry.path)
      if (parsed?.sequence !== chapterSequence) continue
      found.push({
        path: entry.path,
        kind: isOutlineMarkdownPath(entry.path) ? "outline" : "synopsis",
        titleLabel: parsed.titleLabel,
        volumeFolderName: parsed.volumeFolderName
          ?? extractVolumeFolderNameFromPath(entry.path)
          ?? DEFAULT_VOLUME_FOLDER_NAME,
      })
    }
    return found
  }

  private async readPlanningFile(workspaceRootRef: string, relativePath: string): Promise<string> {
    try {
      return await this.dependencies.workspace.readMarkdown(workspaceRootRef, relativePath)
    } catch {
      return ""
    }
  }
}
