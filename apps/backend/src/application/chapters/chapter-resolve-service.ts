import type { Kysely } from "kysely"

import type { ProjectId } from "@worldseed/contracts"

import type { ChapterIndexRecord, SqliteChapterIndexRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import type { ChapterRevisionRepository } from "./ports/chapter-revision-repository.js"
import type { ChapterRevisionService } from "./chapter-revision-service.js"
import { parseChapterSequenceFromLabel } from "../../core/index.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"

export type ChapterStaleMarker = Readonly<{
  kind: "prior_chapter_superseded" | "graph_sync_incomplete" | "review_digest_mismatch"
  ref: string
  reason: string
  staleSinceMs: number
}>

export type ChapterLineageView = Readonly<{
  chapterId: string
  sourceId: string
  priorChapterSourceIds: readonly string[]
  staleMarkers: readonly ChapterStaleMarker[]
}>

export type EditorSurfaceMode =
  | "home_turn"
  | "chapter_read"
  | "chapter_revision_agent"
  | "chapter_revision_direct"
  | "graph_sync_recovery"

export type ResolvedChapter = Readonly<{
  index: ChapterIndexRecord
  committed: Awaited<ReturnType<ChapterRevisionService["read"]>>
  lineage: ChapterLineageView
  activeRevision?: Awaited<ReturnType<ChapterRevisionService["readRevision"]>>
  revisionStale: boolean
  graphSyncBlocking: boolean
  suggestedUiMode: EditorSurfaceMode
}>

export type ChapterResolveServiceDependencies = Readonly<{
  chapters: ChapterRevisionService
  revisions: ChapterRevisionRepository
  chapterIndex: SqliteChapterIndexRepository
  database: Kysely<import("../../infrastructure/sqlite/database-types.js").ProjectDatabase>
  createId: () => string
  now: () => number
}>

export class ChapterResolveService {
  public constructor(private readonly dependencies: ChapterResolveServiceDependencies) {}

  public async resolve(projectId: ProjectId, chapterId: string): Promise<ResolvedChapter> {
    const committed = await this.dependencies.chapters.read(projectId, chapterId)
    const index = await this.dependencies.chapterIndex.find(projectId, chapterId)
      ?? await this.fallbackIndex(projectId, committed)
    const activeRevision = await this.dependencies.chapters.findActiveRevision(projectId, chapterId)
    const lineage = await this.buildLineage(projectId, committed.chapterId, committed.sourceId, index.sequence)
    const revisionStale = activeRevision?.review !== undefined
      && activeRevision.review.contentDigest !== activeRevision.contentDigest
    const graphSyncBlocking = await this.dependencies.revisions.hasIncompleteGraphSync(projectId)
    const resolved = {
      index,
      committed,
      lineage,
      ...(activeRevision === undefined ? {} : { activeRevision }),
      revisionStale,
      graphSyncBlocking,
      suggestedUiMode: this.suggestUiMode(activeRevision),
    }
    runtimeLog("debug", "chapter-resolve", "resolved", {
      projectId,
      chapterId: committed.chapterId,
      sequence: index.sequence,
      currentSourceId: index.currentSourceId,
      graphSyncBlocking,
      revisionStale,
      staleMarkerCount: lineage.staleMarkers.length,
      suggestedUiMode: resolved.suggestedUiMode,
      hasActiveRevision: activeRevision !== undefined,
    })
    return resolved
  }

  public async resolveByPath(projectId: ProjectId, publishPath: string): Promise<ResolvedChapter> {
    const chapterId = await this.findChapterIdByPublishPath(projectId, publishPath)
    if (chapterId === undefined) throw new Error(`Chapter not found for path: ${publishPath}`)
    return this.resolve(projectId, chapterId)
  }

  private async findChapterIdByPublishPath(projectId: ProjectId, publishPath: string): Promise<string | undefined> {
    const chapters = await this.dependencies.chapters.list(projectId)
    const exact = chapters.find((item) => item.publishPath === publishPath)
    if (exact !== undefined) return exact.chapterId

    const indices = await this.dependencies.chapterIndex.list(projectId)
    const byIndexPath = indices.find((item) => item.currentPublishPath === publishPath)
    if (byIndexPath !== undefined) return byIndexPath.chapterId

    const label = publishPath.startsWith("章节正文/") && publishPath.endsWith(".md")
      ? publishPath.slice("章节正文/".length, -".md".length)
      : undefined
    if (label === undefined) return undefined

    const byHeading = chapters.find((item) => item.heading === label)
    if (byHeading !== undefined) return byHeading.chapterId

    const sequence = parseChapterSequenceFromLabel(label)
    if (sequence === undefined) return undefined
    const bySequence = indices.filter((item) => item.sequence === sequence)
    return bySequence.length === 1 ? bySequence[0]?.chapterId : undefined
  }

  public async nextChapterSequence(projectId: ProjectId): Promise<number> {
    return this.dependencies.chapterIndex.nextSequence(projectId)
  }

  public async isGraphSyncBlocking(projectId: ProjectId): Promise<boolean> {
    return this.dependencies.revisions.hasIncompleteGraphSync(projectId)
  }

  public async recordLineageSnapshot(input: Readonly<{
    projectId: ProjectId
    chapterId: string
    sourceId: string
    priorChapterSourceIds: readonly string[]
  }>): Promise<void> {
    await this.dependencies.database.insertInto("chapter_lineage_snapshots").values({
      id: this.dependencies.createId(),
      project_id: input.projectId,
      chapter_id: input.chapterId,
      source_id: input.sourceId,
      prior_chapter_source_ids_json: JSON.stringify(input.priorChapterSourceIds),
      created_at_ms: this.dependencies.now(),
    }).execute()
  }

  private async fallbackIndex(
    projectId: ProjectId,
    committed: Awaited<ReturnType<ChapterRevisionService["read"]>>,
  ): Promise<ChapterIndexRecord> {
    return this.dependencies.chapterIndex.assignOnFirstCommit({
      projectId,
      chapterId: committed.chapterId,
      sequence: await this.dependencies.chapterIndex.nextSequence(projectId),
      currentSourceId: committed.sourceId,
      currentPublishPath: committed.publishPath,
      assignedAtMs: committed.createdAtMs,
    })
  }

  private async buildLineage(
    projectId: ProjectId,
    chapterId: string,
    sourceId: string,
    sequence: number,
  ): Promise<ChapterLineageView> {
    const snapshot = await this.dependencies.database.selectFrom("chapter_lineage_snapshots").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_id", "=", chapterId)
      .where("source_id", "=", sourceId)
      .orderBy("created_at_ms", "desc")
      .executeTakeFirst()
    const priorChapterSourceIds = snapshot === undefined
      ? await this.defaultPriorChapterSourceIds(projectId, sequence)
      : JSON.parse(snapshot.prior_chapter_source_ids_json) as string[]
    const staleMarkers = await this.computeStaleMarkers(projectId, sequence, priorChapterSourceIds)
    return { chapterId, sourceId, priorChapterSourceIds, staleMarkers }
  }

  private async defaultPriorChapterSourceIds(projectId: ProjectId, sequence: number): Promise<readonly string[]> {
    const indices = await this.dependencies.chapterIndex.list(projectId)
    return indices.filter((item) => item.sequence < sequence).map((item) => item.currentSourceId)
  }

  private async computeStaleMarkers(
    projectId: ProjectId,
    sequence: number,
    priorChapterSourceIds: readonly string[],
  ): Promise<readonly ChapterStaleMarker[]> {
    const markers: ChapterStaleMarker[] = []
    const indices = await this.dependencies.chapterIndex.list(projectId)
    for (const indexEntry of indices) {
      if (indexEntry.sequence >= sequence) continue
      const expected = priorChapterSourceIds[indexEntry.sequence - 1]
      if (expected !== undefined && expected !== indexEntry.currentSourceId) {
        markers.push({
          kind: "prior_chapter_superseded",
          ref: indexEntry.chapterId,
          reason: `第 ${String(indexEntry.sequence)} 章在本文写出后已被修订`,
          staleSinceMs: indexEntry.assignedAtMs,
        })
      }
    }
    if (await this.dependencies.revisions.hasIncompleteGraphSync(projectId)) {
      markers.push({
        kind: "graph_sync_incomplete",
        ref: projectId,
        reason: "存在尚未完成图同步的章节修订",
        staleSinceMs: this.dependencies.now(),
      })
    }
    return markers
  }

  private suggestUiMode(
    activeRevision: Awaited<ReturnType<ChapterRevisionService["readRevision"]>> | undefined,
  ): EditorSurfaceMode {
    if (activeRevision?.inputMode === "agent" && activeRevision.status === "editing") {
      return "chapter_revision_agent"
    }
    if (activeRevision?.decision === "submit" && activeRevision.graphSyncStatus !== "completed") {
      return "graph_sync_recovery"
    }
    if (activeRevision !== undefined && ["editing", "reviewing", "ready_to_submit"].includes(activeRevision.status)) {
      return "chapter_revision_agent"
    }
    return "chapter_read"
  }
}
