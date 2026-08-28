import { randomUUID } from "node:crypto"

import type {
  AIPhase,
  ProjectId,
  ProjectSettings,
  ResettableRuntimeMetricId,
  RuntimeMetricsSnapshot,
  TaskStatus,
} from "@worldseed/contracts"

import {
  TurnOrchestrator,
  ChapterRevisionService,
  ChapterRevisionConversationService,
  ChapterResolveService,
  ChapterSynopsisService,
  DeductionGoalsService,
  SettingsExtractionService,
  SynopsisConversationService,
  buildSourceUnitExactKeys,
  HistoryManifestBuilder,
  HistoryCheckoutService,
  HistoryRetentionService,
  HistoryService,
  type AIModelPort,
  type PromptResourcePort,
} from "../application/index.js"
import type { InternalProjectStore, WorkspacePort, InternalStorePort } from "../application/workspace/index.js"
import { NodeWorkspaceAdapter, NodeWorkspaceCatalogAdapter, NodeWorkspaceSnapshotAdapter } from "../infrastructure/filesystem/index.js"
import { IsomorphicGitHistoryAdapter } from "../infrastructure/history-git/index.js"
import {
  SqliteDocumentRepository,
  SqliteChapterRevisionRepository,
  SqliteRevisionConversationRepository,
  SqliteSynopsisConversationRepository,
  SqliteChapterSynopsisRepository,
  SqliteDeductionGoalsRepository,
  SqliteSettingsExtractionRepository,
  SqliteChapterIndexRepository,
  SqliteEvidenceStore,
  SqliteGraphRepository,
  SqliteHistoryRepository,
  SqliteProjectIdAllocator,
  SqliteProjectSettingsStore,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  SqliteWorkspaceCatalogSnapshotRepository,
  openProjectDatabase,
} from "../infrastructure/sqlite/index.js"
import type { StoredPhaseRun, StoredTask, TaskCheckpointRecord, TurnFinalizationRecord } from "../application/turns/ports/index.js"
import { NodePromptResourceAdapter } from "../infrastructure/prompts/index.js"
import type { Kysely } from "kysely"
import type { ProjectDatabase } from "../infrastructure/sqlite/database-types.js"
import { runtimeLog } from "../infrastructure/diagnostics/index.js"
import type { HistoryBranchSummary, HistoryCheckoutResult, HistoryEntrySummary, HistoryOverview, HistoryRetentionPreview } from "@worldseed/contracts"

export class ProjectRuntime {
  private constructor(
    public readonly projectId: ProjectId,
    public readonly workspaceRootRef: string,
    public readonly internalStore: InternalProjectStore,
    private readonly database: Kysely<ProjectDatabase>,
    private readonly workspace: WorkspacePort,
    private readonly internalStorePort: InternalStorePort,
    private readonly promptPackageRoot: string,
  ) {}

  public static async open(
    projectId: ProjectId,
    workspaceRootRef: string,
    internalStore: InternalProjectStore,
    internalStorePort: InternalStorePort,
    promptPackageRoot: string,
    workspace: WorkspacePort = new NodeWorkspaceAdapter(),
  ): Promise<ProjectRuntime> {
    const database = await openProjectDatabase(internalStore.projectDatabaseRef)
    const runtime = new ProjectRuntime(
      projectId,
      workspaceRootRef,
      internalStore,
      database,
      workspace,
      internalStorePort,
      promptPackageRoot,
    )
    await runtime.ensureCommittedSourceUnitIndexes()
    return runtime
  }

  public createTurnOrchestrator(model: AIModelPort, createId: () => string, now: () => number): TurnOrchestrator {
    return new TurnOrchestrator({
      taskScopes: new SqliteTaskScopeRepository(this.database),
      persistence: new SqliteTurnPersistence(this.database, createId),
      model,
      prompts: this.createPromptResourcePort(),
      documents: new SqliteDocumentRepository(this.database),
      graph: new SqliteGraphRepository(this.database),
      retrieval: new SqliteRetrievalRepository(this.database),
      catalog: new NodeWorkspaceCatalogAdapter(this.workspace),
      catalogSnapshots: new SqliteWorkspaceCatalogSnapshotRepository(this.database),
      evidence: new SqliteEvidenceStore(this.database, this.internalStorePort, this.internalStore),
      commit: new SqliteScopeCommitRepository(this.database),
      internalStore: this.internalStorePort,
      workspace: this.workspace,
      chapterSynopsis: this.createChapterSynopsisService(),
      settingsExtraction: this.createSettingsExtractionService(),
      createId,
      idAllocator: new SqliteProjectIdAllocator(this.database, now),
      now,
      diagnostics: {
        log: (level, event, fields) => { runtimeLog(level, "turn-orchestrator", event, fields) },
      },
    })
  }

  public get taskScopes(): SqliteTaskScopeRepository {
    return new SqliteTaskScopeRepository(this.database)
  }

  public listRecoverableTasks(): Promise<readonly StoredTask[]> {
    return this.taskScopes.listRecoverableTasks(this.projectId)
  }

  public recoverStaleRunningTasks(
    activeTaskIds: readonly string[],
    updatedAtMs: number,
    interruption: unknown,
  ): Promise<readonly StoredTask[]> {
    return this.taskScopes.recoverStaleRunningTasks({
      projectId: this.projectId,
      activeTaskIds,
      updatedAtMs,
      interruption,
    })
  }

  public readSettings(): Promise<ProjectSettings> {
    return new SqliteProjectSettingsStore(this.database, Date.now).read(this.projectId)
  }

  public async saveSettings(settings: ProjectSettings): Promise<ProjectSettings> {
    const saved = await new SqliteProjectSettingsStore(this.database, Date.now).save(this.projectId, settings)
    await this.createHistoryRetentionService().apply(this.projectId, saved.history.retentionLimit)
    return saved
  }

  public listHistoryEntries(): Promise<HistoryOverview> {
    return this.createHistoryRepository().readOverview(this.projectId)
  }

  public listHistoryBranches(): Promise<readonly HistoryBranchSummary[]> {
    return this.createHistoryRepository().listBranches(this.projectId)
  }

  public async saveAutomaticHistory(input: {
    operationId: string
    name: string
    taskId: string
    createdAtMs: number
  }): Promise<HistoryEntrySummary> {
    const entry = await this.createHistoryService().saveAutomatic({
      projectId: this.projectId,
      workspaceRootRef: this.workspaceRootRef,
      ...input,
    })
    await this.applyHistoryRetention()
    return entry
  }

  public async saveManualHistory(input: {
    operationId: string
    name: string
    note?: string
    taskId?: string
    checkpointId?: string
    createdAtMs: number
  }): Promise<HistoryEntrySummary> {
    const entry = await this.createHistoryService().saveManual({
      projectId: this.projectId,
      workspaceRootRef: this.workspaceRootRef,
      ...input,
    }, input.checkpointId !== undefined)
    await this.applyHistoryRetention()
    return entry
  }

  public async checkoutHistory(input: {
    operationId: string
    entryId: string
    mode: "restore" | "continue_from" | "return_previous_round"
    startedAtMs: number
  }): Promise<HistoryCheckoutResult> {
    return this.createHistoryCheckoutService().checkout({
      projectId: this.projectId,
      workspaceRootRef: this.workspaceRootRef,
      ...input,
    })
  }

  public async returnPreviousRound(input: {
    operationId: string
    startedAtMs: number
  }): Promise<HistoryCheckoutResult> {
    const service = this.createHistoryCheckoutService()
    const entry = await service.findPreviousAutomaticEntry(this.projectId)
    return service.checkout({
      projectId: this.projectId,
      workspaceRootRef: this.workspaceRootRef,
      operationId: input.operationId,
      entryId: entry.entryId,
      mode: "return_previous_round",
      startedAtMs: input.startedAtMs,
    })
  }

  public ensureWritableHistoryBranch(createdAtMs: number): Promise<HistoryBranchSummary | undefined> {
    return this.createHistoryRepository().ensureWritableBranch(this.projectId, createdAtMs)
  }

  public previewHistoryRetention(retentionLimit: number | null): Promise<HistoryRetentionPreview> {
    return this.createHistoryRetentionService().preview(this.projectId, retentionLimit)
  }

  public async listPhaseRuns(taskId: string): Promise<readonly StoredPhaseRun[]> {
    return new SqliteTurnPersistence(this.database, () => "phase-read")
      .listPhaseRuns(taskId)
  }

  public async findFinalizationByTask(taskId: string): Promise<TurnFinalizationRecord | undefined> {
    return new SqliteTurnPersistence(this.database, () => "finalization-read")
      .findFinalizationByTask(taskId)
  }

  public findTaskCheckpoint(taskId: string): Promise<TaskCheckpointRecord | undefined> {
    return new SqliteTurnPersistence(this.database).findTaskCheckpointByTask(taskId)
  }

  public readRuntimeMetrics(taskId: string, nowMs: number): Promise<RuntimeMetricsSnapshot> {
    return new SqliteTurnPersistence(this.database).listRuntimeMetrics(taskId, nowMs)
  }

  public async resetRuntimeMetrics(
    taskId: string,
    metricIds: readonly ResettableRuntimeMetricId[],
    resetAtMs: number,
  ): Promise<RuntimeMetricsSnapshot> {
    const settings = await this.readSettings()
    return new SqliteTurnPersistence(this.database).resetRuntimeBudgetWindows({
      taskId,
      metricIds,
      limits: {
        model_calls: settings.execution.maxModelCalls,
        input_tokens: null,
        output_tokens: null,
        wall_time: settings.execution.maxWallTimeMs,
      },
      resetAtMs,
    })
  }

  public wereRuntimeMetricsResetAfter(
    taskId: string,
    metricIds: readonly ResettableRuntimeMetricId[],
    afterMs: number,
  ): Promise<boolean> {
    return new SqliteTurnPersistence(this.database).wereRuntimeMetricsResetAfter(taskId, metricIds, afterMs)
  }

  public async persistenceUpdateTask(taskId: string, status: TaskStatus, lastPhase?: AIPhase, error?: unknown): Promise<void> {
    await new SqliteTurnPersistence(this.database, () => "task-update").updateTask(taskId, status, lastPhase, Date.now(), error)
  }

  public async validate(): Promise<Awaited<ReturnType<WorkspacePort["validate"]>>> {
    return this.workspace.validate(this.workspaceRootRef)
  }

  public async readMarkdown(relativePath: string): Promise<string> {
    return this.workspace.readMarkdown(this.workspaceRootRef, relativePath)
  }

  public async saveMarkdown(relativePath: string, content: string): Promise<void> {
    await this.workspace.saveUserMarkdown(this.workspaceRootRef, relativePath, content)
  }

  public createChapterResolveService(): ChapterResolveService {
    const chapterIndex = new SqliteChapterIndexRepository(this.database)
    return new ChapterResolveService({
      chapters: this.createChapterRevisionService(),
      revisions: new SqliteChapterRevisionRepository(this.database),
      chapterIndex,
      database: this.database,
      createId: randomUUID,
      now: Date.now,
    })
  }

  public createChapterRevisionService(): ChapterRevisionService {
    const persistence = new SqliteTurnPersistence(this.database, randomUUID)
    const documents = new SqliteDocumentRepository(this.database)
    const chapterIndex = new SqliteChapterIndexRepository(this.database)
    return new ChapterRevisionService({
      taskScopes: new SqliteTaskScopeRepository(this.database),
      documents,
      retrieval: new SqliteRetrievalRepository(this.database),
      commit: new SqliteScopeCommitRepository(this.database),
      revisions: new SqliteChapterRevisionRepository(this.database),
      chapterIndex,
      recordLineageSnapshot: async (input) => {
        await this.database.insertInto("chapter_lineage_snapshots").values({
          id: randomUUID(),
          project_id: input.projectId,
          chapter_id: input.chapterId,
          source_id: input.sourceId,
          prior_chapter_source_ids_json: JSON.stringify(input.priorChapterSourceIds),
          created_at_ms: Date.now(),
        }).execute()
      },
      workspace: this.workspace,
      internalStore: this.internalStorePort,
      internalProjectStore: this.internalStore,
      idAllocator: new SqliteProjectIdAllocator(this.database, Date.now),
      createId: randomUUID,
      now: Date.now,
      prompts: this.createPromptResourcePort(),
      appendChapterRevisionContext: async (input) => {
        const baseRules = await this.createPromptResourcePort().loadTurnSystemRules()
        const chain = await persistence.ensureModelContextChain({
          projectId: input.revision.projectId,
          protocolVersion: "1.0",
          systemRulesContent: baseRules.text,
          systemRulesDigest: baseRules.digest,
          createdAtMs: Date.now(),
        })
        await persistence.appendChapterRevisionMessage({
          chainId: chain.chainId,
          projectId: input.revision.projectId,
          messageId: input.revision.revisionTaskId,
          taskId: input.revision.revisionTaskId,
          contentRef: input.contentRef,
          contentDigest: input.contentDigest,
          tokenEstimate: input.contentTokenEstimate,
          metadata: {
            chapterId: input.revision.chapterId,
            replacedSourceId: input.revision.baseSourceId,
            sourceId: input.revision.proposedSourceId,
            ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
          },
          createdAtMs: Date.now(),
        })
      },
      runGraphSync: async (input) => {
        const settings = await this.readSettings()
        const chapterIndex = new SqliteChapterIndexRepository(this.database)
        const index = await chapterIndex.find(input.revision.projectId, input.revision.chapterId)
        const chapterSequence = index?.sequence ?? Math.max(1, (await documents.listCommittedChapters(input.revision.projectId))
          .findIndex((chapter) => chapter.chapterId === input.revision.chapterId) + 1)
        const content = await this.internalStorePort.readDocument(input.revision.contentRef)
        const orchestrator = this.createTurnOrchestrator(input.model, randomUUID, Date.now)
        const orchestratorInput = {
          workflow: "revision",
          adaptiveGraphGovernance: true,
          projectId: input.revision.projectId,
          workspaceRootRef: input.workspaceRootRef,
          internalStore: this.internalStore,
          userInput: content,
          chapterSequence,
          sourceId: input.revision.proposedSourceId,
          existingSourceUnitIds: input.sourceUnitIds,
          taskId: input.graphSyncTaskId,
          allowWorkspaceChapterReads: true,
          maxModelCalls: settings.execution.maxModelCalls,
          deadlineMs: settings.execution.maxWallTimeMs,
          maxRetrievalRounds: settings.execution.maxRetrievalRounds,
          projectSettings: settings,
          executionOrigin: { kind: "user" },
        } as const
        const existingTask = await this.taskScopes.findTask(input.graphSyncTaskId)
        if (existingTask === undefined) {
          await orchestrator.execute(orchestratorInput)
        } else {
          await orchestrator.resume(orchestratorInput)
        }
      },
    })
  }

  public createChapterRevisionConversationService(): ChapterRevisionConversationService {
    return new ChapterRevisionConversationService({
      chapters: this.createChapterRevisionService(),
      revisions: new SqliteChapterRevisionRepository(this.database),
      conversation: new SqliteRevisionConversationRepository(this.database),
      prompts: this.createPromptResourcePort(),
      createId: randomUUID,
      now: Date.now,
    })
  }

  public createSynopsisConversationService(): SynopsisConversationService {
    return new SynopsisConversationService({
      chapters: this.createChapterResolveService(),
      conversation: new SqliteSynopsisConversationRepository(this.database),
      goals: this.createDeductionGoalsService(),
      workspace: this.workspace,
      prompts: this.createPromptResourcePort(),
      createId: randomUUID,
      now: Date.now,
    })
  }

  public createChapterSynopsisService(): ChapterSynopsisService {
    return new ChapterSynopsisService({
      synopsis: new SqliteChapterSynopsisRepository(this.database),
      conversation: new SqliteSynopsisConversationRepository(this.database),
      workspace: this.workspace,
      now: Date.now,
    })
  }

  public createDeductionGoalsService(): DeductionGoalsService {
    return new DeductionGoalsService({
      goals: new SqliteDeductionGoalsRepository(this.database),
      createId: randomUUID,
      now: Date.now,
    })
  }

  public createSettingsExtractionService(): SettingsExtractionService {
    return new SettingsExtractionService({
      proposals: new SqliteSettingsExtractionRepository(this.database),
      workspace: this.workspace,
      createId: randomUUID,
      now: Date.now,
    })
  }

  public async readGraphNeighborhood(input: {
    anchorIds: readonly string[]
    direction: "out" | "in" | "both"
    maxDepth: number
    maxNodes: number
    maxLinks: number
  }): Promise<Awaited<ReturnType<SqliteGraphRepository["getNeighborhood"]>>> {
    return new SqliteGraphRepository(this.database).getNeighborhood({
      scope: { projectId: this.projectId },
      ...input,
    })
  }

  public async close(): Promise<void> {
    await this.database.destroy()
  }

  private createPromptResourcePort(): PromptResourcePort {
    return new NodePromptResourceAdapter(this.promptPackageRoot)
  }

  private createHistoryRepository(): SqliteHistoryRepository {
    return new SqliteHistoryRepository(this.database, randomUUID)
  }

  private createHistoryService(): HistoryService {
    const repository = this.createHistoryRepository()
    return new HistoryService(
      repository,
      new HistoryManifestBuilder(repository, new NodeWorkspaceSnapshotAdapter(this.workspace)),
      new IsomorphicGitHistoryAdapter(this.internalStore.historyGitRef),
      Date.now,
    )
  }

  private createHistoryCheckoutService(): HistoryCheckoutService {
    return new HistoryCheckoutService(
      this.createHistoryRepository(),
      new IsomorphicGitHistoryAdapter(this.internalStore.historyGitRef),
      new NodeWorkspaceSnapshotAdapter(this.workspace),
      Date.now,
    )
  }

  private async applyHistoryRetention(): Promise<void> {
    const settings = await this.readSettings()
    await this.createHistoryRetentionService().apply(this.projectId, settings.history.retentionLimit)
  }

  private createHistoryRetentionService(): HistoryRetentionService {
    return new HistoryRetentionService(
      this.createHistoryRepository(),
      new IsomorphicGitHistoryAdapter(this.internalStore.historyGitRef),
      Date.now,
    )
  }

  private async ensureCommittedSourceUnitIndexes(): Promise<void> {
    const retrieval = new SqliteRetrievalRepository(this.database)
    const sourceUnits = await retrieval.listUnindexedCommittedSourceUnits(this.projectId)
    for (const sourceUnit of sourceUnits) {
      const content = await this.internalStorePort.readDocument(sourceUnit.contentRef)
      await retrieval.indexCommittedSourceProjection({
        projectionId: randomUUID(),
        projectId: this.projectId,
        scopeId: sourceUnit.scopeId,
        ownerKind: "source",
        ownerId: sourceUnit.sourceUnitId,
        ownerRevisionId: sourceUnit.sourceUnitId,
        exactKeys: buildSourceUnitExactKeys(content),
        semanticText: content,
        sourceRefs: [{
          sourceId: sourceUnit.sourceId,
          sourceUnitId: sourceUnit.sourceUnitId,
          sequence: sourceUnit.sequence,
        }],
        digest: sourceUnit.digest,
      })
    }
    if (sourceUnits.length > 0) {
      runtimeLog("info", "project-runtime", "source_unit_indexes.backfilled", {
        projectId: this.projectId,
        indexedCount: sourceUnits.length,
      })
    }
  }
}
