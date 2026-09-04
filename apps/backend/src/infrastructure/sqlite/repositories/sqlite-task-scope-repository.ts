import type { Kysely, Selectable } from "kysely"

import {
  aiPhaseSchema,
  type ProjectId,
  taskKindSchema,
  taskStatusSchema,
  type ScopeId,
} from "@worldseed/contracts"

import type {
  ArtifactScope,
  CreateTaskScopeInput,
  RecoverStaleRunningTasksInput,
  StoredTask,
  TaskScopeRepository,
} from "../../../index.js"
import type { ArtifactScopeRow, ProjectDatabase, TaskRow } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteTaskScopeRepository implements TaskScopeRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async create(input: CreateTaskScopeInput): Promise<ArtifactScope> {
    const project = await this.database.selectFrom("projects")
      .select(["committed_sequence", "active_generation"])
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
        base_generation: project.active_generation,
        committed_sequence: null,
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

  public async assertCurrentGeneration(scopeId: ScopeId): Promise<void> {
    const scope = await this.database.selectFrom("artifact_scopes")
      .innerJoin("projects", "projects.id", "artifact_scopes.project_id")
      .select([
        "artifact_scopes.base_generation as baseGeneration",
        "projects.active_generation as activeGeneration",
      ])
      .where("artifact_scopes.id", "=", scopeId)
      .executeTakeFirstOrThrow()
    if (scope.baseGeneration !== scope.activeGeneration) {
      throw new Error(`Task belongs to an inactive history generation and must be restored from its history checkpoint: ${scopeId}`)
    }
  }

  public async findTask(taskId: string): Promise<StoredTask | undefined> {
    const row = await this.database.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirst()
    return row === undefined ? undefined : mapTask(row)
  }

  public async listRecoverableTasks(projectId: ProjectId): Promise<readonly StoredTask[]> {
    const rows = await this.database.selectFrom("tasks").selectAll()
      .where("project_id", "=", projectId)
      .where("status", "in", ["awaiting_user_decision", "paused", "waiting_for_review"])
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .execute()
    return rows.map(mapTask)
  }

  public async findLatestTask(projectId: ProjectId): Promise<StoredTask | undefined> {
    const row = await this.database.selectFrom("tasks").selectAll()
      .where("project_id", "=", projectId)
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : mapTask(row)
  }

  public async recoverStaleRunningTasks(input: RecoverStaleRunningTasksInput): Promise<readonly StoredTask[]> {
    const runningQuery = this.database.selectFrom("tasks").selectAll()
      .where("project_id", "=", input.projectId)
      .where("status", "in", ["running", "committing"])
    const rows = input.activeTaskIds.length === 0
      ? await runningQuery.execute()
      : await runningQuery.where("id", "not in", [...input.activeTaskIds]).execute()
    if (rows.length === 0) return []

    const taskIds = rows.map((row) => row.id)
    await this.database.transaction().execute(async (transaction) => {
      await transaction.updateTable("tasks").set({
        status: "awaiting_user_decision",
        error_json: encodeJson(input.interruption),
        updated_at: input.updatedAtMs,
      }).where("id", "in", taskIds).executeTakeFirstOrThrow()
      await transaction.updateTable("phase_runs").set({
        status: "failed",
        result_json: encodeJson({ error: "Backend process restarted before the model response completed" }),
        finished_at: input.updatedAtMs,
      }).where("task_id", "in", taskIds).where("status", "=", "running").executeTakeFirst()
    })

    const recoveredIds = new Set(taskIds)
    return (await this.listRecoverableTasks(input.projectId)).filter((task) => recoveredIds.has(task.taskId))
  }
}

function mapScope(row: Selectable<ArtifactScopeRow>): ArtifactScope {
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
    configSnapshot: decodeJson(row.config_snapshot_json),
    promptSnapshot: decodeJson(row.prompt_snapshot_json),
    ...(row.last_phase === null ? {} : { lastPhase: aiPhaseSchema.parse(row.last_phase) }),
    ...(row.error_json === null ? {} : { error: decodeJson(row.error_json) }),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  }
}
