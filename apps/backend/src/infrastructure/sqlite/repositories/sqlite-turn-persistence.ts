import { randomUUID } from "node:crypto"

import { sql, type Kysely } from "kysely"

import {
  aiPhaseSchema,
  turnContextSchema,
  type TurnContext,
} from "@worldseed/contracts"

import {
  digest,
  type CreateTurnContextRecord,
  type DecisionRecord,
  type FinishPhaseRunInput,
  type FrontierRecord,
  type GraphRevisionSpacetimeRecord,
  type RuleSnapshotRecord,
  type SceneSpacetimeBindingRecord,
  type SettlementRecord,
  type StartPhaseRunInput,
  type StoredPhaseRun,
  type TurnPersistencePort,
} from "../../../index.js"
import type { FrontierRefRow, PhaseRunRow, ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

type RecordedUsage = Readonly<{
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
  provider?: string
  model?: string
}>

export class SqliteTurnPersistence implements TurnPersistencePort {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly createId: () => string = randomUUID,
  ) {}

  public async createContext(input: CreateTurnContextRecord): Promise<void> {
    const { context } = input
    await this.database.insertInto("turn_contexts").values({
      id: context.contextId,
      project_id: context.projectId,
      task_id: context.taskId,
      turn_id: context.turnId,
      schema_version: 1,
      ledger_digest: digest(context),
      token_usage_json: encodeJson(context.budget),
      kv_usage_json: encodeJson(emptyKvUsage),
      context_json: encodeJson(context),
      created_at: input.createdAtMs,
      updated_at: input.updatedAtMs,
    }).executeTakeFirstOrThrow()
    await this.insertMissingSegments(context, input.createdAtMs)
  }

  public async saveContext(context: TurnContext, updatedAtMs: number): Promise<void> {
    await this.database.updateTable("turn_contexts").set({
      ledger_digest: digest(context),
      token_usage_json: encodeJson(context.budget),
      context_json: encodeJson(context),
      updated_at: updatedAtMs,
    }).where("id", "=", context.contextId).executeTakeFirstOrThrow()
    await this.insertMissingSegments(context, updatedAtMs)
  }

  public async startPhaseRun(input: StartPhaseRunInput): Promise<void> {
    await this.database.insertInto("phase_runs").values({
      id: input.phaseRunId,
      project_id: input.projectId,
      task_id: input.taskId,
      context_id: input.contextId,
      phase: input.phase,
      attempt: input.attempt,
      status: "running",
      request_json: encodeJson(input.request),
      result_json: null,
      usage_json: encodeJson({}),
      started_at: input.startedAtMs,
      finished_at: null,
    }).executeTakeFirstOrThrow()
  }

  public async finishPhaseRun(input: FinishPhaseRunInput): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const phaseRun = await transaction.selectFrom("phase_runs").selectAll()
        .where("id", "=", input.phaseRunId).executeTakeFirstOrThrow()
      const context = await transaction.selectFrom("turn_contexts").selectAll()
        .where("id", "=", phaseRun.context_id).executeTakeFirstOrThrow()
      const usage = input.usage as RecordedUsage
      await transaction.updateTable("phase_runs").set({
        status: input.status,
        result_json: input.result === undefined ? null : encodeJson(input.result),
        usage_json: encodeJson(input.usage),
        finished_at: input.finishedAtMs,
      }).where("id", "=", input.phaseRunId).executeTakeFirstOrThrow()
      const hasModelUsage = (usage.inputTokens ?? 0) > 0
        || (usage.outputTokens ?? 0) > 0
        || (usage.latencyMs ?? 0) > 0
        || usage.cacheHitInputTokens !== undefined
        || usage.cacheMissInputTokens !== undefined
      if (input.status === "completed" && hasModelUsage) {
        await transaction.insertInto("kv_usage").values({
          id: this.createId(),
          project_id: phaseRun.project_id,
          task_id: phaseRun.task_id,
          turn_id: context.turn_id,
          phase_run_id: phaseRun.id,
          total_input_tokens: usage.inputTokens ?? 0,
          cache_hit_input_tokens: usage.cacheHitInputTokens ?? null,
          cache_miss_input_tokens: usage.cacheMissInputTokens ?? null,
          output_tokens: usage.outputTokens ?? 0,
          latency_ms: usage.latencyMs ?? 0,
          provider: usage.provider ?? "fake",
          model: usage.model ?? "fake",
          created_at: input.finishedAtMs,
        }).executeTakeFirstOrThrow()
        const summary = await summarizeKvUsage(transaction, phaseRun.context_id)
        await transaction.updateTable("turn_contexts").set({
          kv_usage_json: encodeJson(summary),
          updated_at: input.finishedAtMs,
        }).where("id", "=", phaseRun.context_id).executeTakeFirstOrThrow()
      }
    })
  }

  public async stageRuleSnapshot(snapshot: RuleSnapshotRecord): Promise<void> {
    await this.database.insertInto("rule_snapshots").values({
      id: snapshot.id,
      project_id: snapshot.projectId,
      task_id: snapshot.taskId,
      base_rule_version: snapshot.baseRuleVersion,
      source_versions_json: encodeJson(snapshot.sourceVersions),
      selection_reasons_json: encodeJson(snapshot.selectionReasons),
      digest: snapshot.digest,
      created_at: snapshot.createdAtMs,
    }).onConflict((conflict) => conflict.columns(["project_id", "digest"]).doNothing()).execute()
  }

  public async stageDecisionRecords(records: readonly DecisionRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.database.insertInto("ai_decision_records").values(records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      task_id: record.taskId,
      scope_id: record.scopeId,
      phase_run_id: record.phaseRunId,
      decision_kind: record.decisionKind,
      reason: record.reason,
      evidence_ids_json: encodeJson(record.evidenceIds),
      payload_json: encodeJson(record.payload),
      digest: record.digest,
      created_at: record.createdAtMs,
    }))).executeTakeFirstOrThrow()
  }

  public async stageSettlementRecords(records: readonly SettlementRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.database.insertInto("settlement_records").values(records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      scope_id: record.scopeId,
      source_unit_id: record.sourceUnitId,
      graph_refs_json: encodeJson(record.graphRefs),
      reason: record.reason,
      status: record.status,
      digest: record.digest,
      created_at: record.createdAtMs,
    }))).executeTakeFirstOrThrow()
  }

  public async listSettlementsForSourceUnits(
    projectId: string,
    sourceUnitIds: readonly string[],
  ): Promise<readonly SettlementRecord[]> {
    if (sourceUnitIds.length === 0) return []
    const rows = await this.database.selectFrom("settlement_records").selectAll()
      .where("project_id", "=", projectId)
      .where("source_unit_id", "in", sourceUnitIds)
      .orderBy("created_at")
      .execute()
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      scopeId: row.scope_id,
      sourceUnitId: row.source_unit_id,
      graphRefs: decodeJson(row.graph_refs_json),
      reason: row.reason,
      status: row.status,
      digest: row.digest,
      createdAtMs: row.created_at,
    }))
  }

  public async stageSceneSpacetimeBindings(records: readonly SceneSpacetimeBindingRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.database.insertInto("scene_spacetime_bindings").values(records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      scope_id: record.scopeId,
      source_id: record.sourceId ?? null,
      scene_index: record.sceneIndex,
      scene_anchor_id: record.sceneAnchorId,
      source_unit_indexes_json: encodeJson(record.sourceUnitIndexes),
      temporal_reference_refs_json: encodeJson(record.temporalReferenceRefs),
      time_anchor_refs_json: encodeJson(record.timeAnchorRefs),
      spatial_reference_refs_json: encodeJson(record.spatialReferenceRefs),
      location_anchor_refs_json: encodeJson(record.locationAnchorRefs),
      predecessor_scene_indexes_json: encodeJson(record.predecessorSceneIndexes),
      predecessor_scene_refs_json: encodeJson(record.predecessorSceneRefs),
      transition_path_refs_json: encodeJson(record.transitionPathRefs),
      correspondence_refs_json: encodeJson(record.correspondenceRefs),
      reason: record.reason,
      self_review: record.selfReview,
      visibility: record.visibility,
      digest: record.digest,
      created_at: record.createdAtMs,
    }))).executeTakeFirstOrThrow()
  }

  public async stageGraphRevisionSpacetime(records: readonly GraphRevisionSpacetimeRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.database.insertInto("graph_revision_spacetime").values(records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      scope_id: record.scopeId,
      graph_revision_id: record.graphRevisionId,
      effect_disposition: record.effectDisposition,
      effective_scene_binding_ids_json: encodeJson(record.effectiveSceneBindingIds),
      effective_existing_scene_refs_json: encodeJson(record.effectiveExistingSceneRefs),
      current_entry_refs_json: encodeJson(record.currentEntryRefs),
      predecessor_revision_required: record.predecessorRevisionRequired ? 1 : 0,
      predecessor_revision_ids_json: encodeJson(record.predecessorRevisionIds),
      historical_return_refs_json: encodeJson(record.historicalReturnRefs),
      reason: record.reason,
      self_review: record.selfReview,
      visibility: record.visibility,
      digest: record.digest,
      created_at: record.createdAtMs,
    }))).executeTakeFirstOrThrow()
  }

  public async stageFrontiers(records: readonly FrontierRecord[]): Promise<void> {
    if (records.length === 0) return
    await this.database.insertInto("frontier_refs").values(records.map((record) => ({
      id: record.id,
      project_id: record.projectId,
      scope_id: record.scopeId,
      frontier_anchor_ref: record.frontierAnchorRef,
      disposition: record.disposition,
      last_scene_anchor_refs_json: encodeJson(record.lastSceneAnchorRefs),
      last_time_anchor_refs_json: encodeJson(record.lastTimeAnchorRefs),
      last_location_anchor_refs_json: encodeJson(record.lastLocationAnchorRefs),
      correspondence_refs_json: encodeJson(record.correspondenceRefs),
      last_processed_at: record.lastProcessedAt,
      reason: record.reason,
      revisit_condition: record.revisitCondition ?? null,
    }))).executeTakeFirstOrThrow()
  }

  public async listSchedulableFrontiers(
    projectId: string,
    limit: number,
  ): Promise<readonly FrontierRecord[]> {
    if (limit <= 0) return []
    const rows = await sql<FrontierRefRow>`
      WITH ranked_frontiers AS (
        SELECT frontier_refs.*,
          ROW_NUMBER() OVER (
            PARTITION BY frontier_refs.frontier_anchor_ref
            ORDER BY frontier_refs.last_processed_at DESC, frontier_refs.id DESC
          ) AS frontier_rank
        FROM frontier_refs
        INNER JOIN artifact_scopes ON artifact_scopes.id = frontier_refs.scope_id
        WHERE frontier_refs.project_id = ${projectId}
          AND artifact_scopes.visibility = 'committed'
      )
      SELECT id, project_id, scope_id, frontier_anchor_ref, disposition,
        last_scene_anchor_refs_json, last_time_anchor_refs_json,
        last_location_anchor_refs_json, correspondence_refs_json,
        last_processed_at, reason, revisit_condition
      FROM ranked_frontiers
      WHERE frontier_rank = 1
        AND disposition IN ('active', 'deferred')
      ORDER BY CASE disposition WHEN 'active' THEN 0 ELSE 1 END,
        last_processed_at ASC, id ASC
      LIMIT ${Math.floor(limit)}
    `.execute(this.database)
    return rows.rows.map(mapFrontier)
  }

  public async updateTask(
    taskId: string,
    status: Parameters<TurnPersistencePort["updateTask"]>[1],
    lastPhase?: Parameters<TurnPersistencePort["updateTask"]>[2],
    updatedAtMs: number = Date.now(),
    error?: unknown,
  ): Promise<void> {
    await this.database.updateTable("tasks").set({
      status,
      last_phase: lastPhase ?? null,
      error_json: error === undefined ? null : encodeJson(error),
      updated_at: updatedAtMs,
    }).where("id", "=", taskId).executeTakeFirstOrThrow()
  }

  public async findContext(contextId: string): Promise<TurnContext | undefined> {
    const row = await this.database.selectFrom("turn_contexts").select("context_json")
      .where("id", "=", contextId).executeTakeFirst()
    return row === undefined ? undefined : turnContextSchema.parse(decodeJson(row.context_json))
  }

  public async findContextByTask(taskId: string): Promise<TurnContext | undefined> {
    const row = await this.database.selectFrom("turn_contexts").select("context_json")
      .where("task_id", "=", taskId).executeTakeFirst()
    return row === undefined ? undefined : turnContextSchema.parse(decodeJson(row.context_json))
  }

  public async listPhaseRuns(taskId: string): Promise<readonly StoredPhaseRun[]> {
    const rows = await this.database.selectFrom("phase_runs").selectAll()
      .where("task_id", "=", taskId).orderBy("started_at").orderBy("id").execute()
    return rows.map(mapPhaseRun)
  }

  private async insertMissingSegments(context: TurnContext, createdAtMs: number): Promise<void> {
    if (context.segments.length === 0) return
    await this.database.insertInto("context_segments").values(context.segments.map((segment) => ({
      id: segment.segmentId,
      project_id: context.projectId,
      context_id: context.contextId,
      sequence_no: segment.sequence,
      kind: segment.kind,
      owner_ids_json: encodeJson(segment.ownerIds),
      content_ref: `digest:${segment.canonicalDigest}`,
      digest: segment.canonicalDigest,
      token_estimate: segment.tokenEstimate,
      created_at: createdAtMs,
    }))).onConflict((conflict) => conflict.column("id").doNothing()).execute()
  }
}

const emptyKvUsage = {
  totalInputTokens: 0,
  cacheHitInputTokens: 0,
  cacheMissInputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
}

async function summarizeKvUsage(database: Kysely<ProjectDatabase>, contextId: string): Promise<typeof emptyKvUsage> {
  const rows = await database.selectFrom("kv_usage")
    .innerJoin("phase_runs", "phase_runs.id", "kv_usage.phase_run_id")
    .select([
      "kv_usage.total_input_tokens",
      "kv_usage.cache_hit_input_tokens",
      "kv_usage.cache_miss_input_tokens",
      "kv_usage.output_tokens",
      "kv_usage.latency_ms",
    ])
    .where("phase_runs.context_id", "=", contextId).execute()
  return rows.reduce((total, row) => ({
    totalInputTokens: total.totalInputTokens + row.total_input_tokens,
    cacheHitInputTokens: total.cacheHitInputTokens + (row.cache_hit_input_tokens ?? 0),
    cacheMissInputTokens: total.cacheMissInputTokens + (row.cache_miss_input_tokens ?? 0),
    outputTokens: total.outputTokens + row.output_tokens,
    latencyMs: total.latencyMs + row.latency_ms,
  }), { ...emptyKvUsage })
}

function mapPhaseRun(row: PhaseRunRow): StoredPhaseRun {
  const status = row.status === "running" || row.status === "completed" || row.status === "failed" || row.status === "cancelled"
    ? row.status
    : "failed"
  return {
    phaseRunId: row.id,
    phase: aiPhaseSchema.parse(row.phase),
    status,
    attempt: row.attempt,
    request: decodeJson(row.request_json),
    ...(row.result_json === null ? {} : { result: decodeJson(row.result_json) }),
    usage: decodeJson(row.usage_json),
    startedAtMs: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAtMs: row.finished_at }),
  }
}

function mapFrontier(row: FrontierRefRow): FrontierRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    scopeId: row.scope_id,
    frontierAnchorRef: row.frontier_anchor_ref,
    disposition: row.disposition,
    lastSceneAnchorRefs: decodeJson(row.last_scene_anchor_refs_json) as string[],
    lastTimeAnchorRefs: decodeJson(row.last_time_anchor_refs_json) as string[],
    lastLocationAnchorRefs: decodeJson(row.last_location_anchor_refs_json) as string[],
    correspondenceRefs: decodeJson(row.correspondence_refs_json) as string[],
    lastProcessedAt: row.last_processed_at,
    reason: row.reason,
    ...(row.revisit_condition === null ? {} : { revisitCondition: row.revisit_condition }),
  }
}
