import type { Kysely } from "kysely"

import {
  aiPhaseSchema,
  taskKindSchema,
  taskStatusSchema,
  type ScopeId,
} from "@worldseed/contracts"

import type {
  ArtifactScope,
  CreateTaskScopeInput,
  StoredTask,
  TaskScopeRepository,
} from "../../../index.js"
import type { ArtifactScopeRow, ProjectDatabase, TaskRow } from "../database-types.js"
import { encodeJson } from "../json-codec.js"

export class SqliteTaskScopeRepository implements TaskScopeRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async create(input: CreateTaskScopeInput): Promise<ArtifactScope> {
    const project = await this.database.selectFrom("projects")
      .select("committed_sequence")
      .where("id", "=", input.projectId)
      .executeTakeFirstOrThrow()

    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("artifact_scopes").values({
        id: input.scopeId,
        project_id: input.projectId,
        task_id: input.taskId,
        turn_id: input.turnId,
        visibility: "pending",
        base_committed_sequence: project.committed_sequence,
        reason: input.reason,
        created_at: input.createdAtMs,
        retired_at: null,
      }).executeTakeFirstOrThrow()
      await transaction.insertInto("tasks").values({
        id: input.taskId,
        project_id: input.projectId,
        kind: input.kind,
        status: input.status,
        scope_id: input.scopeId,
        config_snapshot_json: encodeJson(input.configSnapshot),
        prompt_snapshot_json: encodeJson(input.promptSnapshot),
        last_phase: null,
        error_json: null,
        created_at: input.createdAtMs,
        updated_at: input.createdAtMs,
      }).executeTakeFirstOrThrow()
    })

    return {
      scopeId: input.scopeId,
      projectId: input.projectId,
      taskId: input.taskId,
      turnId: input.turnId,
      visibility: "pending",
      baseCommittedSequence: project.committed_sequence,
      reason: input.reason,
      createdAtMs: input.createdAtMs,
    }
  }

  public async findScope(scopeId: ScopeId): Promise<ArtifactScope | undefined> {
    const row = await this.database.selectFrom("artifact_scopes").selectAll().where("id", "=", scopeId).executeTakeFirst()
    return row === undefined ? undefined : mapScope(row)
  }

  public async findTask(taskId: string): Promise<StoredTask | undefined> {
    const row = await this.database.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirst()
    return row === undefined ? undefined : mapTask(row)
  }
}

function mapScope(row: ArtifactScopeRow): ArtifactScope {
  return {
    scopeId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    visibility: row.visibility,
    baseCommittedSequence: row.base_committed_sequence,
    reason: row.reason,
    createdAtMs: row.created_at,
    ...(row.retired_at === null ? {} : { retiredAtMs: row.retired_at }),
  }
}

function mapTask(row: TaskRow): StoredTask {
  return {
    taskId: row.id,
    projectId: row.project_id,
    scopeId: row.scope_id,
    kind: taskKindSchema.parse(row.kind),
    status: taskStatusSchema.parse(row.status),
    ...(row.last_phase === null ? {} : { lastPhase: aiPhaseSchema.parse(row.last_phase) }),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  }
}
