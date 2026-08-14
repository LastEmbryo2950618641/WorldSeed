import type { Kysely, Selectable, Transaction } from "kysely"

import {
  PROTOCOL_VERSION,
  formatPersistentId,
  historyBranchSummarySchema,
  historyCheckoutResultSchema,
  historyEntrySummarySchema,
  historyOverviewSchema,
  historyRetentionPreviewSchema,
  modelContextMessageSchema,
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  turnContextSchema,
  type HistoryCheckoutResult,
  type HistoryBranchSummary,
  type HistoryEntrySummary,
  type HistoryManifest,
  type HistoryOverview,
  type HistoryRetentionPreview,
  type ProjectId,
  type TurnContext,
} from "@worldseed/contracts"

import type {
  BeginHistorySaveInput,
  HistoryCheckoutIntent,
  HistoryCheckoutMode,
  HistoryProjectionSnapshot,
  HistoryRepository,
  HistoryRetentionPlan,
  HistoryRetentionRewrite,
  HistorySaveIntent,
} from "../../../application/index.js"
import type {
  HistoryEntryRow,
  PhaseRunRow,
  ProjectDatabase,
  TaskCheckpointRow,
  WorldBranchRow,
} from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"
import { digest } from "../../../core/index.js"

type ProjectTransaction = Transaction<ProjectDatabase>

export class SqliteHistoryRepository implements HistoryRepository {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly createId: () => string,
  ) {}

  public async beginSave(input: BeginHistorySaveInput): Promise<HistorySaveIntent> {
    return this.database.transaction().execute(async (transaction) => {
      const branch = await this.ensureActiveBranch(transaction, input.projectId, input.createdAtMs)
      const existing = await transaction.selectFrom("history_entries").selectAll()
        .where("project_id", "=", input.projectId)
        .where("operation_id", "=", input.operationId)
        .executeTakeFirst()
      if (existing !== undefined) {
        if (existing.status === "failed") {
          await transaction.updateTable("history_entries").set({ status: "preparing", completed_at: null })
            .where("id", "=", existing.id).executeTakeFirstOrThrow()
          await transaction.updateTable("history_finalizations").set({
            status: "pending",
            step: "intent_recorded",
            error_json: null,
            updated_at: input.createdAtMs,
          }).where("project_id", "=", input.projectId)
            .where("operation_id", "=", input.operationId).executeTakeFirstOrThrow()
        }
        const current = { ...existing, status: existing.status === "failed" ? "preparing" as const : existing.status }
        return {
          entry: mapEntry(current),
          branch: mapBranch(await transaction.selectFrom("world_branches").selectAll()
            .where("id", "=", existing.branch_id).executeTakeFirstOrThrow()),
          ...(await this.readParentCommit(transaction, existing.parent_entry_id)),
          alreadyReady: existing.status === "ready",
        }
      }

      const entryId = this.createId()
      const state = await transaction.selectFrom("project_history_state").selectAll()
        .where("project_id", "=", input.projectId).executeTakeFirstOrThrow()
      const parentEntryId = branch.history_head_entry_id ?? state.selected_entry_id
      const project = await transaction.selectFrom("projects").select("committed_sequence")
        .where("id", "=", input.projectId).executeTakeFirstOrThrow()
      const row: HistoryEntryRow = {
        id: entryId,
        project_id: input.projectId,
        branch_id: branch.id,
        parent_entry_id: parentEntryId,
        kind: input.kind,
        state: input.state,
        status: "preparing",
        name: input.name,
        note: input.note ?? null,
        operation_id: input.operationId,
        git_commit_oid: null,
        manifest_digest: null,
        committed_sequence: project.committed_sequence,
        checkpoint_id: input.checkpointId ?? null,
        task_id: input.taskId ?? null,
        created_at: input.createdAtMs,
        completed_at: null,
      }
      await transaction.insertInto("history_entries").values(row).executeTakeFirstOrThrow()
      await transaction.insertInto("history_finalizations").values({
        id: this.createId(),
        project_id: input.projectId,
        entry_id: entryId,
        operation_id: input.operationId,
        operation: "save",
        status: "pending",
        step: "intent_recorded",
        payload_json: encodeJson({ entryId, branchId: branch.id }),
        error_json: null,
        created_at: input.createdAtMs,
        updated_at: input.createdAtMs,
      }).executeTakeFirstOrThrow()
      return {
        entry: mapEntry(row),
        branch: mapBranch(branch),
        ...(await this.readParentCommit(transaction, parentEntryId)),
        alreadyReady: false,
      }
    })
  }

  public async readProjectionSnapshot(projectId: ProjectId, checkpointId?: string): Promise<HistoryProjectionSnapshot> {
    const [project, activeScopes, nodeHeads, linkHeads, documentHeads, canonicalChapters, chain] = await Promise.all([
      this.database.selectFrom("projects").select(["committed_sequence", "active_generation"])
        .where("id", "=", projectId).executeTakeFirstOrThrow(),
      this.database.selectFrom("active_scope_refs").select("scope_id")
        .where("project_id", "=", projectId).orderBy("scope_id").execute(),
      this.database.selectFrom("node_heads").select([
        "node_id",
        "revision_id",
        "source_scope_id",
        "visibility",
        "effective_at",
        "digest",
      ])
        .where("project_id", "=", projectId).where("scope_key", "=", "committed").orderBy("node_id").execute(),
      this.database.selectFrom("link_heads").select([
        "link_id",
        "revision_id",
        "source_scope_id",
        "visibility",
        "effective_at",
        "digest",
      ])
        .where("project_id", "=", projectId).where("scope_key", "=", "committed").orderBy("link_id").execute(),
      this.database.selectFrom("active_document_heads").selectAll()
        .where("project_id", "=", projectId).orderBy("chapter_id").execute(),
      this.database.selectFrom("canonical_chapter_messages").selectAll()
        .where("project_id", "=", projectId).orderBy("chapter_sequence").execute(),
      this.database.selectFrom("model_context_chains").selectAll()
        .where("project_id", "=", projectId).executeTakeFirst(),
    ])
    const stableCheckpoint = checkpointId === undefined ? undefined : await this.database.selectFrom("task_checkpoints")
      .select(["model_context_sequence", "created_at"]).where("phase_run_id", "=", checkpointId)
      .where("project_id", "=", projectId).executeTakeFirst()
    const checkpointFallback = checkpointId === undefined || stableCheckpoint !== undefined
      ? undefined
      : await this.database.selectFrom("phase_runs").innerJoin("tasks", "tasks.id", "phase_runs.task_id")
        .select("phase_runs.finished_at").where("phase_runs.id", "=", checkpointId)
        .where("tasks.project_id", "=", projectId).where("phase_runs.status", "=", "completed")
        .executeTakeFirstOrThrow()
    const checkpointCapturedAt = stableCheckpoint?.created_at ?? checkpointFallback?.finished_at ?? undefined
    let messageQuery = chain === undefined ? undefined : this.database.selectFrom("model_context_messages").selectAll()
      .where("chain_id", "=", chain.id)
    if (messageQuery !== undefined && checkpointCapturedAt !== undefined) {
      messageQuery = messageQuery.where("created_at", "<=", checkpointCapturedAt as number)
        .where("sequence_no", "<=", stableCheckpoint?.model_context_sequence ?? Number.MAX_SAFE_INTEGER)
    }
    const messages = messageQuery === undefined ? [] : await messageQuery.orderBy("sequence_no").execute()
    const hiddenMessages = messages.flatMap((row) => row.hidden_at !== null
      && (checkpointCapturedAt === undefined || row.hidden_at <= checkpointCapturedAt)
      ? [{ messageId: row.id, hiddenAtMs: row.hidden_at }]
      : [])
    return {
      committedSequence: project.committed_sequence,
      activeGeneration: project.active_generation,
      activeScopeIds: activeScopes.map((row) => row.scope_id),
      nodeHeads: nodeHeads.map((row) => ({
        objectId: row.node_id,
        revisionId: row.revision_id,
        sourceScopeId: row.source_scope_id,
        visibility: row.visibility,
        effectiveAtMs: row.effective_at,
        digest: row.digest,
      })),
      linkHeads: linkHeads.map((row) => ({
        objectId: row.link_id,
        revisionId: row.revision_id,
        sourceScopeId: row.source_scope_id,
        visibility: row.visibility,
        effectiveAtMs: row.effective_at,
        digest: row.digest,
      })),
      documentHeads: documentHeads.map((row) => ({
        chapterId: row.chapter_id,
        documentVersionId: row.document_version_id,
        scopeId: row.scope_id,
      })),
      canonicalChapters: canonicalChapters
        .filter((row) => checkpointCapturedAt === undefined || row.created_at <= checkpointCapturedAt)
        .map((row) => ({
          messageId: row.id,
          taskId: row.task_id,
          turnId: row.turn_id,
          contextId: row.context_id,
          sourceId: row.source_id,
          chapterSequence: row.chapter_sequence,
          chapterPath: row.chapter_path,
          chapterHeading: row.chapter_heading,
          contentRef: row.content_ref,
          contentDigest: row.content_digest,
          createdAtMs: row.created_at,
        })),
      ...(chain === undefined ? {} : {
        modelContext: {
          chainId: chain.id,
          hiddenMessages,
          messages: messages.map((row) => modelContextMessageSchema.parse({
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
          })),
        },
      }),
      baseRulesDigest: chain?.system_rules_digest ?? "uninitialized",
    }
  }

  public async completeSave(
    entryId: string,
    commitOid: string,
    manifestDigest: string,
    completedAtMs: number,
  ): Promise<HistoryEntrySummary> {
    return this.database.transaction().execute(async (transaction) => {
      const entry = await transaction.selectFrom("history_entries").selectAll().where("id", "=", entryId).executeTakeFirstOrThrow()
      if (entry.status === "ready") return mapEntry(entry)
      await transaction.updateTable("history_entries").set({
        status: "ready",
        git_commit_oid: commitOid,
        manifest_digest: manifestDigest,
        completed_at: completedAtMs,
      }).where("id", "=", entryId).executeTakeFirstOrThrow()
      await transaction.updateTable("world_branches").set({
        history_head_entry_id: entryId,
        ...(entry.kind === "automatic" && entry.state === "complete_world" ? { world_head_entry_id: entryId } : {}),
        updated_at: completedAtMs,
      }).where("id", "=", entry.branch_id).executeTakeFirstOrThrow()
      await transaction.updateTable("project_history_state").set({
        selected_entry_id: entryId,
        updated_at: completedAtMs,
      }).where("project_id", "=", entry.project_id).executeTakeFirstOrThrow()
      await transaction.updateTable("history_finalizations").set({
        status: "completed",
        step: "ready",
        error_json: null,
        updated_at: completedAtMs,
      }).where("entry_id", "=", entryId).executeTakeFirstOrThrow()
      return mapEntry({ ...entry, status: "ready", git_commit_oid: commitOid, manifest_digest: manifestDigest, completed_at: completedAtMs })
    })
  }

  public async failSave(entryId: string, error: unknown, failedAtMs: number): Promise<void> {
    const serializedError = encodeJson({ message: error instanceof Error ? error.message : String(error) })
    await this.database.transaction().execute(async (transaction) => {
      await transaction.updateTable("history_entries").set({ status: "failed" }).where("id", "=", entryId).executeTakeFirstOrThrow()
      await transaction.updateTable("history_finalizations").set({
        status: "failed",
        step: "failed",
        error_json: serializedError,
        updated_at: failedAtMs,
      }).where("entry_id", "=", entryId).executeTakeFirstOrThrow()
    })
  }

  public async listEntries(projectId: ProjectId): Promise<readonly HistoryEntrySummary[]> {
    return (await this.database.selectFrom("history_entries").selectAll()
      .where("project_id", "=", projectId).orderBy("created_at", "desc").orderBy("id", "desc").execute()).map(mapEntry)
  }

  public async listBranches(projectId: ProjectId): Promise<readonly HistoryBranchSummary[]> {
    return (await this.database.selectFrom("world_branches").selectAll()
      .where("project_id", "=", projectId).orderBy("created_at").orderBy("id").execute()).map(mapBranch)
  }

  public async readOverview(projectId: ProjectId): Promise<HistoryOverview> {
    const [entries, branches, state, graphHeads] = await Promise.all([
      this.listEntries(projectId),
      this.listBranches(projectId),
      this.database.selectFrom("project_history_state").selectAll()
        .where("project_id", "=", projectId).executeTakeFirst(),
      this.database.selectFrom("node_heads").select("node_id")
        .where("project_id", "=", projectId)
        .where("scope_key", "=", "committed")
        .where("visibility", "!=", "retired")
        .orderBy("node_id")
        .execute(),
    ])
    return historyOverviewSchema.parse({
      entries,
      branches,
      graphAnchorIds: graphHeads.map((head) => head.node_id),
      ...(state === undefined ? {} : { activeBranchId: state.active_branch_id }),
      ...(state?.selected_entry_id === null || state?.selected_entry_id === undefined
        ? {}
        : { selectedEntryId: state.selected_entry_id }),
    })
  }

  public async findPreviousAutomaticEntry(projectId: ProjectId): Promise<HistoryEntrySummary> {
    const state = await this.database.selectFrom("project_history_state").selectAll()
      .where("project_id", "=", projectId).executeTakeFirstOrThrow()
    const selected = state.selected_entry_id === null
      ? undefined
      : await this.database.selectFrom("history_entries").selectAll()
        .where("id", "=", state.selected_entry_id).executeTakeFirst()
    const query = this.database.selectFrom("history_entries").selectAll()
      .where("project_id", "=", projectId)
      .where("branch_id", "=", state.active_branch_id)
      .where("kind", "=", "automatic")
      .where("state", "=", "complete_world")
      .where("status", "=", "ready")
    const previous = selected === undefined
      ? await query.orderBy("created_at", "desc").orderBy("id", "desc").offset(1).executeTakeFirst()
      : await query.where((builder) => builder.or([
        builder("created_at", "<", selected.created_at),
        builder.and([
          builder("created_at", "=", selected.created_at),
          builder("id", "<", selected.id),
        ]),
      ])).orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst()
    if (previous === undefined) throw new Error("History previous automatic entry was not found")
    return mapEntry(previous)
  }

  public async beginCheckout(input: Readonly<{
    projectId: ProjectId
    operationId: string
    entryId: string
    mode: HistoryCheckoutMode
    startedAtMs: number
  }>): Promise<HistoryCheckoutIntent> {
    return this.database.transaction().execute(async (transaction) => {
      const entry = await transaction.selectFrom("history_entries").selectAll()
        .where("project_id", "=", input.projectId).where("id", "=", input.entryId).executeTakeFirst()
      if (entry === undefined || entry.status !== "ready" || entry.git_commit_oid === null) {
        throw new Error(`History entry is not ready or was not found: ${input.entryId}`)
      }
      const sourceBranch = await transaction.selectFrom("world_branches").selectAll()
        .where("id", "=", entry.branch_id).executeTakeFirstOrThrow()
      const project = await transaction.selectFrom("projects").select("active_generation")
        .where("id", "=", input.projectId).executeTakeFirstOrThrow()
      const existing = await transaction.selectFrom("history_finalizations").selectAll()
        .where("project_id", "=", input.projectId).where("operation_id", "=", input.operationId).executeTakeFirst()
      if (existing !== undefined) {
        const payload = readCheckoutPayload(existing.payload_json)
        if (payload.entryId !== input.entryId || payload.mode !== input.mode) {
          throw new Error("History operation ID was already used for a different checkout")
        }
        if (existing.status !== "completed") {
          await transaction.updateTable("history_finalizations").set({
            status: "running",
            step: "snapshot_validation",
            error_json: null,
            updated_at: input.startedAtMs,
          }).where("id", "=", existing.id).executeTakeFirstOrThrow()
        }
        const completedResult = existing.status === "completed" && payload.branchId !== undefined && payload.activeGeneration !== undefined
          ? historyCheckoutResultSchema.parse({
            entry: mapEntry(entry),
            branch: mapBranch(await transaction.selectFrom("world_branches").selectAll()
              .where("id", "=", payload.branchId).executeTakeFirstOrThrow()),
            activeGeneration: payload.activeGeneration,
            graphAnchorIds: payload.graphAnchorIds ?? [],
            ...(payload.restoredTaskId === undefined ? {} : { restoredTaskId: payload.restoredTaskId }),
          })
          : undefined
        return {
          operationId: input.operationId,
          mode: input.mode,
          entry: mapEntry(entry),
          sourceBranch: mapBranch(sourceBranch),
          commitOid: entry.git_commit_oid,
          expectedGeneration: project.active_generation,
          alreadyCompleted: existing.status === "completed",
          ...(completedResult === undefined ? {} : { completedResult }),
        }
      }
      const conflicting = await transaction.selectFrom("history_finalizations").select("id")
        .where("project_id", "=", input.projectId)
        .where("operation", "=", "restore")
        .where("status", "in", ["pending", "running"])
        .executeTakeFirst()
      if (conflicting !== undefined) throw new Error("History checkout is busy")
      await transaction.insertInto("history_finalizations").values({
        id: this.createId(),
        project_id: input.projectId,
        entry_id: input.entryId,
        operation_id: input.operationId,
        operation: "restore",
        status: "running",
        step: "snapshot_validation",
        payload_json: encodeJson({ entryId: input.entryId, mode: input.mode }),
        error_json: null,
        created_at: input.startedAtMs,
        updated_at: input.startedAtMs,
      }).executeTakeFirstOrThrow()
      return {
        operationId: input.operationId,
        mode: input.mode,
        entry: mapEntry(entry),
        sourceBranch: mapBranch(sourceBranch),
        commitOid: entry.git_commit_oid,
        expectedGeneration: project.active_generation,
        alreadyCompleted: false,
      }
    })
  }

  public async completeCheckout(
    intent: HistoryCheckoutIntent,
    manifest: HistoryManifest,
    completedAtMs: number,
  ): Promise<HistoryCheckoutResult> {
    if (intent.completedResult !== undefined) return intent.completedResult
    return this.database.transaction().execute(async (transaction) => {
      const finalization = await transaction.selectFrom("history_finalizations").selectAll()
        .where("project_id", "=", intent.entry.projectId)
        .where("operation_id", "=", intent.operationId).executeTakeFirstOrThrow()
      if (finalization.status === "completed") throw new Error("Completed history checkout has no persisted result")
      const project = await transaction.selectFrom("projects").selectAll()
        .where("id", "=", intent.entry.projectId).executeTakeFirstOrThrow()
      if (project.active_generation !== intent.expectedGeneration) {
        throw new Error("History checkout has a stale active generation")
      }
      if (manifest.projectId !== intent.entry.projectId || manifest.entryId !== intent.entry.entryId) {
        throw new Error("History snapshot belongs to a different project or entry")
      }
      const activeGeneration = project.active_generation + 1
      const branch = intent.mode === "continue_from"
        ? await this.createCheckoutBranch(transaction, intent, completedAtMs)
        : await transaction.selectFrom("world_branches").selectAll()
          .where("id", "=", intent.sourceBranch.branchId).executeTakeFirstOrThrow()

      await transaction.deleteFrom("active_scope_refs").where("project_id", "=", intent.entry.projectId).execute()
      if (manifest.activeScopeIds.length > 0) {
        const rows = manifest.activeScopeIds.map((scopeId) => ({
          project_id: intent.entry.projectId,
          scope_id: scopeId,
        }))
        for (const batch of chunkRows(rows)) await transaction.insertInto("active_scope_refs").values(batch).execute()
      }
      await transaction.deleteFrom("active_document_heads").where("project_id", "=", intent.entry.projectId).execute()
      if (manifest.documentHeads.length > 0) {
        const rows = manifest.documentHeads.map((head) => ({
          project_id: intent.entry.projectId,
          chapter_id: head.chapterId,
          document_version_id: head.documentVersionId,
          scope_id: head.scopeId,
        }))
        for (const batch of chunkRows(rows)) await transaction.insertInto("active_document_heads").values(batch).execute()
      }
      await transaction.deleteFrom("node_heads")
        .where("project_id", "=", intent.entry.projectId).where("scope_key", "=", "committed").execute()
      if (manifest.nodeHeads.length > 0) {
        const rows = manifest.nodeHeads.map((head) => ({
          project_id: intent.entry.projectId,
          scope_key: "committed",
          source_scope_id: head.sourceScopeId,
          node_id: head.objectId,
          revision_id: head.revisionId,
          visibility: head.visibility,
          effective_at: head.effectiveAtMs,
          digest: head.digest,
        }))
        for (const batch of chunkRows(rows)) await transaction.insertInto("node_heads").values(batch).execute()
      }
      await transaction.deleteFrom("link_heads")
        .where("project_id", "=", intent.entry.projectId).where("scope_key", "=", "committed").execute()
      if (manifest.linkHeads.length > 0) {
        const rows = manifest.linkHeads.map((head) => ({
          project_id: intent.entry.projectId,
          scope_key: "committed",
          source_scope_id: head.sourceScopeId,
          link_id: head.objectId,
          revision_id: head.revisionId,
          visibility: head.visibility,
          effective_at: head.effectiveAtMs,
          digest: head.digest,
        }))
        for (const batch of chunkRows(rows)) await transaction.insertInto("link_heads").values(batch).execute()
      }
      await transaction.deleteFrom("model_context_messages").where("project_id", "=", intent.entry.projectId).execute()
      await this.restoreCanonicalChapters(transaction, intent.entry.projectId, manifest)
      if (manifest.modelContext !== undefined) {
        const hiddenMessages = new Map((manifest.modelContext.hiddenMessages ?? [])
          .map((message) => [message.messageId, message.hiddenAtMs]))
        const tokenEstimate = manifest.modelContext.messages.reduce(
          (total, message) => total + (hiddenMessages.has(message.messageId) ? 0 : message.tokenEstimate),
          0,
        )
        const nextSequence = manifest.modelContext.messages.reduce(
          (next, message) => Math.max(next, message.sequence + 1),
          0,
        )
        const existingChain = await transaction.selectFrom("model_context_chains").select("id")
          .where("project_id", "=", intent.entry.projectId).executeTakeFirst()
        if (existingChain !== undefined && existingChain.id !== manifest.modelContext.chainId) {
          throw new Error("History checkpoint model chain identity does not match the project chain")
        }
        await transaction.insertInto("model_context_chains").values({
          id: manifest.modelContext.chainId,
          project_id: intent.entry.projectId,
          protocol_version: PROTOCOL_VERSION,
          system_rules_digest: manifest.baseRulesDigest,
          message_count: nextSequence,
          token_estimate: tokenEstimate,
          created_at: manifest.createdAtMs,
          updated_at: completedAtMs,
        }).onConflict((conflict) => conflict.column("id").doUpdateSet({
          protocol_version: PROTOCOL_VERSION,
          system_rules_digest: manifest.baseRulesDigest,
          message_count: nextSequence,
          token_estimate: tokenEstimate,
          updated_at: completedAtMs,
        })).executeTakeFirstOrThrow()
        if (manifest.modelContext.messages.length > 0) {
          const rows = manifest.modelContext.messages.map((message) => ({
            id: message.messageId,
            project_id: intent.entry.projectId,
            chain_id: manifest.modelContext?.chainId as string,
            sequence_no: message.sequence,
            role: message.role,
            kind: message.kind,
            task_id: message.taskId ?? null,
            turn_id: message.turnId ?? null,
            phase: message.phase ?? null,
            content_text: message.content ?? null,
            content_ref: message.contentRef ?? null,
            content_digest: message.contentDigest,
            token_estimate: message.tokenEstimate,
            origin_phase_run_id: message.originPhaseRunId ?? null,
            origin_index: message.originIndex ?? null,
            hidden_at: hiddenMessages.get(message.messageId) ?? null,
            created_at: message.createdAtMs,
          }))
          for (const batch of chunkRows(rows)) await transaction.insertInto("model_context_messages").values(batch).execute()
        }
      }
      await transaction.updateTable("projects").set({
        committed_sequence: manifest.committedSequence,
        active_generation: activeGeneration,
        updated_at: completedAtMs,
      }).where("id", "=", intent.entry.projectId).executeTakeFirstOrThrow()
      await transaction.updateTable("project_history_state").set({
        active_branch_id: branch.id,
        selected_entry_id: intent.entry.entryId,
        updated_at: completedAtMs,
      }).where("project_id", "=", intent.entry.projectId).executeTakeFirstOrThrow()
      const restoredTaskId = manifest.taskCheckpointId === undefined || intent.entry.taskId === undefined
        ? undefined
        : await this.cloneCheckpointTask(
          transaction,
          intent,
          manifest,
          activeGeneration,
          completedAtMs,
        )
      await transaction.updateTable("history_finalizations").set({
        status: "completed",
        step: "activated",
        payload_json: encodeJson({
          entryId: intent.entry.entryId,
          mode: intent.mode,
          branchId: branch.id,
          activeGeneration,
          graphAnchorIds: manifest.nodeHeads.map((head) => head.objectId),
          ...(restoredTaskId === undefined ? {} : { restoredTaskId }),
        }),
        error_json: null,
        updated_at: completedAtMs,
      }).where("id", "=", finalization.id).executeTakeFirstOrThrow()
      return historyCheckoutResultSchema.parse({
        entry: intent.entry,
        branch: mapBranch(branch),
          activeGeneration,
          graphAnchorIds: manifest.nodeHeads.map((head) => head.objectId),
        ...(restoredTaskId === undefined ? {} : { restoredTaskId }),
      })
    })
  }

  private async restoreCanonicalChapters(
    transaction: ProjectTransaction,
    projectId: string,
    manifest: HistoryManifest,
  ): Promise<void> {
    const chapters = manifest.canonicalChapters ?? await this.rebuildLegacyCanonicalChapters(
      transaction,
      projectId,
      manifest.documentHeads.map((head) => head.documentVersionId),
    )
    await transaction.deleteFrom("canonical_chapter_messages").where("project_id", "=", projectId).execute()
    if (chapters.length === 0) return
    const rows = chapters.map((chapter) => ({
      id: chapter.messageId,
      project_id: projectId,
      task_id: chapter.taskId,
      turn_id: chapter.turnId,
      context_id: chapter.contextId,
      source_id: chapter.sourceId,
      chapter_sequence: chapter.chapterSequence,
      chapter_path: chapter.chapterPath,
      chapter_heading: chapter.chapterHeading,
      content_ref: chapter.contentRef,
      content_digest: chapter.contentDigest,
      created_at: chapter.createdAtMs,
    }))
    for (const batch of chunkRows(rows)) await transaction.insertInto("canonical_chapter_messages").values(batch).execute()
  }

  private async rebuildLegacyCanonicalChapters(
    transaction: ProjectTransaction,
    projectId: string,
    documentVersionIds: readonly string[],
  ): Promise<NonNullable<HistoryManifest["canonicalChapters"]>> {
    if (documentVersionIds.length === 0) return []
    const activeDocumentIds = new Set(documentVersionIds)
    const documents = (await transaction.selectFrom("document_versions").selectAll()
      .where("project_id", "=", projectId).execute())
      .filter((document) => activeDocumentIds.has(document.id))
    const documentBySourceId = new Map(documents.map((document) => [document.source_id, document]))
    const finalizations = await transaction.selectFrom("turn_finalizations").selectAll()
      .where("project_id", "=", projectId).where("status", "=", "completed").execute()
    return finalizations.flatMap((finalization) => {
      const document = documentBySourceId.get(finalization.source_id)
      if (document === undefined) return []
      return [{
        messageId: finalization.canonical_message_id,
        taskId: finalization.task_id,
        turnId: finalization.turn_id,
        contextId: finalization.context_id,
        sourceId: finalization.source_id,
        chapterSequence: finalization.chapter_sequence,
        chapterPath: document.publish_path,
        chapterHeading: document.heading,
        contentRef: document.content_ref,
        contentDigest: document.digest,
        createdAtMs: finalization.updated_at,
      }]
    }).sort((left, right) => left.chapterSequence - right.chapterSequence)
  }

  private async cloneCheckpointTask(
    transaction: ProjectTransaction,
    intent: HistoryCheckoutIntent,
    manifest: HistoryManifest,
    activeGeneration: number,
    restoredAtMs: number,
  ): Promise<string> {
    const originalTaskId = intent.entry.taskId as string
    const checkpoint = await transaction.selectFrom("task_checkpoints").selectAll()
      .where("phase_run_id", "=", manifest.taskCheckpointId as string)
      .where("task_id", "=", originalTaskId).executeTakeFirstOrThrow()
    const [originalTask, originalRuns] = await Promise.all([
      transaction.selectFrom("tasks").selectAll().where("id", "=", originalTaskId).executeTakeFirstOrThrow(),
      transaction.selectFrom("phase_runs").selectAll().where("task_id", "=", originalTaskId)
        .orderBy("started_at").orderBy("id").execute(),
    ])
    const checkpointIndex = originalRuns.findIndex((run) => run.id === checkpoint.phase_run_id)
    if (checkpointIndex < 0) throw new Error("History checkpoint phase run is missing from its task")
    const checkpointRuns = originalRuns.slice(0, checkpointIndex + 1)
    const newTaskId = this.createId()
    const newScopeId = this.createId()
    const newContextId = this.createId()
    const newTurnId = this.createId()
    const newSourceId = await allocatePersistentId(transaction, intent.entry.projectId, "source", restoredAtMs)
    const phaseRunIds = new Map(checkpointRuns.map((run) => [run.id, this.createId()]))
    const restoredContext = cloneCheckpointContext(
      checkpoint,
      intent.entry.projectId,
      newTaskId,
      newContextId,
      newTurnId,
      phaseRunIds,
      this.createId,
    )

    await transaction.insertInto("artifact_scopes").values({
      id: newScopeId,
      project_id: intent.entry.projectId,
      task_id: newTaskId,
      turn_id: newTurnId,
      visibility: "pending",
      base_committed_sequence: manifest.committedSequence,
      base_generation: activeGeneration,
      committed_sequence: null,
      reason: `Restore paused checkpoint ${intent.entry.entryId}`,
      created_at: restoredAtMs,
      retired_at: null,
    }).executeTakeFirstOrThrow()
    await transaction.insertInto("tasks").values({
      id: newTaskId,
      project_id: intent.entry.projectId,
      kind: originalTask.kind,
      status: "paused",
      scope_id: newScopeId,
      config_snapshot_json: originalTask.config_snapshot_json,
      prompt_snapshot_json: originalTask.prompt_snapshot_json,
      last_phase: checkpoint.phase,
      error_json: encodeJson({
        kind: "history_restore",
        message: "Restored from a manual history checkpoint",
        recoverable: true,
        blockedMetrics: [],
        phase: checkpoint.phase,
        phaseRunId: phaseRunIds.get(checkpoint.phase_run_id),
        interruptedAtMs: restoredAtMs,
      }),
      created_at: restoredAtMs,
      updated_at: restoredAtMs,
    }).executeTakeFirstOrThrow()
    await transaction.insertInto("turn_contexts").values({
      id: newContextId,
      project_id: intent.entry.projectId,
      task_id: newTaskId,
      turn_id: newTurnId,
      schema_version: 1,
      ledger_digest: digest(restoredContext),
      token_usage_json: encodeJson(restoredContext.budget),
      kv_usage_json: encodeJson({}),
      context_json: encodeJson(restoredContext),
      created_at: restoredAtMs,
      updated_at: restoredAtMs,
    }).executeTakeFirstOrThrow()
    if (restoredContext.segments.length > 0) {
      await transaction.insertInto("context_segments").values(restoredContext.segments.map((segment) => ({
        id: segment.segmentId,
        project_id: intent.entry.projectId,
        context_id: newContextId,
        sequence_no: segment.sequence,
        kind: segment.kind,
        owner_ids_json: encodeJson(segment.ownerIds),
        content_ref: `digest:${segment.canonicalDigest}`,
        digest: segment.canonicalDigest,
        token_estimate: segment.tokenEstimate,
        created_at: restoredAtMs,
      }))).execute()
    }

    for (const run of checkpointRuns) {
      const cloned = clonePhaseRun(run, {
        taskId: newTaskId,
        contextId: newContextId,
        turnId: newTurnId,
        sourceId: newSourceId,
        phaseRunIds,
        createId: this.createId,
      })
      await transaction.insertInto("phase_runs").values(cloned).executeTakeFirstOrThrow()
    }
    const probeRows = await transaction.selectFrom("verification_probe_executions").selectAll()
      .where("task_id", "=", originalTaskId)
      .where("phase_run_id", "in", checkpointRuns.map((run) => run.id)).execute()
    if (probeRows.length > 0) {
      await transaction.insertInto("verification_probe_executions").values(probeRows.map((probe) => ({
        ...probe,
        task_id: newTaskId,
        phase_run_id: phaseRunIds.get(probe.phase_run_id) as string,
      }))).execute()
    }

    const budgetSnapshot = readTaskBudgetWindowSnapshot(checkpoint.budget_windows_json)
    const cumulativeUsage = await summarizeHistoryTaskUsage(transaction, newTaskId, restoredAtMs)
    await transaction.insertInto("turn_budget_windows").values(budgetSnapshot.map((window) => ({
      task_id: newTaskId,
      project_id: intent.entry.projectId,
      metric_id: window.metricId,
      generation: window.generation,
      baseline_value: Math.max(0, historyMetricValue(window.metricId, cumulativeUsage) - window.current),
      limit_value: window.limit,
      started_at: window.startedAtMs,
      last_reset_at: window.lastResetAt,
      updated_at: restoredAtMs,
    }))).execute()
    const newCheckpointId = phaseRunIds.get(checkpoint.phase_run_id) as string
    await transaction.insertInto("task_checkpoints").values({
      id: newCheckpointId,
      project_id: intent.entry.projectId,
      task_id: newTaskId,
      phase_run_id: newCheckpointId,
      context_id: newContextId,
      phase: checkpoint.phase,
      model_context_chain_id: checkpoint.model_context_chain_id,
      model_context_sequence: checkpoint.model_context_sequence,
      context_json: encodeJson(restoredContext),
      budget_windows_json: checkpoint.budget_windows_json,
      created_at: restoredAtMs,
      updated_at: restoredAtMs,
    }).executeTakeFirstOrThrow()
    await transaction.insertInto("task_checkpoint_heads").values({
      task_id: newTaskId,
      project_id: intent.entry.projectId,
      checkpoint_id: newCheckpointId,
      updated_at: restoredAtMs,
    }).executeTakeFirstOrThrow()
    return newTaskId
  }

  public async failCheckout(operationId: string, error: unknown, failedAtMs: number): Promise<void> {
    await this.database.updateTable("history_finalizations").set({
      status: "failed",
      step: "failed",
      error_json: encodeJson({ message: error instanceof Error ? error.message : String(error) }),
      updated_at: failedAtMs,
    }).where("operation_id", "=", operationId).executeTakeFirst()
  }

  public async ensureWritableBranch(projectId: ProjectId, createdAtMs: number): Promise<HistoryBranchSummary | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const state = await transaction.selectFrom("project_history_state").selectAll()
        .where("project_id", "=", projectId).executeTakeFirst()
      if (state === undefined || state.selected_entry_id === null) return undefined
      const branch = await transaction.selectFrom("world_branches").selectAll()
        .where("id", "=", state.active_branch_id).executeTakeFirstOrThrow()
      if (branch.world_head_entry_id === null) return mapBranch(branch)
      const [selected, worldHead] = await Promise.all([
        transaction.selectFrom("history_entries").selectAll().where("id", "=", state.selected_entry_id).executeTakeFirstOrThrow(),
        transaction.selectFrom("history_entries").selectAll().where("id", "=", branch.world_head_entry_id).executeTakeFirstOrThrow(),
      ])
      if (selected.committed_sequence >= worldHead.committed_sequence) return mapBranch(branch)
      const intent: HistoryCheckoutIntent = {
        operationId: `implicit-branch:${state.selected_entry_id}:${String(createdAtMs)}`,
        mode: "continue_from",
        entry: mapEntry(selected),
        sourceBranch: mapBranch(branch),
        commitOid: selected.git_commit_oid ?? "implicit",
        expectedGeneration: 0,
        alreadyCompleted: false,
      }
      const created = await this.createCheckoutBranch(transaction, intent, createdAtMs)
      await transaction.updateTable("project_history_state").set({
        active_branch_id: created.id,
        updated_at: createdAtMs,
      }).where("project_id", "=", projectId).executeTakeFirstOrThrow()
      return mapBranch(created)
    })
  }

  public async previewRetention(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPreview> {
    const entries = await this.database.selectFrom("history_entries").select(["id", "branch_id", "created_at"])
      .where("project_id", "=", projectId).where("status", "=", "ready")
      .orderBy("created_at", "asc").orderBy("id", "asc").execute()
    const deleteCount = retentionLimit === null ? 0 : Math.max(0, entries.length - retentionLimit)
    const deleted = entries.slice(0, deleteCount)
    return historyRetentionPreviewSchema.parse({
      retentionLimit,
      currentCount: entries.length,
      deleteCount,
      ...(deleted[0] === undefined ? {} : { oldestDeletedAtMs: deleted[0].created_at }),
      ...(deleted.at(-1) === undefined ? {} : { newestDeletedAtMs: deleted.at(-1)?.created_at }),
      affectedBranchIds: [...new Set(deleted.map((entry) => entry.branch_id))].sort(),
    })
  }

  public async applyRetention(
    projectId: ProjectId,
    retentionLimit: number | null,
    deletedAtMs: number,
    rewrites: readonly HistoryRetentionRewrite[] = [],
  ): Promise<HistoryRetentionPreview> {
    const preview = await this.previewRetention(projectId, retentionLimit)
    if (preview.deleteCount === 0) return preview
    await this.database.transaction().execute(async (transaction) => {
      const deleted = await transaction.selectFrom("history_entries").selectAll()
        .where("project_id", "=", projectId).where("status", "=", "ready")
        .orderBy("created_at", "asc").orderBy("id", "asc")
        .limit(preview.deleteCount).execute()
      const deletedIds = deleted.map((entry) => entry.id)
      if (deletedIds.length === 0) return
      for (const rewrite of rewrites) {
        await transaction.updateTable("history_entries").set({
          git_commit_oid: rewrite.commitOid,
          manifest_digest: rewrite.manifestDigest,
          parent_entry_id: rewrite.parentEntryId ?? null,
        }).where("project_id", "=", projectId).where("id", "=", rewrite.entryId).executeTakeFirstOrThrow()
      }
      await transaction.updateTable("history_entries").set({ parent_entry_id: null })
        .where("parent_entry_id", "in", deletedIds).execute()
      await transaction.updateTable("world_branches").set({ fork_entry_id: null })
        .where("project_id", "=", projectId).where("fork_entry_id", "in", deletedIds).execute()
      const branches = await transaction.selectFrom("world_branches").selectAll()
        .where("project_id", "=", projectId).execute()
      for (const branch of branches) {
        const nextHead = await transaction.selectFrom("history_entries").selectAll()
          .where("project_id", "=", projectId).where("branch_id", "=", branch.id)
          .where("id", "not in", deletedIds).where("status", "=", "ready")
          .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst()
        const worldHeadDeleted = branch.world_head_entry_id !== null && deletedIds.includes(branch.world_head_entry_id)
        const historyHeadDeleted = branch.history_head_entry_id !== null && deletedIds.includes(branch.history_head_entry_id)
        if (worldHeadDeleted || historyHeadDeleted) {
          await transaction.updateTable("world_branches").set({
            ...(worldHeadDeleted ? { world_head_entry_id: nextHead?.id ?? null } : {}),
            ...(historyHeadDeleted ? { history_head_entry_id: nextHead?.id ?? null } : {}),
            updated_at: deletedAtMs,
          }).where("id", "=", branch.id).executeTakeFirstOrThrow()
        }
      }
      const state = await transaction.selectFrom("project_history_state").selectAll()
        .where("project_id", "=", projectId).executeTakeFirst()
      if (state?.selected_entry_id !== null && state?.selected_entry_id !== undefined && deletedIds.includes(state.selected_entry_id)) {
        const replacement = await transaction.selectFrom("history_entries").selectAll()
          .where("project_id", "=", projectId).where("id", "not in", deletedIds).where("status", "=", "ready")
          .orderBy("created_at", "desc").orderBy("id", "desc").executeTakeFirst()
        await transaction.updateTable("project_history_state").set({
          selected_entry_id: replacement?.id ?? null,
          ...(replacement === undefined ? {} : { active_branch_id: replacement.branch_id }),
          updated_at: deletedAtMs,
        }).where("project_id", "=", projectId).executeTakeFirstOrThrow()
      }
      await transaction.updateTable("history_finalizations").set({ entry_id: null, updated_at: deletedAtMs })
        .where("entry_id", "in", deletedIds).execute()
      await transaction.insertInto("history_retention_events").values(deleted.map((entry) => ({
        id: this.createId(),
        project_id: projectId,
        entry_id: entry.id,
        reason: `retention_limit:${String(retentionLimit)}`,
        deleted_at: deletedAtMs,
      }))).execute()
      await transaction.deleteFrom("history_entries").where("id", "in", deletedIds).execute()
    })
    return preview
  }

  public async readRetentionPlan(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPlan> {
    const preview = await this.previewRetention(projectId, retentionLimit)
    const entries = await this.database.selectFrom("history_entries").selectAll()
      .where("project_id", "=", projectId).where("status", "=", "ready")
      .orderBy("created_at", "asc").orderBy("id", "asc").execute()
    const deleted = entries.slice(0, preview.deleteCount)
    return {
      preview,
      deletedEntryIds: deleted.map((entry) => entry.id),
      retained: entries.slice(preview.deleteCount).map((entry) => {
        if (entry.git_commit_oid === null) throw new Error(`Ready history entry has no Git commit: ${entry.id}`)
        return { entry: mapEntry(entry), commitOid: entry.git_commit_oid }
      }),
    }
  }

  private async createCheckoutBranch(
    transaction: ProjectTransaction,
    intent: HistoryCheckoutIntent,
    createdAtMs: number,
  ): Promise<WorldBranchRow> {
    const branchCount = await transaction.selectFrom("world_branches").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("project_id", "=", intent.entry.projectId).executeTakeFirstOrThrow()
    const branch: WorldBranchRow = {
      id: this.createId(),
      project_id: intent.entry.projectId,
      parent_branch_id: intent.sourceBranch.branchId,
      fork_entry_id: intent.entry.entryId,
      name: `世界线 ${String(branchCount.count + 1)}`,
      status: "active",
      world_head_entry_id: intent.entry.entryId,
      history_head_entry_id: intent.entry.entryId,
      created_at: createdAtMs,
      updated_at: createdAtMs,
    }
    await transaction.insertInto("world_branches").values(branch).executeTakeFirstOrThrow()
    return branch
  }


  private async ensureActiveBranch(
    transaction: ProjectTransaction,
    projectId: ProjectId,
    nowMs: number,
  ): Promise<WorldBranchRow> {
    const state = await transaction.selectFrom("project_history_state").selectAll()
      .where("project_id", "=", projectId).executeTakeFirst()
    if (state !== undefined) {
      return transaction.selectFrom("world_branches").selectAll().where("id", "=", state.active_branch_id).executeTakeFirstOrThrow()
    }
    const branch: WorldBranchRow = {
      id: this.createId(),
      project_id: projectId,
      parent_branch_id: null,
      fork_entry_id: null,
      name: "主世界线",
      status: "active",
      world_head_entry_id: null,
      history_head_entry_id: null,
      created_at: nowMs,
      updated_at: nowMs,
    }
    await transaction.insertInto("world_branches").values(branch).executeTakeFirstOrThrow()
    await transaction.insertInto("project_history_state").values({
      project_id: projectId,
      active_branch_id: branch.id,
      selected_entry_id: null,
      updated_at: nowMs,
    }).executeTakeFirstOrThrow()
    return branch
  }

  private async readParentCommit(
    transaction: ProjectTransaction,
    parentEntryId: string | null,
  ): Promise<{ parentCommitOid?: string }> {
    if (parentEntryId === null) return {}
    const parent = await transaction.selectFrom("history_entries").select("git_commit_oid")
      .where("id", "=", parentEntryId).executeTakeFirst()
    return parent?.git_commit_oid === null || parent?.git_commit_oid === undefined
      ? {}
      : { parentCommitOid: parent.git_commit_oid }
  }
}

function chunkRows<T>(rows: readonly T[], size = 50): readonly (readonly T[])[] {
  const batches: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) batches.push(rows.slice(offset, offset + size))
  return batches
}

function readCheckoutPayload(value: string): {
  entryId: string
  mode: HistoryCheckoutMode
  branchId?: string
  activeGeneration?: number
  graphAnchorIds?: string[]
  restoredTaskId?: string
} {
  const decoded = decodeJson(value)
  if (typeof decoded !== "object" || decoded === null || !("entryId" in decoded) || !("mode" in decoded)) {
    throw new Error("History checkout finalization payload is invalid")
  }
  const payload = decoded as Record<string, unknown>
  const entryId = String(payload.entryId)
  const mode = String(payload.mode)
  if (mode !== "restore" && mode !== "continue_from" && mode !== "return_previous_round") {
    throw new Error("History checkout finalization mode is invalid")
  }
  return {
    entryId,
    mode,
    ...(typeof payload.branchId === "string" ? { branchId: payload.branchId } : {}),
    ...(typeof payload.activeGeneration === "number" ? { activeGeneration: payload.activeGeneration } : {}),
    ...(Array.isArray(payload.graphAnchorIds) && payload.graphAnchorIds.every((value) => typeof value === "string")
      ? { graphAnchorIds: payload.graphAnchorIds }
      : {}),
    ...(typeof payload.restoredTaskId === "string" ? { restoredTaskId: payload.restoredTaskId } : {}),
  }
}

function cloneCheckpointContext(
  checkpoint: Selectable<TaskCheckpointRow>,
  projectId: string,
  taskId: string,
  contextId: string,
  turnId: string,
  phaseRunIds: ReadonlyMap<string, string>,
  createId: () => string,
): TurnContext {
  const context = turnContextSchema.parse(decodeJson(checkpoint.context_json))
  return turnContextSchema.parse({
    ...context,
    projectId,
    taskId,
    contextId,
    turnId,
    segments: context.segments.map((segment) => ({
      ...segment,
      segmentId: createId(),
      ownerIds: segment.ownerIds.map((ownerId) => phaseRunIds.get(ownerId) ?? ownerId),
    })),
  })
}

function clonePhaseRun(
  run: Selectable<PhaseRunRow>,
  identity: Readonly<{
    taskId: string
    contextId: string
    turnId: string
    sourceId: string
    phaseRunIds: ReadonlyMap<string, string>
    createId: () => string
  }>,
) {
  const request = phaseRequestEnvelopeSchema.parse(decodeJson(run.request_json))
  const envelopeId = identity.createId()
  const input = typeof request.input === "object" && request.input !== null
    ? request.input as Record<string, unknown>
    : {}
  const clonedRequest = phaseRequestEnvelopeSchema.parse({
    ...request,
    envelopeId,
    taskId: identity.taskId,
    contextId: identity.contextId,
    turnId: identity.turnId,
    input: {
      ...input,
      sourceId: identity.sourceId,
      sourceUnitIds: [],
      phaseRunIds: Array.isArray(input.phaseRunIds)
        ? input.phaseRunIds.flatMap((phaseRunId: unknown): string[] => typeof phaseRunId === "string"
          ? [identity.phaseRunIds.get(phaseRunId) ?? phaseRunId]
          : [])
        : [],
    },
  })
  const clonedResult = run.result_json === null
    ? null
    : encodeJson(phaseResultEnvelopeSchema.parse({
      ...phaseResultEnvelopeSchema.parse(decodeJson(run.result_json)),
      envelopeId,
      contextId: identity.contextId,
    }))
  return {
    id: identity.phaseRunIds.get(run.id) as string,
    project_id: run.project_id,
    task_id: identity.taskId,
    context_id: identity.contextId,
    phase: run.phase,
    attempt: run.attempt,
    status: run.status,
    request_json: encodeJson(clonedRequest),
    result_json: clonedResult,
    usage_json: run.usage_json,
    started_at: run.started_at,
    finished_at: run.finished_at,
  }
}

async function allocatePersistentId(
  transaction: ProjectTransaction,
  projectId: string,
  prefix: "source",
  updatedAtMs: number,
): Promise<string> {
  const existing = await transaction.selectFrom("id_counters").select("current_value")
    .where("project_id", "=", projectId).where("prefix", "=", prefix).executeTakeFirst()
  const nextValue = (existing?.current_value ?? 0) + 1
  if (existing === undefined) {
    await transaction.insertInto("id_counters").values({
      project_id: projectId,
      prefix,
      current_value: nextValue,
      updated_at: updatedAtMs,
    }).executeTakeFirstOrThrow()
  } else {
    await transaction.updateTable("id_counters").set({ current_value: nextValue, updated_at: updatedAtMs })
      .where("project_id", "=", projectId).where("prefix", "=", prefix).executeTakeFirstOrThrow()
  }
  return formatPersistentId(prefix, nextValue)
}

type HistoryTaskUsage = Readonly<{
  modelCalls: number
  inputTokens: number
  outputTokens: number
  wallTimeMs: number
}>

type SavedBudgetWindow = Readonly<{
  metricId: "model_calls" | "input_tokens" | "output_tokens" | "wall_time"
  current: number
  limit: number | null
  generation: number
  startedAtMs: number
  lastResetAt: number | null
}>

function readTaskBudgetWindowSnapshot(value: string): readonly SavedBudgetWindow[] {
  const decoded = decodeJson(value)
  if (!Array.isArray(decoded)) throw new Error("Task checkpoint budget window snapshot is invalid")
  return decoded.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("Task checkpoint budget window is invalid")
    const record = item as Record<string, unknown>
    const metricId = record.metricId
    if (metricId !== "model_calls" && metricId !== "input_tokens" && metricId !== "output_tokens" && metricId !== "wall_time") {
      throw new Error("Task checkpoint budget metric is invalid")
    }
    if (typeof record.current !== "number" || typeof record.generation !== "number" || typeof record.startedAtMs !== "number") {
      throw new Error("Task checkpoint budget values are invalid")
    }
    return {
      metricId,
      current: record.current,
      limit: typeof record.limit === "number" ? record.limit : null,
      generation: record.generation,
      startedAtMs: record.startedAtMs,
      lastResetAt: typeof record.lastResetAt === "number" ? record.lastResetAt : null,
    }
  })
}

async function summarizeHistoryTaskUsage(
  transaction: ProjectTransaction,
  taskId: string,
  nowMs: number,
): Promise<HistoryTaskUsage> {
  const rows = await transaction.selectFrom("phase_runs").select(["usage_json", "started_at", "finished_at"])
    .where("task_id", "=", taskId).execute()
  return rows.reduce<HistoryTaskUsage>((total, row) => {
    const decoded = decodeJson(row.usage_json)
    const usage = typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : {}
    const inputTokens = historyUsageNumber(usage.inputTokens)
    const outputTokens = historyUsageNumber(usage.outputTokens)
    return {
      modelCalls: total.modelCalls + (historyOptionalUsageNumber(usage.modelCalls) ?? (inputTokens > 0 || outputTokens > 0 ? 1 : 0)),
      inputTokens: total.inputTokens + inputTokens,
      outputTokens: total.outputTokens + outputTokens,
      wallTimeMs: total.wallTimeMs + Math.max(0, (row.finished_at ?? nowMs) - row.started_at),
    }
  }, { modelCalls: 0, inputTokens: 0, outputTokens: 0, wallTimeMs: 0 })
}

function historyMetricValue(metricId: SavedBudgetWindow["metricId"], usage: HistoryTaskUsage): number {
  switch (metricId) {
    case "model_calls": return usage.modelCalls
    case "input_tokens": return usage.inputTokens
    case "output_tokens": return usage.outputTokens
    case "wall_time": return usage.wallTimeMs
  }
}

function historyUsageNumber(value: unknown): number {
  return historyOptionalUsageNumber(value) ?? 0
}

function historyOptionalUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function mapEntry(row: HistoryEntryRow): HistoryEntrySummary {
  return historyEntrySummarySchema.parse({
    entryId: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    ...(row.parent_entry_id === null ? {} : { parentEntryId: row.parent_entry_id }),
    kind: row.kind,
    state: row.state,
    status: row.status,
    name: row.name,
    ...(row.note === null ? {} : { note: row.note }),
    committedSequence: row.committed_sequence,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.checkpoint_id === null ? {} : { checkpointId: row.checkpoint_id }),
    createdAtMs: row.created_at,
    ...(row.completed_at === null ? {} : { completedAtMs: row.completed_at }),
  })
}

function mapBranch(row: WorldBranchRow): HistoryBranchSummary {
  return historyBranchSummarySchema.parse({
    branchId: row.id,
    projectId: row.project_id,
    ...(row.parent_branch_id === null ? {} : { parentBranchId: row.parent_branch_id }),
    ...(row.fork_entry_id === null ? {} : { forkEntryId: row.fork_entry_id }),
    name: row.name,
    status: row.status,
    ...(row.world_head_entry_id === null ? {} : { worldHeadEntryId: row.world_head_entry_id }),
    ...(row.history_head_entry_id === null ? {} : { historyHeadEntryId: row.history_head_entry_id }),
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  })
}
