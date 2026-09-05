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
  assertCurrentGeneration(scopeId: ScopeId): Promise<void>
  findTask(taskId: string): Promise<StoredTask | undefined>
  listRecoverableTasks(projectId: ProjectId): Promise<readonly StoredTask[]>
  findLatestTask(projectId: ProjectId): Promise<StoredTask | undefined>
  recoverStaleRunningTasks(input: RecoverStaleRunningTasksInput): Promise<readonly StoredTask[]>
}

export type ScopeCommitResult = Readonly<{
  projectId: ProjectId
  scopeId: ScopeId
  committedSequence: number
}>

export type ResetPendingOptions = Readonly<{
  /** Explicit sourceIds to clear when no pending document_versions exist yet (e.g. chapter_naming). */
  sourceIds?: readonly string[]
}>

export interface ScopeCommitRepository {
  resetPending(scopeId: ScopeId, options?: ResetPendingOptions): Promise<void>
  commit(scopeId: ScopeId): Promise<ScopeCommitResult>
  retire(scopeId: ScopeId, retiredAtMs: number): Promise<void>
}
