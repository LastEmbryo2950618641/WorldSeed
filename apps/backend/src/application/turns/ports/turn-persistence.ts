import type {
  AIPhase,
  ProjectId,
  ScopeId,
  TaskStatus,
  TurnContext,
  TurnId,
} from "@worldseed/contracts"

export type PhaseRunStatus = "running" | "completed" | "failed"

export type CreateTurnContextRecord = Readonly<{
  context: TurnContext
  createdAtMs: number
  updatedAtMs: number
}>

export type StartPhaseRunInput = Readonly<{
  phaseRunId: string
  projectId: ProjectId
  taskId: string
  contextId: string
  phase: AIPhase
  attempt: number
  request: unknown
  startedAtMs: number
}>

export type FinishPhaseRunInput = Readonly<{
  phaseRunId: string
  status: Exclude<PhaseRunStatus, "running">
  result?: unknown
  usage: unknown
  finishedAtMs: number
}>

export type RuleSnapshotRecord = Readonly<{
  id: string
  projectId: ProjectId
  taskId: string
  baseRuleVersion: string
  sourceVersions: unknown
  selectionReasons: unknown
  digest: string
  createdAtMs: number
}>

export type DecisionRecord = Readonly<{
  id: string
  projectId: ProjectId
  taskId: string
  scopeId: ScopeId
  phaseRunId: string
  decisionKind: string
  reason: string
  evidenceIds: readonly string[]
  payload: unknown
  digest: string
  createdAtMs: number
}>

export type SettlementRecord = Readonly<{
  id: string
  projectId: ProjectId
  scopeId: ScopeId
  sourceUnitId: string
  graphRefs: unknown
  reason: string
  status: string
  digest: string
  createdAtMs: number
}>

export type FrontierRecord = Readonly<{
  id: string
  projectId: ProjectId
  scopeId: ScopeId
  anchorId: string
  lastEffectiveTime: number
  deferralCount: number
  nextAttemptAt: number
  status: string
  payload: unknown
}>

export type StoredPhaseRun = Readonly<{
  phaseRunId: string
  phase: AIPhase
  status: PhaseRunStatus
  attempt: number
  request: unknown
  result?: unknown
  usage: unknown
  startedAtMs: number
  finishedAtMs?: number
}>

export interface TurnPersistencePort {
  createContext(input: CreateTurnContextRecord): Promise<void>
  saveContext(context: TurnContext, updatedAtMs: number): Promise<void>
  startPhaseRun(input: StartPhaseRunInput): Promise<void>
  finishPhaseRun(input: FinishPhaseRunInput): Promise<void>
  stageRuleSnapshot(snapshot: RuleSnapshotRecord): Promise<void>
  stageDecisionRecords(records: readonly DecisionRecord[]): Promise<void>
  stageSettlementRecords(records: readonly SettlementRecord[]): Promise<void>
  stageFrontiers(records: readonly FrontierRecord[]): Promise<void>
  updateTask(taskId: string, status: TaskStatus, lastPhase?: AIPhase, updatedAtMs?: number): Promise<void>
  findContext(contextId: string): Promise<TurnContext | undefined>
  listPhaseRuns(taskId: string): Promise<readonly StoredPhaseRun[]>
}

export type TurnPersistenceProjectScope = Readonly<{
  projectId: ProjectId
  taskId: string
  turnId: TurnId
  scopeId: ScopeId
}>
