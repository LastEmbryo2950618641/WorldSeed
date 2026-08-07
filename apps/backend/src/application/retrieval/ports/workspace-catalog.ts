import type { ProjectId, TaskId, WorkspaceCatalogSnapshot } from "@worldseed/contracts"

export type CreateWorkspaceCatalogSnapshotInput = Readonly<{
  snapshotId: string
  projectId: ProjectId
  workspaceRootRef: string
  generatedAtMs: number
}>

export interface WorkspaceCatalogPort {
  createSnapshot(input: CreateWorkspaceCatalogSnapshotInput): Promise<WorkspaceCatalogSnapshot>
}

export interface WorkspaceCatalogSnapshotRepository {
  save(snapshot: WorkspaceCatalogSnapshot): Promise<void>
  read(snapshotId: string): Promise<WorkspaceCatalogSnapshot | undefined>
  attachToTask(taskId: TaskId, snapshotId: string): Promise<void>
  readForTask(taskId: TaskId): Promise<WorkspaceCatalogSnapshot | undefined>
}
