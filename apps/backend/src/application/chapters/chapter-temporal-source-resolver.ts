import type { Kysely } from "kysely"

import type { ProjectId } from "@worldseed/contracts"

import type { ProjectDatabase } from "../../infrastructure/sqlite/database-types.js"
import type { SqliteChapterIndexRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"

export type ResolvedChapterTemporalSource = Readonly<{
  sourceId: string
  publishPath: string
  chapterSequence: number
  pinned: boolean
  pinnedFromChapterSequence?: number
}>

/**
 * Resolve formal chapter source for temporal reads.
 * Prefers lineage snapshot pins ("as written when drafting chapter S") over current heads.
 */
export class ChapterTemporalSourceResolver {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly chapterIndex: SqliteChapterIndexRepository,
  ) {}

  public async resolve(input: Readonly<{
    projectId: ProjectId
    targetSequence: number
    cursorSequence: number
  }>): Promise<ResolvedChapterTemporalSource | undefined> {
    if (input.targetSequence < 1 || input.targetSequence >= input.cursorSequence) return undefined

    const targetIndex = await this.chapterIndex.findBySequence(input.projectId, input.targetSequence)
    const pinnedSourceId = await this.resolvePinnedSourceId(input.projectId, input.targetSequence, input.cursorSequence)
    if (pinnedSourceId !== undefined && targetIndex !== undefined) {
      const pinnedFromChapterSequence = await this.findPinSourceChapterSequence(
        input.projectId,
        input.cursorSequence,
      )
      return {
        sourceId: pinnedSourceId,
        publishPath: targetIndex.currentPublishPath,
        chapterSequence: input.targetSequence,
        pinned: true,
        ...(pinnedFromChapterSequence === undefined
          ? {}
          : { pinnedFromChapterSequence }),
      }
    }
    if (targetIndex === undefined) return undefined
    return {
      sourceId: targetIndex.currentSourceId,
      publishPath: targetIndex.currentPublishPath,
      chapterSequence: input.targetSequence,
      pinned: false,
    }
  }

  private async resolvePinnedSourceId(
    projectId: ProjectId,
    targetSequence: number,
    cursorSequence: number,
  ): Promise<string | undefined> {
    const snapshot = await this.findBestLineageSnapshot(projectId, cursorSequence)
    if (snapshot === undefined) return undefined
    const priorIds = JSON.parse(snapshot.prior_chapter_source_ids_json) as string[]
    const pinned = priorIds[targetSequence - 1]
    return typeof pinned === "string" && pinned.length > 0 ? pinned : undefined
  }

  private async findBestLineageSnapshot(
    projectId: ProjectId,
    cursorSequence: number,
  ): Promise<{ prior_chapter_source_ids_json: string; chapter_id: string } | undefined> {
    const rows = await this.database.selectFrom("chapter_lineage_snapshots")
      .innerJoin("chapter_index", (join) => join
        .onRef("chapter_index.chapter_id", "=", "chapter_lineage_snapshots.chapter_id")
        .onRef("chapter_index.project_id", "=", "chapter_lineage_snapshots.project_id"))
      .select([
        "chapter_lineage_snapshots.prior_chapter_source_ids_json",
        "chapter_lineage_snapshots.chapter_id",
        "chapter_index.sequence as chapter_sequence",
        "chapter_lineage_snapshots.created_at_ms",
      ])
      .where("chapter_lineage_snapshots.project_id", "=", projectId)
      .where("chapter_index.sequence", "<", cursorSequence)
      .orderBy("chapter_index.sequence", "desc")
      .orderBy("chapter_lineage_snapshots.created_at_ms", "desc")
      .limit(1)
      .execute()
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      prior_chapter_source_ids_json: row.prior_chapter_source_ids_json,
      chapter_id: row.chapter_id,
    }
  }

  private async findPinSourceChapterSequence(
    projectId: ProjectId,
    cursorSequence: number,
  ): Promise<number | undefined> {
    const row = await this.database.selectFrom("chapter_lineage_snapshots")
      .innerJoin("chapter_index", (join) => join
        .onRef("chapter_index.chapter_id", "=", "chapter_lineage_snapshots.chapter_id")
        .onRef("chapter_index.project_id", "=", "chapter_lineage_snapshots.project_id"))
      .select("chapter_index.sequence as chapter_sequence")
      .where("chapter_lineage_snapshots.project_id", "=", projectId)
      .where("chapter_index.sequence", "<", cursorSequence)
      .orderBy("chapter_index.sequence", "desc")
      .orderBy("chapter_lineage_snapshots.created_at_ms", "desc")
      .limit(1)
      .executeTakeFirst()
    return row?.chapter_sequence
  }
}
