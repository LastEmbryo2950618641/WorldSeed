import type {
  ProjectId,
  SettingsLineageCommitResult,
  SettingsLineageEntry,
  SettingsLineageHeadMeta,
  SettingsLineageListResult,
  SettingsLineagePathsResult,
  SettingsLineageSourceKind,
} from "@worldseed/contracts"

import type { WorkspacePort } from "../workspace/index.js"
import {
  digestSettingsMarkdown,
  isSettingsLineagePath,
  SqliteSettingsLineageRepository,
} from "../../infrastructure/sqlite/repositories/sqlite-settings-lineage-repository.js"

export type SettingsLineageServiceDependencies = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  workspace: WorkspacePort
  repository: SqliteSettingsLineageRepository
  createId: () => string
  now: () => number
}>

export class SettingsLineageService {
  public constructor(private readonly dependencies: SettingsLineageServiceDependencies) {}

  public async recordUpsert(input: Readonly<{
    relativePath: string
    markdown: string
    sourceKind: SettingsLineageSourceKind
    sourceRef?: string
    summary?: string
    causingChapterSequence?: number
    causingChapterId?: string
    storyTime?: string
  }>): Promise<SettingsLineageEntry | undefined> {
    if (!isSettingsLineagePath(input.relativePath)) return undefined
    return this.dependencies.repository.recordUpsert({
      projectId: this.dependencies.projectId,
      relativePath: input.relativePath.replaceAll("\\", "/"),
      markdown: input.markdown,
      sourceKind: input.sourceKind,
      commitId: this.dependencies.createId(),
      createdAtMs: this.dependencies.now(),
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      ...(input.summary === undefined || input.summary.trim().length === 0
        ? {}
        : { summary: input.summary.trim().slice(0, 500) }),
      ...(input.causingChapterSequence === undefined
        ? {}
        : { causingChapterSequence: input.causingChapterSequence }),
      ...(input.causingChapterId === undefined ? {} : { causingChapterId: input.causingChapterId }),
      ...(input.storyTime === undefined || input.storyTime.trim().length === 0
        ? {}
        : { storyTime: input.storyTime.trim().slice(0, 200) }),
    })
  }

  public async seedFromWorkspace(): Promise<number> {
    if (await this.dependencies.repository.hasAnyCommit(this.dependencies.projectId)) return 0
    const report = await this.dependencies.workspace.validate(this.dependencies.workspaceRootRef)
    let seeded = 0
    for (const entry of report.inventory) {
      if (entry.kind !== "file" || !isSettingsLineagePath(entry.path)) continue
      let markdown = ""
      try {
        markdown = await this.dependencies.workspace.readMarkdown(
          this.dependencies.workspaceRootRef,
          entry.path,
        )
      } catch {
        continue
      }
      await this.recordUpsert({
        relativePath: entry.path,
        markdown,
        sourceKind: "migration_seed",
        summary: "项目打开时收录现有设定",
      })
      seeded += 1
    }
    return seeded
  }

  public async list(input: Readonly<{
    relativePath: string
    limit?: number
  }>): Promise<SettingsLineageListResult> {
    const entries = await this.dependencies.repository.listByPath({
      projectId: this.dependencies.projectId,
      relativePath: input.relativePath.replaceAll("\\", "/"),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    return { entries: [...entries] }
  }

  public async getCommit(commitId: string): Promise<SettingsLineageCommitResult> {
    const entry = await this.dependencies.repository.getEntry(commitId)
    if (entry === undefined || entry.blobDigest === undefined) {
      throw new Error(`settings lineage commit not found: ${commitId}`)
    }
    const markdown = await this.dependencies.repository.getMarkdown(entry.blobDigest)
    if (markdown === undefined) {
      throw new Error(`settings lineage blob missing: ${entry.blobDigest}`)
    }
    const previousMarkdown = await this.dependencies.repository.findPreviousMarkdown({
      projectId: this.dependencies.projectId,
      relativePath: entry.relativePath,
      commitSeq: entry.commitSeq,
    })
    return {
      entry,
      markdown,
      ...(previousMarkdown === undefined ? {} : { previousMarkdown }),
    }
  }

  public async headMeta(relativePath: string): Promise<SettingsLineageHeadMeta> {
    return this.dependencies.repository.headMeta({
      projectId: this.dependencies.projectId,
      relativePath: relativePath.replaceAll("\\", "/"),
    })
  }

  public async listPaths(): Promise<SettingsLineagePathsResult> {
    const paths = await this.dependencies.repository.listTrackedPaths(this.dependencies.projectId)
    return { paths: [...paths] }
  }

  public async readAsOfChapter(input: Readonly<{
    relativePath: string
    chapterSequence: number
  }>): Promise<Readonly<{ markdown: string; commitId: string; commitSeq: number }> | undefined> {
    return this.dependencies.repository.resolveAsOfMarkdown({
      projectId: this.dependencies.projectId,
      relativePath: input.relativePath.replaceAll("\\", "/"),
      chapterSequence: input.chapterSequence,
    })
  }

  /** After world-history checkout, append commits for 设定集 paths whose disk content diverges from heads. */
  public async realignAfterHistoryRestore(sourceRef: string): Promise<number> {
    const report = await this.dependencies.workspace.validate(this.dependencies.workspaceRootRef)
    let realigned = 0
    for (const entry of report.inventory) {
      if (entry.kind !== "file" || !isSettingsLineagePath(entry.path)) continue
      const relativePath = entry.path.replaceAll("\\", "/")
      let markdown = ""
      try {
        markdown = await this.dependencies.workspace.readMarkdown(
          this.dependencies.workspaceRootRef,
          relativePath,
        )
      } catch {
        continue
      }
      const head = await this.headMeta(relativePath)
      if (head.blobDigest === digestSettingsMarkdown(markdown)) continue
      const recorded = await this.recordUpsert({
        relativePath,
        markdown,
        sourceKind: "history_restore",
        sourceRef,
        summary: "世界历史恢复后与磁盘重对齐",
      })
      if (recorded !== undefined) realigned += 1
    }
    return realigned
  }

  public async annotate(input: Readonly<{
    commitId: string
    storyTime?: string | null
    summary?: string | null
  }>): Promise<SettingsLineageEntry> {
    const updated = await this.dependencies.repository.annotate(input)
    if (updated === undefined) throw new Error(`settings lineage commit not found: ${input.commitId}`)
    return updated
  }

  /**
   * Dangerous: overwrite current 设定集 file with a past lineage version.
   * Requires confirmPhrase === "恢复为当前". Appends a new lineage commit; does not rewrite history.
   */
  public async restoreAsCurrent(input: Readonly<{
    commitId: string
    confirmPhrase: string
  }>): Promise<SettingsLineageEntry> {
    if (input.confirmPhrase.trim() !== "恢复为当前") {
      throw new Error('确认失败：请输入「恢复为当前」以覆盖当前设定文件')
    }
    const commit = await this.getCommit(input.commitId)
    if (commit.entry.op === "delete") {
      throw new Error("无法恢复删除记录为当前文件")
    }
    if (!isSettingsLineagePath(commit.entry.relativePath)) {
      throw new Error(`not a settings lineage path: ${commit.entry.relativePath}`)
    }
    await this.dependencies.workspace.saveUserMarkdown(
      this.dependencies.workspaceRootRef,
      commit.entry.relativePath,
      commit.markdown,
    )
    const recorded = await this.recordUpsert({
      relativePath: commit.entry.relativePath,
      markdown: commit.markdown,
      sourceKind: "workspace_save",
      sourceRef: input.commitId,
      summary: "从沿革恢复为当前真相",
      ...(commit.entry.storyTime === undefined ? {} : { storyTime: commit.entry.storyTime }),
    })
    if (recorded !== undefined) return recorded
    const head = await this.headMeta(commit.entry.relativePath)
    if (head.commitId === undefined) {
      throw new Error("restore wrote file but lineage head is missing")
    }
    const headEntry = await this.dependencies.repository.getEntry(head.commitId)
    if (headEntry === undefined) throw new Error("restore wrote file but lineage head entry is missing")
    return headEntry
  }
}
