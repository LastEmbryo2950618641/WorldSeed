import { randomUUID } from "node:crypto"

import { sql, type Kysely, type Transaction } from "kysely"

import {
  aiPhaseSchema,
  modelContextMessageDraftSchema,
  modelContextMessageSchema,
  turnContextSchema,
  type ModelContextMessage,
  type ResettableRuntimeMetricId,
  type RuntimeMetric,
  type RuntimeMetricsSnapshot,
  type TurnContext,
} from "@worldseed/contracts"

import {
  digest,
  type CreateTurnContextRecord,
  type DecisionRecord,
  type EnsureModelContextChainInput,
  type FinishPhaseRunInput,
  type FrontierRecord,
  type GraphRevisionSpacetimeRecord,
  type InitializeRuntimeBudgetWindowsInput,
  type ResetRuntimeBudgetWindowsInput,
  type RuntimeBudgetUsage,
  type SaveTaskCheckpointInput,
  type RuleSnapshotRecord,
  type ModelContextChainRecord,
  type SceneSpacetimeBindingRecord,
  type SettlementRecord,
  type StartPhaseRunInput,
  type StoredPhaseRun,
  type TurnFinalizationRecord,
  type TurnFinalizationStatus,
  type TurnPersistencePort,
  type TurnReadEvidence,
  type TaskCheckpointRecord,
  type VerificationProbeCheckpoint,
} from "../../../index.js"
import type {
  FrontierRefRow,
  ModelContextChainRow,
  PhaseRunRow,
  ProjectDatabase,
  TaskCheckpointRow,
  TurnFinalizationRow,
  VerificationProbeExecutionRow,
} from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

type RecordedUsage = Readonly<{
  modelCalls?: number
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

  public async ensureModelContextChain(input: EnsureModelContextChainInput): Promise<ModelContextChainRecord> {
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction.selectFrom("model_context_chains").selectAll()
        .where("project_id", "=", input.projectId).executeTakeFirst()
      if (existing !== undefined) return mapModelContextChain(existing)

      const chainId = this.createId()
      const messageId = this.createId()
      const tokenEstimate = estimateTextTokens(input.systemRulesContent)
      await transaction.insertInto("model_context_chains").values({
        id: chainId,
        project_id: input.projectId,
        protocol_version: input.protocolVersion,
        system_rules_digest: input.systemRulesDigest,
        message_count: 1,
        token_estimate: tokenEstimate,
        created_at: input.createdAtMs,
        updated_at: input.createdAtMs,
      }).executeTakeFirstOrThrow()
      await transaction.insertInto("model_context_messages").values({
        id: messageId,
        project_id: input.projectId,
        chain_id: chainId,
        sequence_no: 0,
        role: "system",
        kind: "system_rules",
        task_id: null,
        turn_id: null,
        phase: null,
        content_text: input.systemRulesContent,
        content_ref: null,
        content_digest: input.systemRulesDigest,
        token_estimate: tokenEstimate,
        origin_phase_run_id: null,
        origin_index: null,
        hidden_at: null,
        created_at: input.createdAtMs,
      }).executeTakeFirstOrThrow()
      return {
        chainId,
        projectId: input.projectId,
        protocolVersion: input.protocolVersion,
        systemRulesDigest: input.systemRulesDigest,
        messageCount: 1,
        tokenEstimate,
        createdAtMs: input.createdAtMs,
        updatedAtMs: input.createdAtMs,
      }
    })
  }

  public async listModelContextMessages(chainId: string): Promise<readonly ModelContextMessage[]> {
    const rows = await this.database.selectFrom("model_context_messages").selectAll()
      .where("chain_id", "=", chainId).where("hidden_at", "is", null).orderBy("sequence_no").execute()
    return rows.map((row) => modelContextMessageSchema.parse({
      messageId: row.id,
      chainId: row.chain_id,
      projectId: row.project_id,
      sequence: row.sequence_no,
      role: row.role,
      kind: row.kind,
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      ...(row.phase === null ? {} : { phase: row.phase }),
      ...(row.origin_phase_run_id === null || row.origin_index === null ? {} : {
        originPhaseRunId: row.origin_phase_run_id,
        originIndex: row.origin_index,
      }),
      ...(row.content_text === null ? {} : { content: row.content_text }),
      ...(row.content_ref === null ? {} : { contentRef: row.content_ref }),
      contentDigest: row.content_digest,
      tokenEstimate: row.token_estimate,
      createdAtMs: row.created_at,
    }))
  }

  public async listVisibleModelContextEvidence(chainId: string): Promise<readonly TurnReadEvidence[]> {
    const rows = await this.database.selectFrom("model_context_messages")
      .innerJoin("phase_runs", "phase_runs.id", "model_context_messages.origin_phase_run_id")
      .select([
        "phase_runs.id as phase_run_id",
        "phase_runs.request_json as request_json",
        "model_context_messages.sequence_no as sequence_no",
      ])
      .where("model_context_messages.chain_id", "=", chainId)
      .where("model_context_messages.hidden_at", "is", null)
      .orderBy("model_context_messages.sequence_no")
      .execute()
    const seenRuns = new Set<string>()
    const evidenceById = new Map<string, TurnReadEvidence>()
    for (const row of rows) {
      if (seenRuns.has(row.phase_run_id)) continue
      seenRuns.add(row.phase_run_id)
      const request = decodeJson(row.request_json) as { input?: { readEvidence?: readonly unknown[] } }
      for (const candidate of request.input?.readEvidence ?? []) {
        const evidence = readTurnEvidence(candidate)
        if (evidence !== undefined) evidenceById.set(evidence.readId, evidence)
      }
    }
    return [...evidenceById.values()]
  }

  public async hideModelContextMessages(
    chainId: string,
    messageIds: readonly string[],
    hiddenAtMs: number,
  ): Promise<void> {
    if (messageIds.length === 0) return
    await this.database.transaction().execute(async (transaction) => {
      const hiddenMessages = await transaction.selectFrom("model_context_messages")
        .select(["id", "token_estimate"])
        .where("chain_id", "=", chainId)
        .where("id", "in", [...messageIds])
        .where("hidden_at", "is", null)
        .execute()
      if (hiddenMessages.length === 0) return
      const chain = await transaction.selectFrom("model_context_chains").selectAll()
        .where("id", "=", chainId).executeTakeFirstOrThrow()
      await transaction.updateTable("model_context_messages").set({ hidden_at: hiddenAtMs })
        .where("chain_id", "=", chainId)
        .where("id", "in", hiddenMessages.map((message) => message.id))
        .where("hidden_at", "is", null)
        .execute()
      const removedTokens = hiddenMessages.reduce((total, message) => total + message.token_estimate, 0)
      await transaction.updateTable("model_context_chains").set({
        token_estimate: Math.max(0, chain.token_estimate - removedTokens),
        updated_at: hiddenAtMs,
      })
        .where("id", "=", chainId).executeTakeFirstOrThrow()
    })
  }

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

  public async initializeRuntimeBudgetWindows(input: InitializeRuntimeBudgetWindowsInput): Promise<void> {
    await this.database.insertInto("turn_budget_windows").values(
      (Object.entries(input.limits) as [ResettableRuntimeMetricId, number | null][]).map(([metricId, limit]) => ({
        task_id: input.taskId,
        project_id: input.projectId,
        metric_id: metricId,
        generation: 0,
        baseline_value: 0,
        limit_value: limit,
        started_at: input.createdAtMs,
        last_reset_at: null,
        updated_at: input.createdAtMs,
      })),
    ).onConflict((conflict) => conflict.columns(["task_id", "metric_id"]).doNothing()).execute()
  }

  public async readRuntimeBudgetUsage(taskId: string, nowMs: number): Promise<RuntimeBudgetUsage> {
    const cumulative = await summarizeTaskUsage(this.database, taskId, nowMs)
    const windows = await this.database.selectFrom("turn_budget_windows").selectAll()
      .where("task_id", "=", taskId).execute()
    const baseline = new Map(windows.map((window) => [window.metric_id, window.baseline_value]))
    return {
      modelCalls: Math.max(0, cumulative.modelCalls - (baseline.get("model_calls") ?? 0)),
      inputTokens: Math.max(0, cumulative.inputTokens - (baseline.get("input_tokens") ?? 0)),
      outputTokens: Math.max(0, cumulative.outputTokens - (baseline.get("output_tokens") ?? 0)),
      wallTimeMs: Math.max(0, cumulative.wallTimeMs - (baseline.get("wall_time") ?? 0)),
    }
  }

  public async listRuntimeMetrics(taskId: string, nowMs: number): Promise<RuntimeMetricsSnapshot> {
    const task = await this.database.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirstOrThrow()
    const windows = await this.database.selectFrom("turn_budget_windows").selectAll()
      .where("task_id", "=", taskId).orderBy("metric_id").execute()
    const cumulative = await summarizeTaskUsage(this.database, taskId, nowMs)
    const current = await this.readRuntimeBudgetUsage(taskId, nowMs)
    const config = readRuntimeMetricConfig(task.config_snapshot_json)
    const context = await this.database.selectFrom("turn_contexts").select(["context_json", "kv_usage_json"])
      .where("task_id", "=", taskId).executeTakeFirst()
    const contextRecord = context === undefined ? undefined : turnContextSchema.safeParse(decodeJson(context.context_json)).data
    const chain = await this.database.selectFrom("model_context_chains").selectAll()
      .where("project_id", "=", task.project_id).executeTakeFirst()
    const compressionRows = chain === undefined ? [] : await this.database.selectFrom("model_context_messages")
      .select("hidden_at").distinct().where("chain_id", "=", chain.id).where("hidden_at", "is not", null).execute()
    const kv = readKvSummary(context?.kv_usage_json)
    const blockedMetrics = readBlockedRuntimeMetricIds(task.error_json)
    const metrics: RuntimeMetric[] = windows.map((window) => {
      const metricId = window.metric_id as ResettableRuntimeMetricId
      const cumulativeValue = runtimeMetricValue(metricId, cumulative)
      const currentValue = runtimeMetricValue(metricId, current)
      const exhausted = window.limit_value !== null && currentValue >= window.limit_value
      return {
        metricId,
        label: runtimeMetricLabel(metricId),
        scope: "turn_window",
        unit: metricId === "wall_time" ? "milliseconds" : metricId === "model_calls" ? "count" : "tokens",
        current: currentValue,
        limit: window.limit_value,
        cumulative: cumulativeValue,
        state: window.limit_value === null ? "fixed" : exhausted ? "exhausted" : currentValue >= window.limit_value * 0.8 ? "warning" : "normal",
        blocking: blockedMetrics.has(metricId) && exhausted,
        resettable: window.limit_value !== null,
        resetMode: window.limit_value === null ? "provider_fixed" : "new_window",
        resetGeneration: window.generation,
        lastResetAt: window.last_reset_at,
        description: runtimeMetricDescription(metricId, window.limit_value !== null),
      }
    })
    const contextTokens = await readLatestRequestInputTokens(this.database, taskId)
    const contextThreshold = contextRecord?.budget.maxTokens ?? config.contextThresholdTokens
    metrics.push(
      readOnlyMetric("context_tokens", "活动上下文", "context_window", "tokens", contextTokens, contextThreshold, contextTokens, contextTokens !== null && contextThreshold > 0 && contextTokens >= contextThreshold ? "exhausted" : contextTokens !== null && contextTokens >= contextThreshold * 0.8 ? "warning" : "normal", "最近一次已完成模型请求由提供方返回的真实输入 Token；请求完成前显示不可用。本地估算仅用于请求前压缩判断。"),
      readOnlyMetric("context_limit", "模型上下文上限", "context_window", "tokens", config.modelContextWindowTokens, null, config.modelContextWindowTokens, "fixed", "模型配置声明的固定上下文容量，不能通过任务重置改变。"),
      readOnlyMetric("retrieval_rounds", "当前阶段检索轮次", "phase", "count", await countCurrentRetrievalRounds(this.database, taskId), config.maxRetrievalRounds, null, "normal", "当前阶段已经消耗的选择性读取轮次。"),
      readOnlyMetric("kv_cache_hit_rate", "KV 缓存命中率", "task_total", "ratio", kv.hitRate, null, kv.hitRate, "fixed", "按提供方返回的缓存命中与未命中输入 Token 计算。"),
      readOnlyMetric("total_tokens", "累计 Token", "task_total", "tokens", cumulative.inputTokens + cumulative.outputTokens, null, cumulative.inputTokens + cumulative.outputTokens, "fixed", "本任务全部额度窗口累计的输入与输出 Token。"),
      readOnlyMetric("compression_generation", "上下文压缩代次", "context_window", "generation", compressionRows.length, null, compressionRows.length, "fixed", "活动模型链已经执行的机械压缩批次数。"),
    )
    return { taskId, capturedAtMs: nowMs, metrics }
  }

  public async resetRuntimeBudgetWindows(input: ResetRuntimeBudgetWindowsInput): Promise<RuntimeMetricsSnapshot> {
    await this.database.transaction().execute(async (transaction) => {
      const task = await transaction.selectFrom("tasks").select(["project_id", "status"])
        .where("id", "=", input.taskId).executeTakeFirstOrThrow()
      if (task.status !== "awaiting_user_decision" && task.status !== "paused") {
        throw new Error("Runtime metrics can only be reset while the task is paused")
      }
      const cumulative = await summarizeTaskUsage(transaction, input.taskId, input.resetAtMs)
      for (const metricId of input.metricIds) {
        const window = await transaction.selectFrom("turn_budget_windows").selectAll()
          .where("task_id", "=", input.taskId).where("metric_id", "=", metricId).executeTakeFirstOrThrow()
        const nextLimit = input.limits[metricId]
        if (nextLimit === null) throw new Error(`Runtime metric is fixed and cannot be reset: ${metricId}`)
        const cumulativeValue = runtimeMetricValue(metricId, cumulative)
        const previousCurrent = Math.max(0, cumulativeValue - window.baseline_value)
        await transaction.updateTable("turn_budget_windows").set({
          generation: window.generation + 1,
          baseline_value: cumulativeValue,
          limit_value: nextLimit,
          started_at: input.resetAtMs,
          last_reset_at: input.resetAtMs,
          updated_at: input.resetAtMs,
        }).where("task_id", "=", input.taskId).where("metric_id", "=", metricId).executeTakeFirstOrThrow()
        await transaction.insertInto("turn_budget_resets").values({
          id: this.createId(),
          project_id: task.project_id,
          task_id: input.taskId,
          metric_id: metricId,
          previous_generation: window.generation,
          new_generation: window.generation + 1,
          previous_current: previousCurrent,
          limit_value: nextLimit,
          created_at: input.resetAtMs,
        }).executeTakeFirstOrThrow()
      }
    })
    return this.listRuntimeMetrics(input.taskId, input.resetAtMs)
  }

  public async wereRuntimeMetricsResetAfter(
    taskId: string,
    metricIds: readonly ResettableRuntimeMetricId[],
    afterMs: number,
  ): Promise<boolean> {
    if (metricIds.length === 0) return true
    const rows = await this.database.selectFrom("turn_budget_windows").select(["metric_id", "last_reset_at"])
      .where("task_id", "=", taskId).where("metric_id", "in", [...metricIds]).execute()
    return metricIds.every((metricId) => rows.some((row) => row.metric_id === metricId && (row.last_reset_at ?? 0) >= afterMs))
  }

  public async saveTaskCheckpoint(input: SaveTaskCheckpointInput): Promise<TaskCheckpointRecord> {
    return this.database.transaction().execute(async (transaction) => {
      const latestMessage = await transaction.selectFrom("model_context_messages").select("sequence_no")
        .where("chain_id", "=", input.modelContextChainId).where("hidden_at", "is", null)
        .orderBy("sequence_no", "desc").executeTakeFirst()
      const modelContextSequence = latestMessage?.sequence_no ?? 0
      const cumulative = await summarizeTaskUsage(transaction, input.taskId, input.savedAtMs)
      const budgetWindows = await transaction.selectFrom("turn_budget_windows").selectAll()
        .where("task_id", "=", input.taskId).orderBy("metric_id").execute()
      const budgetWindowSnapshot = budgetWindows.map((window) => ({
        metricId: window.metric_id,
        current: Math.max(0, runtimeMetricValue(window.metric_id as ResettableRuntimeMetricId, cumulative) - window.baseline_value),
        limit: window.limit_value,
        generation: window.generation,
        startedAtMs: window.started_at,
        lastResetAt: window.last_reset_at,
      }))
      await transaction.insertInto("task_checkpoints").values({
        id: input.phaseRunId,
        project_id: input.projectId,
        task_id: input.taskId,
        phase_run_id: input.phaseRunId,
        context_id: input.context.contextId,
        phase: input.phase,
        model_context_chain_id: input.modelContextChainId,
        model_context_sequence: modelContextSequence,
        context_json: encodeJson(input.context),
        budget_windows_json: encodeJson(budgetWindowSnapshot),
        created_at: input.savedAtMs,
        updated_at: input.savedAtMs,
      }).onConflict((conflict) => conflict.column("id").doUpdateSet({
        context_json: encodeJson(input.context),
        budget_windows_json: encodeJson(budgetWindowSnapshot),
        model_context_sequence: modelContextSequence,
        updated_at: input.savedAtMs,
      })).executeTakeFirstOrThrow()
      await transaction.insertInto("task_checkpoint_heads").values({
        task_id: input.taskId,
        project_id: input.projectId,
        checkpoint_id: input.phaseRunId,
        updated_at: input.savedAtMs,
      }).onConflict((conflict) => conflict.column("task_id").doUpdateSet({
        checkpoint_id: input.phaseRunId,
        updated_at: input.savedAtMs,
      })).executeTakeFirstOrThrow()
      const row = await transaction.selectFrom("task_checkpoints").selectAll()
        .where("id", "=", input.phaseRunId).executeTakeFirstOrThrow()
      return mapTaskCheckpoint(row)
    })
  }

  public async findTaskCheckpointByTask(taskId: string): Promise<TaskCheckpointRecord | undefined> {
    const row = await this.database.selectFrom("task_checkpoint_heads")
      .innerJoin("task_checkpoints", "task_checkpoints.id", "task_checkpoint_heads.checkpoint_id")
      .selectAll("task_checkpoints").where("task_checkpoint_heads.task_id", "=", taskId).executeTakeFirst()
    return row === undefined ? undefined : mapTaskCheckpoint(row)
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
      if (input.status === "completed" && input.contextMessages !== undefined && input.contextMessages.length > 0) {
        const messages = input.contextMessages.map((message) => modelContextMessageDraftSchema.parse(message))
        const existingMessages = await transaction.selectFrom("model_context_messages").selectAll()
          .where("origin_phase_run_id", "=", phaseRun.id).orderBy("origin_index").execute()
        if (existingMessages.length === 0) {
          const chain = await transaction.selectFrom("model_context_chains").selectAll()
            .where("project_id", "=", phaseRun.project_id).executeTakeFirstOrThrow()
          const rows = messages.map((message, index) => {
            const contentValue = message.content ?? message.contentRef
            if (contentValue === undefined) throw new Error("Model context message has no content source")
            return {
              id: this.createId(),
              project_id: phaseRun.project_id,
              chain_id: chain.id,
              sequence_no: chain.message_count + index,
              role: message.role,
              kind: message.kind,
              task_id: message.taskId ?? phaseRun.task_id,
              turn_id: message.turnId ?? context.turn_id,
              phase: message.phase ?? aiPhaseSchema.parse(phaseRun.phase),
              content_text: message.content ?? null,
              content_ref: message.contentRef ?? null,
              content_digest: digest(contentValue),
              token_estimate: message.content === undefined ? 0 : estimateTextTokens(message.content),
              origin_phase_run_id: phaseRun.id,
              origin_index: index,
              hidden_at: null,
              created_at: input.finishedAtMs,
            }
          })
          await transaction.insertInto("model_context_messages").values(rows).executeTakeFirstOrThrow()
          await transaction.updateTable("model_context_chains").set({
            message_count: chain.message_count + rows.length,
            token_estimate: chain.token_estimate + rows.reduce((total, row) => total + row.token_estimate, 0),
            updated_at: input.finishedAtMs,
          }).where("id", "=", chain.id).executeTakeFirstOrThrow()
        } else {
          if (existingMessages.length !== messages.length) {
            throw new Error(`Model context exchange conflicts for phase run: ${phaseRun.id}`)
          }
          for (const [index, message] of messages.entries()) {
            const existing = existingMessages[index]
            const contentValue = message.content ?? message.contentRef
            if (existing === undefined || contentValue === undefined
              || existing.role !== message.role
              || existing.kind !== message.kind
              || existing.content_digest !== digest(contentValue)) {
              throw new Error(`Model context exchange conflicts for phase run: ${phaseRun.id}`)
            }
          }
        }
      }
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

  public async supersedePhaseRuns(
    taskId: string,
    phaseRunIds: readonly string[],
    updatedAtMs: number,
  ): Promise<void> {
    if (phaseRunIds.length === 0) return
    await this.database.transaction().execute(async (transaction) => {
      const runs = await transaction.selectFrom("phase_runs").select(["id", "project_id"])
        .where("task_id", "=", taskId).where("id", "in", [...phaseRunIds]).execute()
      if (runs.length !== phaseRunIds.length) throw new Error("Cannot supersede phase runs outside the task")
      const messages = await transaction.selectFrom("model_context_messages")
        .select(["id", "chain_id", "token_estimate"])
        .where("origin_phase_run_id", "in", runs.map((run) => run.id))
        .where("hidden_at", "is", null).execute()
      await transaction.updateTable("phase_runs").set({ status: "superseded" })
        .where("id", "in", runs.map((run) => run.id)).execute()
      const previousCheckpoint = await transaction.selectFrom("task_checkpoints")
        .innerJoin("phase_runs", "phase_runs.id", "task_checkpoints.phase_run_id")
        .select("task_checkpoints.id").where("task_checkpoints.task_id", "=", taskId)
        .where("phase_runs.status", "=", "completed").orderBy("task_checkpoints.created_at", "desc").executeTakeFirst()
      if (previousCheckpoint === undefined) {
        await transaction.deleteFrom("task_checkpoint_heads").where("task_id", "=", taskId).execute()
      } else {
        await transaction.updateTable("task_checkpoint_heads").set({
          checkpoint_id: previousCheckpoint.id,
          updated_at: updatedAtMs,
        }).where("task_id", "=", taskId).execute()
      }
      if (messages.length === 0) return
      await transaction.updateTable("model_context_messages").set({ hidden_at: updatedAtMs })
        .where("id", "in", messages.map((message) => message.id)).execute()
      for (const chainId of new Set(messages.map((message) => message.chain_id))) {
        const chain = await transaction.selectFrom("model_context_chains").selectAll()
          .where("id", "=", chainId).executeTakeFirstOrThrow()
        const removedTokens = messages.filter((message) => message.chain_id === chainId)
          .reduce((total, message) => total + message.token_estimate, 0)
        await transaction.updateTable("model_context_chains").set({
          token_estimate: Math.max(0, chain.token_estimate - removedTokens),
          updated_at: updatedAtMs,
        }).where("id", "=", chainId).executeTakeFirstOrThrow()
      }
    })
  }

  public async saveVerificationProbeCheckpoint(checkpoint: VerificationProbeCheckpoint): Promise<VerificationProbeCheckpoint> {
    const existing = await this.database.selectFrom("verification_probe_executions").selectAll()
      .where("task_id", "=", checkpoint.taskId)
      .where("phase_run_id", "=", checkpoint.phaseRunId)
      .where("plan_digest", "=", checkpoint.planDigest)
      .executeTakeFirst()
    if (existing !== undefined) {
      return mapVerificationProbeCheckpoint(existing)
    }
    await this.database.insertInto("verification_probe_executions").values({
      project_id: checkpoint.projectId,
      task_id: checkpoint.taskId,
      phase_run_id: checkpoint.phaseRunId,
      probe_index: checkpoint.probeIndex,
      plan_digest: checkpoint.planDigest,
      request_id: checkpoint.execution.requestId,
      payload_json: encodeJson({
        execution: checkpoint.execution,
        evidence: checkpoint.evidence,
        contextRead: checkpoint.contextRead,
      }),
      digest: checkpoint.recordDigest,
      created_at: checkpoint.createdAtMs,
    }).executeTakeFirstOrThrow()
    return checkpoint
  }

  public async listVerificationProbeCheckpoints(taskId: string): Promise<readonly VerificationProbeCheckpoint[]> {
    const rows = await this.database.selectFrom("verification_probe_executions").selectAll()
      .innerJoin("phase_runs", "phase_runs.id", "verification_probe_executions.phase_run_id")
      .selectAll("verification_probe_executions")
      .where("verification_probe_executions.task_id", "=", taskId)
      .where("phase_runs.status", "!=", "superseded")
      .orderBy("verification_probe_executions.probe_index").execute()
    return rows.map(mapVerificationProbeCheckpoint)
  }

  public async createFinalization(input: TurnFinalizationRecord): Promise<void> {
    await this.database.insertInto("turn_finalizations").values({
      id: input.finalizationId,
      project_id: input.projectId,
      task_id: input.taskId,
      turn_id: input.turnId,
      scope_id: input.scopeId,
      context_id: input.contextId,
      source_id: input.sourceId,
      chapter_sequence: input.chapterSequence,
      chapter_path: input.chapterPath,
      chapter_heading: input.chapterHeading,
      content_ref: input.contentRef,
      content_digest: input.contentDigest,
      content_token_estimate: input.contentTokenEstimate,
      canonical_message_id: input.canonicalMessageId,
      graph_anchor_ids_json: encodeJson(input.graphAnchorIds),
      model_calls: input.modelCalls,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      model_provider: input.modelProvider,
      model_name: input.modelName,
      kv_cache_hit_rate: input.kvCacheHitRate ?? null,
      status: input.status,
      committed_sequence: input.committedSequence ?? null,
      error_json: input.lastError === undefined ? null : encodeJson(input.lastError),
      created_at: input.createdAtMs,
      updated_at: input.updatedAtMs,
    }).executeTakeFirstOrThrow()
  }

  public async findFinalizationByTask(taskId: string): Promise<TurnFinalizationRecord | undefined> {
    const row = await this.database.selectFrom("turn_finalizations").selectAll()
      .where("task_id", "=", taskId).executeTakeFirst()
    return row === undefined ? undefined : mapTurnFinalization(row)
  }

  public async markFinalizationScopeCommitted(
    finalizationId: string,
    committedSequence: number,
    updatedAtMs: number,
  ): Promise<void> {
    await this.advanceFinalization(finalizationId, "prepared", "scope_committed", updatedAtMs, {
      committed_sequence: committedSequence,
    })
  }

  public async markFinalizationChapterPublished(finalizationId: string, updatedAtMs: number): Promise<void> {
    await this.advanceFinalization(finalizationId, "scope_committed", "chapter_published", updatedAtMs)
  }

  public async registerCanonicalChapter(finalizationId: string, updatedAtMs: number): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const row = await transaction.selectFrom("turn_finalizations").selectAll()
        .where("id", "=", finalizationId).executeTakeFirstOrThrow()
      const status = parseFinalizationStatus(row.status)
      if (finalizationStatusRank(status) >= finalizationStatusRank("chapter_registered")) return
      if (status !== "chapter_published") {
        throw new Error(`Cannot register chapter from finalization status: ${status}`)
      }
      const existing = await transaction.selectFrom("canonical_chapter_messages").selectAll()
        .where("task_id", "=", row.task_id).executeTakeFirst()
      if (existing === undefined) {
        await transaction.insertInto("canonical_chapter_messages").values({
          id: row.canonical_message_id,
          project_id: row.project_id,
          task_id: row.task_id,
          turn_id: row.turn_id,
          context_id: row.context_id,
          source_id: row.source_id,
          chapter_sequence: row.chapter_sequence,
          chapter_path: row.chapter_path,
          chapter_heading: row.chapter_heading,
          content_ref: row.content_ref,
          content_digest: row.content_digest,
          created_at: updatedAtMs,
        }).executeTakeFirstOrThrow()
      } else if (
        existing.source_id !== row.source_id
        || existing.content_digest !== row.content_digest
        || existing.chapter_path !== row.chapter_path
      ) {
        throw new Error(`Canonical chapter registration conflicts for task: ${row.task_id}`)
      }
      const chain = await transaction.selectFrom("model_context_chains").selectAll()
        .where("project_id", "=", row.project_id).executeTakeFirstOrThrow()
      const existingContextMessage = await transaction.selectFrom("model_context_messages").selectAll()
        .where("id", "=", row.canonical_message_id).executeTakeFirst()
      if (existingContextMessage === undefined) {
        await transaction.insertInto("model_context_messages").values({
          id: row.canonical_message_id,
          project_id: row.project_id,
          chain_id: chain.id,
          sequence_no: chain.message_count,
          role: "assistant",
          kind: "canonical_chapter",
          task_id: row.task_id,
          turn_id: row.turn_id,
          phase: null,
          content_text: null,
          content_ref: row.content_ref,
          content_digest: row.content_digest,
          token_estimate: row.content_token_estimate,
          origin_phase_run_id: null,
          origin_index: null,
          hidden_at: null,
          created_at: updatedAtMs,
        }).executeTakeFirstOrThrow()
        await transaction.updateTable("model_context_chains").set({
          message_count: chain.message_count + 1,
          token_estimate: chain.token_estimate + row.content_token_estimate,
          updated_at: updatedAtMs,
        }).where("id", "=", chain.id).executeTakeFirstOrThrow()
      } else if (
        existingContextMessage.chain_id !== chain.id
        || existingContextMessage.content_ref !== row.content_ref
        || existingContextMessage.content_digest !== row.content_digest
      ) {
        throw new Error(`Canonical model context message conflicts for task: ${row.task_id}`)
      }
      await transaction.updateTable("turn_finalizations").set({
        status: "chapter_registered",
        error_json: null,
        updated_at: updatedAtMs,
      }).where("id", "=", finalizationId).executeTakeFirstOrThrow()
    })
  }

  public async completeFinalization(
    finalizationId: string,
    taskId: string,
    lastPhase: Parameters<TurnPersistencePort["completeFinalization"]>[2],
    updatedAtMs: number,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const row = await transaction.selectFrom("turn_finalizations").select(["task_id", "status"])
        .where("id", "=", finalizationId).executeTakeFirstOrThrow()
      if (row.task_id !== taskId) throw new Error(`Finalization does not belong to task: ${taskId}`)
      const status = parseFinalizationStatus(row.status)
      if (status !== "chapter_registered" && status !== "completed") {
        throw new Error(`Cannot complete finalization from status: ${status}`)
      }
      await transaction.updateTable("tasks").set({
        status: "completed",
        last_phase: lastPhase,
        error_json: null,
        updated_at: updatedAtMs,
      }).where("id", "=", taskId).executeTakeFirstOrThrow()
      await transaction.updateTable("turn_finalizations").set({
        status: "completed",
        error_json: null,
        updated_at: updatedAtMs,
      }).where("id", "=", finalizationId).executeTakeFirstOrThrow()
    })
  }

  public async recordFinalizationError(
    finalizationId: string,
    error: Readonly<Record<string, unknown>>,
    updatedAtMs: number,
  ): Promise<void> {
    await this.database.updateTable("turn_finalizations").set({
      error_json: encodeJson(error),
      updated_at: updatedAtMs,
    }).where("id", "=", finalizationId).executeTakeFirstOrThrow()
  }

  private async advanceFinalization(
    finalizationId: string,
    expectedStatus: TurnFinalizationStatus,
    nextStatus: TurnFinalizationStatus,
    updatedAtMs: number,
    fields: Readonly<{ committed_sequence?: number }> = {},
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const row = await transaction.selectFrom("turn_finalizations").select(["status", "committed_sequence"])
        .where("id", "=", finalizationId).executeTakeFirstOrThrow()
      const status = parseFinalizationStatus(row.status)
      if (finalizationStatusRank(status) >= finalizationStatusRank(nextStatus)) {
        if (fields.committed_sequence !== undefined
          && row.committed_sequence !== fields.committed_sequence) {
          throw new Error(`Finalization committed sequence conflicts: ${finalizationId}`)
        }
        return
      }
      if (status !== expectedStatus) {
        throw new Error(`Cannot advance finalization from ${status} to ${nextStatus}`)
      }
      await transaction.updateTable("turn_finalizations").set({
        status: nextStatus,
        ...fields,
        error_json: null,
        updated_at: updatedAtMs,
      }).where("id", "=", finalizationId).executeTakeFirstOrThrow()
    })
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

function estimateTextTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4))
}

function mapModelContextChain(row: ModelContextChainRow): ModelContextChainRecord {
  return {
    chainId: row.id,
    projectId: row.project_id,
    protocolVersion: row.protocol_version,
    systemRulesDigest: row.system_rules_digest,
    messageCount: row.message_count,
    tokenEstimate: row.token_estimate,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  }
}

function mapTaskCheckpoint(row: TaskCheckpointRow): TaskCheckpointRecord {
  return {
    checkpointId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    phaseRunId: row.phase_run_id,
    contextId: row.context_id,
    phase: aiPhaseSchema.parse(row.phase),
    modelContextChainId: row.model_context_chain_id,
    modelContextSequence: row.model_context_sequence,
    context: turnContextSchema.parse(decodeJson(row.context_json)),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  }
}

async function summarizeTaskUsage(
  database: Kysely<ProjectDatabase> | Transaction<ProjectDatabase>,
  taskId: string,
  nowMs: number,
): Promise<RuntimeBudgetUsage> {
  const rows = await database.selectFrom("phase_runs").selectAll().where("task_id", "=", taskId).execute()
  return rows.reduce<RuntimeBudgetUsage>((total, row) => {
    const usage = decodeJson(row.usage_json) as Record<string, unknown>
    const inputTokens = readNonnegativeMetricNumber(usage.inputTokens)
    const outputTokens = readNonnegativeMetricNumber(usage.outputTokens)
    const explicitCalls = readOptionalNonnegativeMetricNumber(usage.modelCalls)
    const modelCalls = explicitCalls ?? (inputTokens > 0 || outputTokens > 0 ? 1 : 0)
    return {
      modelCalls: total.modelCalls + modelCalls,
      inputTokens: total.inputTokens + inputTokens,
      outputTokens: total.outputTokens + outputTokens,
      wallTimeMs: total.wallTimeMs + Math.max(0, (row.finished_at ?? nowMs) - row.started_at),
    }
  }, { modelCalls: 0, inputTokens: 0, outputTokens: 0, wallTimeMs: 0 })
}

function runtimeMetricValue(metricId: ResettableRuntimeMetricId, usage: RuntimeBudgetUsage): number {
  switch (metricId) {
    case "model_calls": return usage.modelCalls
    case "input_tokens": return usage.inputTokens
    case "output_tokens": return usage.outputTokens
    case "wall_time": return usage.wallTimeMs
  }
}

function runtimeMetricLabel(metricId: ResettableRuntimeMetricId): string {
  switch (metricId) {
    case "model_calls": return "模型调用"
    case "input_tokens": return "输入 Token"
    case "output_tokens": return "输出 Token"
    case "wall_time": return "执行时间"
  }
}

function runtimeMetricDescription(metricId: ResettableRuntimeMetricId, limited: boolean): string {
  if (!limited) return `${runtimeMetricLabel(metricId)}当前由模型或提供方约束，任务不建立应用额度。`
  return `${runtimeMetricLabel(metricId)}显示当前额度窗口用量；重置会建立新窗口，但不会清除累计消耗。`
}

function readOnlyMetric(
  metricId: RuntimeMetric["metricId"],
  label: string,
  scope: RuntimeMetric["scope"],
  unit: RuntimeMetric["unit"],
  current: number | null,
  limit: number | null,
  cumulative: number | null,
  state: RuntimeMetric["state"],
  description: string,
): RuntimeMetric {
  return {
    metricId,
    label,
    scope,
    unit,
    current,
    limit,
    cumulative,
    state,
    blocking: false,
    resettable: false,
    resetMode: "provider_fixed",
    resetGeneration: 0,
    lastResetAt: null,
    description,
  }
}

function readRuntimeMetricConfig(value: string): {
  modelContextWindowTokens: number
  contextThresholdTokens: number
  maxRetrievalRounds: number
} {
  const decoded = decodeJson(value)
  const root = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {}
  const runtime = typeof root.runtime === "object" && root.runtime !== null ? root.runtime as Record<string, unknown> : {}
  const projectSettings = typeof root.projectSettings === "object" && root.projectSettings !== null
    ? root.projectSettings as Record<string, unknown>
    : {}
  const execution = typeof projectSettings.execution === "object" && projectSettings.execution !== null
    ? projectSettings.execution as Record<string, unknown>
    : {}
  const modelContextWindowTokens = readPositiveMetricNumber(runtime.modelContextWindowTokens, 1_000_000)
  const thresholdRatio = readPositiveMetricNumber(execution.contextCompactionThresholdRatio, 0.97)
  return {
    modelContextWindowTokens,
    contextThresholdTokens: Math.max(1, Math.floor(modelContextWindowTokens * thresholdRatio)),
    maxRetrievalRounds: readPositiveMetricNumber(execution.maxRetrievalRounds, 10),
  }
}

function readKvSummary(value: string | undefined): { hitRate: number | null } {
  if (value === undefined) return { hitRate: null }
  const decoded = decodeJson(value)
  if (typeof decoded !== "object" || decoded === null) return { hitRate: null }
  const record = decoded as Record<string, unknown>
  const hits = readOptionalNonnegativeMetricNumber(record.cacheHitInputTokens)
  const misses = readOptionalNonnegativeMetricNumber(record.cacheMissInputTokens)
  if (hits === undefined || misses === undefined || hits + misses === 0) return { hitRate: null }
  return { hitRate: hits / (hits + misses) }
}

async function readLatestRequestInputTokens(database: Kysely<ProjectDatabase>, taskId: string): Promise<number | null> {
  const rows = await database.selectFrom("phase_runs").select("usage_json")
    .where("task_id", "=", taskId).where("status", "=", "completed")
    .orderBy("finished_at", "desc").orderBy("started_at", "desc").execute()
  for (const row of rows) {
    const usage = decodeJson(row.usage_json)
    if (typeof usage !== "object" || usage === null) continue
    const record = usage as Record<string, unknown>
    const lastRequestInputTokens = readOptionalNonnegativeMetricNumber(record.lastRequestInputTokens)
    if (lastRequestInputTokens !== undefined) return lastRequestInputTokens
    const inputTokens = readOptionalNonnegativeMetricNumber(record.inputTokens)
    const modelCalls = readOptionalNonnegativeMetricNumber(record.modelCalls)
    if (inputTokens !== undefined && inputTokens > 0) {
      return modelCalls !== undefined && modelCalls > 0 ? inputTokens / modelCalls : inputTokens
    }
  }
  return null
}

function readBlockedRuntimeMetricIds(value: string | null): Set<string> {
  if (value === null) return new Set()
  const decoded = decodeJson(value)
  if (typeof decoded !== "object" || decoded === null) return new Set()
  const blocked = (decoded as Record<string, unknown>).blockedMetrics
  return new Set(Array.isArray(blocked) ? blocked.filter((item): item is string => typeof item === "string") : [])
}

async function countCurrentRetrievalRounds(database: Kysely<ProjectDatabase>, taskId: string): Promise<number> {
  const latest = await database.selectFrom("phase_runs").select("phase")
    .where("task_id", "=", taskId).where("status", "!=", "superseded")
    .orderBy("started_at", "desc").executeTakeFirst()
  if (latest === undefined) return 0
  const rows = await database.selectFrom("phase_runs").select("result_json")
    .where("task_id", "=", taskId).where("phase", "=", latest.phase).where("status", "!=", "superseded").execute()
  return rows.filter((row) => {
    if (row.result_json === null) return false
    const result = decodeJson(row.result_json)
    return typeof result === "object" && result !== null && (result as Record<string, unknown>).outcome === "request_read"
  }).length
}

function readNonnegativeMetricNumber(value: unknown): number {
  return readOptionalNonnegativeMetricNumber(value) ?? 0
}

function readOptionalNonnegativeMetricNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readPositiveMetricNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
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
  const status = row.status === "running" || row.status === "completed" || row.status === "failed"
    || row.status === "cancelled" || row.status === "superseded"
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

function mapVerificationProbeCheckpoint(row: VerificationProbeExecutionRow): VerificationProbeCheckpoint {
  const payload = decodeJson(row.payload_json) as Pick<
    VerificationProbeCheckpoint,
    "execution" | "evidence" | "contextRead"
  >
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    phaseRunId: row.phase_run_id,
    probeIndex: row.probe_index,
    planDigest: row.plan_digest,
    execution: payload.execution,
    evidence: payload.evidence,
    contextRead: payload.contextRead,
    recordDigest: row.digest,
    createdAtMs: row.created_at,
  }
}

function readTurnEvidence(value: unknown): TurnReadEvidence | undefined {
  if (!isRecord(value)
    || typeof value.readId !== "string"
    || (value.visibility !== "committed" && value.visibility !== "pending")
    || typeof value.ownerKind !== "string"
    || typeof value.ownerId !== "string"
    || !Array.isArray(value.exactKeys)
    || value.exactKeys.some((item) => typeof item !== "string")
    || typeof value.semanticText !== "string"
    || !Array.isArray(value.sourceRefs)
    || typeof value.digest !== "string") return undefined
  return value as TurnReadEvidence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const finalizationStatuses = [
  "prepared",
  "scope_committed",
  "chapter_published",
  "chapter_registered",
  "completed",
] as const satisfies readonly TurnFinalizationStatus[]

function parseFinalizationStatus(value: string): TurnFinalizationStatus {
  if ((finalizationStatuses as readonly string[]).includes(value)) return value as TurnFinalizationStatus
  throw new Error(`Unknown turn finalization status: ${value}`)
}

function finalizationStatusRank(status: TurnFinalizationStatus): number {
  return finalizationStatuses.indexOf(status)
}

function mapTurnFinalization(row: TurnFinalizationRow): TurnFinalizationRecord {
  return {
    finalizationId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    scopeId: row.scope_id,
    contextId: row.context_id,
    sourceId: row.source_id,
    chapterSequence: row.chapter_sequence,
    chapterPath: row.chapter_path,
    chapterHeading: row.chapter_heading,
    contentRef: row.content_ref,
    contentDigest: row.content_digest,
    contentTokenEstimate: row.content_token_estimate,
    canonicalMessageId: row.canonical_message_id,
    graphAnchorIds: decodeJson(row.graph_anchor_ids_json) as readonly string[],
    modelCalls: row.model_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    ...(row.kv_cache_hit_rate === null ? {} : { kvCacheHitRate: row.kv_cache_hit_rate }),
    status: parseFinalizationStatus(row.status),
    ...(row.committed_sequence === null ? {} : { committedSequence: row.committed_sequence }),
    ...(row.error_json === null ? {} : { lastError: decodeJson(row.error_json) }),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
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
