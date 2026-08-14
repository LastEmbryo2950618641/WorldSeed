import type { PersistentIdPrefix, ProjectId } from "@worldseed/contracts"

export interface ProjectIdAllocatorPort {
  next(projectId: ProjectId, prefix: PersistentIdPrefix): Promise<string>
}
