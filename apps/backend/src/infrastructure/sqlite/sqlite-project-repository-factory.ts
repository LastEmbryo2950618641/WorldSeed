import type {
  InternalProjectStore,
  ProjectRepositoryFactory,
  ProjectRepositorySession,
} from "../../application/index.js"
import { SqliteProjectRepository } from "./repositories/index.js"
import { openProjectDatabase } from "./sqlite-database.js"

export class SqliteProjectRepositoryFactory implements ProjectRepositoryFactory {
  public async open(
    store: InternalProjectStore,
    workspaceRootRef: string,
  ): Promise<ProjectRepositorySession> {
    const database = await openProjectDatabase(store.projectDatabaseRef)
    return {
      repository: new SqliteProjectRepository(database, workspaceRootRef, store.internalStoreRef),
      close: async () => database.destroy(),
    }
  }
}
