import type { Kysely } from "kysely"

import type { ProjectId, RevisionDraftVersion, RevisionDraftVersionSource } from "@worldseed/contracts"

import { digest } from "../../../core/index.js"
import type { ProjectDatabase } from "../database-types.js"

export type StoredDraftVersionInsert = Readonly<{
  versionId: string
  projectId: ProjectId
  revisionTaskId: string
  parentVersionId?: string
  source: RevisionDraftVersionSource
  messageId?: string
  heading: string
  body: string
  createdAtMs: number
}>

export class SqliteRevisionDraftVersionRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async list(revisionTaskId: string): Promise<readonly RevisionDraftVersion[]> {
    const rows = await this.database.selectFrom("revision_draft_versions").selectAll()
      .where("revision_task_id", "=", revisionTaskId)
      .orderBy("created_at_ms", "asc")
      .orderBy("version_id", "asc")
      .execute()
    const latestId = rows.at(-1)?.version_id
    return rows.map((row, index) => ({
      versionId: row.version_id,
      projectId: row.project_id,
      revisionTaskId: row.revision_task_id,
      ...(row.parent_version_id === null ? {} : { parentVersionId: row.parent_version_id }),
      source: row.source,
      ...(row.message_id === null ? {} : { messageId: row.message_id }),
      label: `v${String(index)}`,
      heading: row.heading,
      body: row.body,
      bodyDigest: row.body_digest,
      createdAtMs: row.created_at_ms,
      isLatest: row.version_id === latestId,
    }))
  }

  public async find(versionId: string): Promise<RevisionDraftVersion | undefined> {
    const row = await this.database.selectFrom("revision_draft_versions").selectAll()
      .where("version_id", "=", versionId)
      .executeTakeFirst()
    if (row === undefined) return undefined
    const listed = await this.list(row.revision_task_id)
    return listed.find((item) => item.versionId === versionId)
  }

  public async append(input: StoredDraftVersionInsert): Promise<RevisionDraftVersion> {
    const bodyDigest = digest(input.body)
    await this.database.insertInto("revision_draft_versions").values({
      version_id: input.versionId,
      project_id: input.projectId,
      revision_task_id: input.revisionTaskId,
      parent_version_id: input.parentVersionId ?? null,
      source: input.source,
      message_id: input.messageId ?? null,
      heading: input.heading,
      body: input.body,
      body_digest: bodyDigest,
      created_at_ms: input.createdAtMs,
    }).execute()
    const stored = await this.find(input.versionId)
    if (stored === undefined) throw new Error("Failed to persist revision draft version")
    return stored
  }
}
