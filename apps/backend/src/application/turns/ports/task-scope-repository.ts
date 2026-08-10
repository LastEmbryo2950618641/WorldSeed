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
  configSnapshot: unknown
  promptSnapshot: unknown
  lastPhase?: AIPhase
  createdAtMs: number
  updatedAtMs: number
  error?: unknown
}>

export type RecoverStaleRunningTasksInput = Readonly<{
  projectId: ProjectId
  activeTaskIds: readonly string[]
  updatedAtMs: number
  interruption: unknown
}>

export interface TaskScopeRepository {
  create(input: CreateTaskScopeInput): Promise<ArtifactScope>
  findScope(scopeId: ScopeId): Promise<ArtifactScope | undefined>
  findTask(taskId: string): Promise<StoredTask | undefined>
  listRecoverableTasks(projectId: ProjectId): Promise<readonly StoredTask[]>
  recoverStaleRunningTasks(input: RecoverStaleRunningTasksInput): Promise<readonly StoredTask[]>
}

export type ScopeCommitResult = Readonly<{
  projectId: ProjectId
  scopeId: ScopeId
  committedSequence: number
}>

export interface ScopeCommitRepository {
  resetPending(scopeId: ScopeId): Promise<void>
  commit(scopeId: ScopeId): Promise<ScopeCommitResult>
  retire(scopeId: ScopeId, retiredAtMs: number): Promise<void>
}
