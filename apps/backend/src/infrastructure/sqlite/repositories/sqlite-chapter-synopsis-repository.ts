import type { Kysely } from "kysely"

import type { ChapterSynopsis, ProjectId } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"

export class SqliteChapterSynopsisRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async findByChapterId(projectId: ProjectId, chapterId: string): Promise<ChapterSynopsis | undefined> {
    const row = await this.database.selectFrom("chapter_synopsis").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_id", "=", chapterId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapRow(row)
  }

  public async findByChapterPath(projectId: ProjectId, chapterPath: string): Promise<ChapterSynopsis | undefined> {
    const row = await this.database.selectFrom("chapter_synopsis").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_path", "=", chapterPath)
      .executeTakeFirst()
    return row === undefined ? undefined : mapRow(row)
  }

  public async findByChapterSequence(projectId: ProjectId, chapterSequence: number): Promise<ChapterSynopsis | undefined> {
    const row = await this.database.selectFrom("chapter_synopsis").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_sequence", "=", chapterSequence)
      .orderBy("linked_at_ms", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : mapRow(row)
  }

  public async listByProject(projectId: ProjectId): Promise<readonly ChapterSynopsis[]> {
    const rows = await this.database.selectFrom("chapter_synopsis").selectAll()
      .where("project_id", "=", projectId)
      .orderBy("chapter_sequence", "asc")
      .execute()
    return rows.map(mapRow)
  }

  public async upsert(projectId: ProjectId, input: ChapterSynopsis): Promise<ChapterSynopsis> {
    const source = input.source === "outline_file" ? "synopsis_file" : input.source
    await this.database.insertInto("chapter_synopsis").values({
      chapter_id: input.chapterId,
      project_id: projectId,
      chapter_sequence: input.chapterSequence,
      chapter_path: input.chapterPath,
      synopsis_markdown: input.synopsisMarkdown,
      source,
      original_synopsis_path: input.originalSynopsisPath ?? null,
      turn_bootstrap_input: input.turnBootstrapInput ?? null,
      linked_at_ms: input.linkedAtMs,
    }).onConflict((conflict) => conflict.column("chapter_id").doUpdateSet({
      chapter_sequence: input.chapterSequence,
      chapter_path: input.chapterPath,
      synopsis_markdown: input.synopsisMarkdown,
      source,
      original_synopsis_path: input.originalSynopsisPath ?? null,
      turn_bootstrap_input: input.turnBootstrapInput ?? null,
      linked_at_ms: input.linkedAtMs,
    })).executeTakeFirstOrThrow()
    return { ...input, source }
  }
}

function mapRow(row: {
  chapter_id: string
  project_id: string
  chapter_sequence: number
  chapter_path: string
  synopsis_markdown: string
  source: "synopsis_file" | "conversation" | "turn_input"
  original_synopsis_path: string | null
  turn_bootstrap_input: string | null
  linked_at_ms: number
}): ChapterSynopsis {
  return {
    chapterId: row.chapter_id,
    chapterSequence: row.chapter_sequence,
    chapterPath: row.chapter_path,
    synopsisMarkdown: row.synopsis_markdown,
    source: row.source,
    ...(row.original_synopsis_path === null ? {} : { originalSynopsisPath: row.original_synopsis_path }),
    ...(row.turn_bootstrap_input === null ? {} : { turnBootstrapInput: row.turn_bootstrap_input }),
    linkedAtMs: row.linked_at_ms,
  }
}
