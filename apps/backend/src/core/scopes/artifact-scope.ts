import type {
  ProjectId,
  ScopeId,
  TaskId,
  TurnId,
  Visibility,
} from "@worldseed/contracts"

export type ArtifactScope = Readonly<{
  scopeId: ScopeId
  projectId: ProjectId
  taskId: TaskId
  turnId: TurnId
  visibility: Visibility
  baseCommittedSequence: number
  reason: string
  createdAtMs: number
  retiredAtMs?: number
}>
