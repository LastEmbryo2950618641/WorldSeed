import { createHash } from "node:crypto"

import type { Kysely } from "kysely"

import type {
  SettingsLineageEntry,
  SettingsLineageOp,
  SettingsLineageSourceKind,
} from "@worldseed/contracts"

import type { ProjectDatabase, SettingsCommitRow } from "../database-types.js"

export function digestSettingsMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex")
}

export function isSettingsLineagePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/")
  return normalized.startsWith("设定集/") && normalized.endsWith(".md")
}

export type SettingsLineageRecordInput = Readonly<{
  projectId: string
  relativePath: string
  markdown: string
  sourceKind: SettingsLineageSourceKind
  sourceRef?: string
  summary?: string
  causingChapterId?: string
  causingChapterSequence?: number
  storyTime?: string
  commitId: string
  createdAtMs: number
}>

export class SqliteSettingsLineageRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async hasAnyCommit(projectId: string): Promise<boolean> {
    const row = await this.database.selectFrom("settings_commits")
      .select("commit_id")
      .where("project_id", "=", projectId)
      .limit(1)
      .executeTakeFirst()
    return row !== undefined
  }

  public async nextCommitSeq(projectId: string): Promise<number> {
    const row = await this.database.selectFrom("settings_commits")
      .select(({ fn }) => fn.max("commit_seq").as("max_seq"))
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    const max = row?.max_seq
    return typeof max === "number" ? max + 1 : 1
  }

  public async recordUpsert(input: SettingsLineageRecordInput): Promise<SettingsLineageEntry> {
    const digest = digestSettingsMarkdown(input.markdown)
    const existingBlob = await this.database.selectFrom("settings_blobs")
      .select("digest")
      .where("digest", "=", digest)
      .executeTakeFirst()
    if (existingBlob === undefined) {
      await this.database.insertInto("settings_blobs").values({
        digest,
        markdown: input.markdown,
        byte_size: Buffer.byteLength(input.markdown, "utf8"),
        created_at_ms: input.createdAtMs,
      }).executeTakeFirstOrThrow()
    }

    const head = await this.database.selectFrom("settings_heads")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("relative_path", "=", input.relativePath)
      .executeTakeFirst()
    if (head?.blob_digest === digest) {
      return this.getEntry(head.commit_id) as Promise<SettingsLineageEntry>
    }

    const commitSeq = await this.nextCommitSeq(input.projectId)
    await this.database.insertInto("settings_commits").values({
      commit_id: input.commitId,
      project_id: input.projectId,
      commit_seq: commitSeq,
      relative_path: input.relativePath,
      op: "upsert",
      blob_digest: digest,
      causing_chapter_id: input.causingChapterId ?? null,
      causing_chapter_sequence: input.causingChapterSequence ?? null,
      story_time: input.storyTime ?? null,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef ?? null,
      summary: input.summary ?? null,
      created_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()

    await this.database.insertInto("settings_heads").values({
      project_id: input.projectId,
      relative_path: input.relativePath,
      commit_id: input.commitId,
      blob_digest: digest,
      commit_seq: commitSeq,
      updated_at_ms: input.createdAtMs,
    }).onConflict((oc) => oc.columns(["project_id", "relative_path"]).doUpdateSet({
      commit_id: input.commitId,
      blob_digest: digest,
      commit_seq: commitSeq,
      updated_at_ms: input.createdAtMs,
    })).executeTakeFirstOrThrow()

    return {
      commitId: input.commitId,
      commitSeq,
      relativePath: input.relativePath,
      op: "upsert",
      blobDigest: digest,
      ...(input.causingChapterId === undefined ? {} : { causingChapterId: input.causingChapterId }),
      ...(input.causingChapterSequence === undefined ? {} : { causingChapterSequence: input.causingChapterSequence }),
      ...(input.storyTime === undefined ? {} : { storyTime: input.storyTime }),
      sourceKind: input.sourceKind,
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdAtMs: input.createdAtMs,
    }
  }

  public async listByPath(input: Readonly<{
    projectId: string
    relativePath: string
    limit?: number
  }>): Promise<readonly SettingsLineageEntry[]> {
    let query = this.database.selectFrom("settings_commits")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("relative_path", "=", input.relativePath)
      .orderBy("commit_seq", "desc")
    if (input.limit !== undefined) query = query.limit(input.limit)
    const rows = await query.execute()
    return rows.map(mapEntry)
  }

  public async listTrackedPaths(projectId: string): Promise<readonly string[]> {
    const rows = await this.database.selectFrom("settings_heads")
      .select("relative_path")
      .where("project_id", "=", projectId)
      .orderBy("relative_path", "asc")
      .execute()
    return rows.map((row) => row.relative_path)
  }

  public async getEntry(commitId: string): Promise<SettingsLineageEntry | undefined> {
    const row = await this.database.selectFrom("settings_commits")
      .selectAll()
      .where("commit_id", "=", commitId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapEntry(row)
  }

  public async getMarkdown(digest: string): Promise<string | undefined> {
    const row = await this.database.selectFrom("settings_blobs")
      .select("markdown")
      .where("digest", "=", digest)
      .executeTakeFirst()
    return row?.markdown
  }

  public async findPreviousMarkdown(input: Readonly<{
    projectId: string
    relativePath: string
    commitSeq: number
  }>): Promise<string | undefined> {
    const row = await this.database.selectFrom("settings_commits")
      .select(["blob_digest", "op"])
      .where("project_id", "=", input.projectId)
      .where("relative_path", "=", input.relativePath)
      .where("commit_seq", "<", input.commitSeq)
      .orderBy("commit_seq", "desc")
      .limit(1)
      .executeTakeFirst()
    if (row === undefined || row.op === "delete" || row.blob_digest === null) return undefined
    return this.getMarkdown(row.blob_digest)
  }

  public async resolveAsOfMarkdown(input: Readonly<{
    projectId: string
    relativePath: string
    chapterSequence: number
  }>): Promise<Readonly<{ commitId: string; commitSeq: number; markdown: string }> | undefined> {
    const row = await this.database.selectFrom("settings_commits")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("relative_path", "=", input.relativePath)
      .where("op", "=", "upsert")
      .where((eb) => eb.or([
        eb("causing_chapter_sequence", "is", null),
        eb("causing_chapter_sequence", "<=", input.chapterSequence),
      ]))
      .orderBy("commit_seq", "desc")
      .limit(1)
      .executeTakeFirst()
    if (row === undefined || row.blob_digest === null) return undefined
    const markdown = await this.getMarkdown(row.blob_digest)
    if (markdown === undefined) return undefined
    return {
      commitId: row.commit_id,
      commitSeq: row.commit_seq,
      markdown,
    }
  }

  public async headMeta(input: Readonly<{
    projectId: string
    relativePath: string
  }>): Promise<Readonly<{
    relativePath: string
    commitId?: string
    commitSeq?: number
    blobDigest?: string
    updatedAtMs?: number
    lastCause?: Readonly<{
      causingChapterSequence?: number
      sourceKind: SettingsLineageSourceKind
      summary?: string
    }>
  }>> {
    const head = await this.database.selectFrom("settings_heads")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("relative_path", "=", input.relativePath)
      .executeTakeFirst()
    if (head === undefined) return { relativePath: input.relativePath }
    const commit = await this.getEntry(head.commit_id)
    return {
      relativePath: input.relativePath,
      commitId: head.commit_id,
      commitSeq: head.commit_seq,
      ...(head.blob_digest === null ? {} : { blobDigest: head.blob_digest }),
      updatedAtMs: head.updated_at_ms,
      ...(commit === undefined ? {} : {
        lastCause: {
          sourceKind: commit.sourceKind,
          ...(commit.causingChapterSequence === undefined
            ? {}
            : { causingChapterSequence: commit.causingChapterSequence }),
          ...(commit.summary === undefined ? {} : { summary: commit.summary }),
        },
      }),
    }
  }

  public async annotate(input: Readonly<{
    commitId: string
    storyTime?: string | null
    summary?: string | null
  }>): Promise<SettingsLineageEntry | undefined> {
    const existing = await this.getEntry(input.commitId)
    if (existing === undefined) return undefined
    const patch: {
      story_time?: string | null
      summary?: string | null
    } = {}
    if (input.storyTime !== undefined) {
      patch.story_time = input.storyTime === null || input.storyTime.trim().length === 0
        ? null
        : input.storyTime.trim().slice(0, 200)
    }
    if (input.summary !== undefined) {
      patch.summary = input.summary === null || input.summary.trim().length === 0
        ? null
        : input.summary.trim().slice(0, 500)
    }
    if (Object.keys(patch).length === 0) return existing
    await this.database.updateTable("settings_commits")
      .set(patch)
      .where("commit_id", "=", input.commitId)
      .executeTakeFirst()
    return this.getEntry(input.commitId)
  }
}

function mapEntry(row: SettingsCommitRow): SettingsLineageEntry {
  return {
    commitId: row.commit_id,
    commitSeq: row.commit_seq,
    relativePath: row.relative_path,
    op: row.op as SettingsLineageOp,
    ...(row.blob_digest === null ? {} : { blobDigest: row.blob_digest }),
    ...(row.causing_chapter_id === null ? {} : { causingChapterId: row.causing_chapter_id }),
    ...(row.causing_chapter_sequence === null
      ? {}
      : { causingChapterSequence: row.causing_chapter_sequence }),
    ...(row.story_time === null ? {} : { storyTime: row.story_time }),
    sourceKind: row.source_kind,
    ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    createdAtMs: row.created_at_ms,
  }
}
