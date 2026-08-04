import type { ProjectId } from "@worldseed/contracts"

import {
  TurnOrchestrator,
  type AIModelPort,
  type PromptResourcePort,
} from "../application/index.js"
import type { InternalProjectStore, WorkspacePort, InternalStorePort } from "../application/workspace/index.js"
import { NodeWorkspaceAdapter } from "../infrastructure/filesystem/index.js"
import {
  SqliteDocumentRepository,
  SqliteGraphRepository,
  SqliteRetrievalRepository,
  SqliteScopeCommitRepository,
  SqliteTaskScopeRepository,
  SqliteTurnPersistence,
  openProjectDatabase,
} from "../infrastructure/sqlite/index.js"
import { NodePromptResourceAdapter } from "../infrastructure/prompts/index.js"
import type { Kysely } from "kysely"
import type { ProjectDatabase } from "../infrastructure/sqlite/database-types.js"

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
    return new ProjectRuntime(
      projectId,
      workspaceRootRef,
      internalStore,
      database,
      workspace,
      internalStorePort,
      promptPackageRoot,
    )
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
      commit: new SqliteScopeCommitRepository(this.database),
      internalStore: this.internalStorePort,
      workspace: this.workspace,
      createId,
      now,
    })
  }

  public get taskScopes(): SqliteTaskScopeRepository {
    return new SqliteTaskScopeRepository(this.database)
  }

  public async validate(): Promise<Awaited<ReturnType<WorkspacePort["validate"]>>> {
    return this.workspace.validate(this.workspaceRootRef)
  }

  public async close(): Promise<void> {
    await this.database.destroy()
  }

  private createPromptResourcePort(): PromptResourcePort {
    return new NodePromptResourceAdapter(this.promptPackageRoot)
  }
}
