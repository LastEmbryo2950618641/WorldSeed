import { randomUUID } from "node:crypto"

import type { ProjectId, ProjectSettings, TaskStatus, AIPhase } from "@worldseed/contracts"

import {
  TurnOrchestrator,
  buildSourceUnitExactKeys,
  type AIModelPort,
  type PromptResourcePort,
} from "../application/index.js"
import type { InternalProjectStore, WorkspacePort, InternalStorePort } from "../application/workspace/index.js"
import { NodeWorkspaceAdapter, NodeWorkspaceCatalogAdapter } from "../infrastructure/filesystem/index.js"
import {
  SqliteDocumentRepository,
  SqliteEvidenceStore,
  SqliteGraphRepository,
  SqliteProjectSettingsStore,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  SqliteWorkspaceCatalogSnapshotRepository,
  openProjectDatabase,
} from "../infrastructure/sqlite/index.js"
import type { StoredPhaseRun, StoredTask } from "../application/turns/ports/index.js"
import { NodePromptResourceAdapter } from "../infrastructure/prompts/index.js"
import type { Kysely } from "kysely"
import type { ProjectDatabase } from "../infrastructure/sqlite/database-types.js"
import { runtimeLog } from "../infrastructure/diagnostics/index.js"

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
      createId,
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

  public saveSettings(settings: ProjectSettings): Promise<ProjectSettings> {
    return new SqliteProjectSettingsStore(this.database, Date.now).save(this.projectId, settings)
  }

  public async listPhaseRuns(taskId: string): Promise<readonly StoredPhaseRun[]> {
    return new SqliteTurnPersistence(this.database, () => "phase-read")
      .listPhaseRuns(taskId)
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
