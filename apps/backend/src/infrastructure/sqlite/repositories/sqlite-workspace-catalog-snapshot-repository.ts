import {
  workspaceCatalogSnapshotSchema,
  type WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"
import type { Kysely } from "kysely"

import type { WorkspaceCatalogSnapshotRepository } from "../../../application/index.js"
import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteWorkspaceCatalogSnapshotRepository implements WorkspaceCatalogSnapshotRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async save(snapshot: WorkspaceCatalogSnapshot): Promise<void> {
    const parsed = workspaceCatalogSnapshotSchema.parse(snapshot)
    const existing = await this.read(parsed.snapshotId)
    if (existing !== undefined) {
      if (encodeJson(existing) !== encodeJson(parsed)) {
        throw new Error(`Workspace catalog snapshot is immutable: ${parsed.snapshotId}`)
      }
      return
    }
    await this.database.insertInto("workspace_catalog_snapshots").values({
      id: parsed.snapshotId,
      project_id: parsed.projectId,
      generated_at: parsed.generatedAtMs,
      digest: parsed.digest,
      entries_json: encodeJson(parsed.entries),
    }).executeTakeFirstOrThrow()
  }

  public async read(snapshotId: string): Promise<WorkspaceCatalogSnapshot | undefined> {
    const row = await this.database.selectFrom("workspace_catalog_snapshots")
      .selectAll()
      .where("id", "=", snapshotId)
      .executeTakeFirst()
    return row === undefined ? undefined : workspaceCatalogSnapshotSchema.parse({
      snapshotId: row.id,
      projectId: row.project_id,
      generatedAtMs: row.generated_at,
      entries: decodeJson(row.entries_json),
      digest: row.digest,
    })
  }

  public async attachToTask(taskId: string, snapshotId: string): Promise<void> {
    const existing = await this.database.selectFrom("task_workspace_catalog_snapshots")
      .select("snapshot_id")
      .where("task_id", "=", taskId)
      .executeTakeFirst()
    if (existing !== undefined) {
      if (existing.snapshot_id !== snapshotId) {
        throw new Error(`Task workspace catalog snapshot is immutable: ${taskId}`)
      }
      return
    }
    const snapshot = await this.read(snapshotId)
    if (snapshot === undefined) {
      throw new Error(`Workspace catalog snapshot does not exist: ${snapshotId}`)
    }
    await this.database.insertInto("task_workspace_catalog_snapshots").values({
      task_id: taskId,
      snapshot_id: snapshotId,
      attached_at: snapshot.generatedAtMs,
    }).executeTakeFirstOrThrow()
  }

  public async readForTask(taskId: string): Promise<WorkspaceCatalogSnapshot | undefined> {
    const row = await this.database.selectFrom("task_workspace_catalog_snapshots")
      .innerJoin("workspace_catalog_snapshots", "workspace_catalog_snapshots.id", "task_workspace_catalog_snapshots.snapshot_id")
      .selectAll("workspace_catalog_snapshots")
      .where("task_workspace_catalog_snapshots.task_id", "=", taskId)
      .executeTakeFirst()
    return row === undefined ? undefined : workspaceCatalogSnapshotSchema.parse({
      snapshotId: row.id,
      projectId: row.project_id,
      generatedAtMs: row.generated_at,
      entries: decodeJson(row.entries_json),
      digest: row.digest,
    })
  }
}
