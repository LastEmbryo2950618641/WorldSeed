import type { ProjectId } from "@worldseed/contracts"

import type { ProjectManifest } from "../../../core/index.js"

export type RegisteredProject = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  internalStoreRef: string
  lastOpenedAtMs: number
  createdAtMs: number
}>

export interface ProjectRegistryRepository {
  register(project: RegisteredProject): Promise<void>
  findById(projectId: ProjectId): Promise<RegisteredProject | undefined>
  findByWorkspaceRoot(workspaceRootRef: string): Promise<RegisteredProject | undefined>
  touch(projectId: ProjectId, lastOpenedAtMs: number): Promise<void>
  listOrderedByLastOpened(limit?: number): Promise<readonly RegisteredProject[]>
}

export type StoredProject = Readonly<{
  projectId: ProjectId
  name: string
  manifestVersion: number
  committedSequence: number
  createdAtMs: number
  updatedAtMs: number
}>

export interface ProjectRepository {
  create(project: StoredProject, manifest: ProjectManifest): Promise<void>
  find(projectId: ProjectId): Promise<StoredProject | undefined>
  readManifest(projectId: ProjectId): Promise<ProjectManifest | undefined>
  updateName(projectId: ProjectId, name: string, updatedAtMs: number): Promise<void>
  reconcileManifest(manifest: ProjectManifest, updatedAtMs: number): Promise<void>
}
