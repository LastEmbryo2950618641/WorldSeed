import type {
  AIPhase,
  ProjectId,
  ScopeId,
  TaskKind,
  TaskStatus,
  TurnId,
} from "@worldseed/contracts"

import type { ArtifactScope } from "../../../core/index.js"

export type CreateTaskScopeInput = Readonly<{
  projectId: ProjectId
  taskId: string
  turnId: TurnId
  scopeId: ScopeId
  kind: TaskKind
  status: TaskStatus
  reason: string
  configSnapshot: unknown
  promptSnapshot: unknown
  createdAtMs: number
}>

export type StoredTask = Readonly<{
  taskId: string
  projectId: ProjectId
  scopeId: ScopeId
  kind: TaskKind
  status: TaskStatus
  lastPhase?: AIPhase
  createdAtMs: number
  updatedAtMs: number
}>

export interface TaskScopeRepository {
  create(input: CreateTaskScopeInput): Promise<ArtifactScope>
  findScope(scopeId: ScopeId): Promise<ArtifactScope | undefined>
  findTask(taskId: string): Promise<StoredTask | undefined>
}

export type ScopeCommitResult = Readonly<{
  projectId: ProjectId
  scopeId: ScopeId
  committedSequence: number
}>

export interface ScopeCommitRepository {
  commit(scopeId: ScopeId): Promise<ScopeCommitResult>
  retire(scopeId: ScopeId, retiredAtMs: number): Promise<void>
}
