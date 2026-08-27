import type { Kysely } from "kysely"

import type { ProjectId } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"

export type ChapterIndexRecord = Readonly<{
  chapterId: string
  sequence: number
  currentSourceId: string
  currentPublishPath: string
  assignedAtMs: number
}>

export class SqliteChapterIndexRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async list(projectId: ProjectId): Promise<readonly ChapterIndexRecord[]> {
    const rows = await this.database.selectFrom("chapter_index").selectAll()
      .where("project_id", "=", projectId)
      .orderBy("sequence")
      .execute()
    return rows.map(mapRow)
  }

  public async find(projectId: ProjectId, chapterId: string): Promise<ChapterIndexRecord | undefined> {
    const row = await this.database.selectFrom("chapter_index").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_id", "=", chapterId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapRow(row)
  }

  public async nextSequence(projectId: ProjectId): Promise<number> {
    const row = await this.database.selectFrom("chapter_index").select((expression) => expression.fn.max("sequence").as("max_sequence"))
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    return Number(row?.max_sequence ?? 0) + 1
  }

  public async assignOnFirstCommit(input: Readonly<{
    projectId: ProjectId
    chapterId: string
    sequence: number
    currentSourceId: string
    currentPublishPath: string
    assignedAtMs: number
  }>): Promise<ChapterIndexRecord> {
    const existing = await this.find(input.projectId, input.chapterId)
    if (existing !== undefined) {
      await this.updateCurrent({
        projectId: input.projectId,
        chapterId: input.chapterId,
        currentSourceId: input.currentSourceId,
        currentPublishPath: input.currentPublishPath,
      })
      return (await this.find(input.projectId, input.chapterId)) as ChapterIndexRecord
    }
    await this.database.insertInto("chapter_index").values({
      project_id: input.projectId,
      chapter_id: input.chapterId,
      sequence: input.sequence,
      current_source_id: input.currentSourceId,
      current_publish_path: input.currentPublishPath,
      assigned_at_ms: input.assignedAtMs,
    }).executeTakeFirstOrThrow()
    return (await this.find(input.projectId, input.chapterId)) as ChapterIndexRecord
  }

  public async updateCurrent(input: Readonly<{
    projectId: ProjectId
    chapterId: string
    currentSourceId: string
    currentPublishPath: string
  }>): Promise<void> {
    await this.database.updateTable("chapter_index").set({
      current_source_id: input.currentSourceId,
      current_publish_path: input.currentPublishPath,
    }).where("project_id", "=", input.projectId).where("chapter_id", "=", input.chapterId).execute()
  }
}

function mapRow(row: {
  chapter_id: string
  sequence: number
  current_source_id: string
  current_publish_path: string
  assigned_at_ms: number
}): ChapterIndexRecord {
  return {
    chapterId: row.chapter_id,
    sequence: row.sequence,
    currentSourceId: row.current_source_id,
    currentPublishPath: row.current_publish_path,
    assignedAtMs: row.assigned_at_ms,
  }
}
