import type {
  AIPhase,
  ProjectId,
  ScopeId,
  TaskStatus,
  TurnContext,
  TurnId,
} from "@worldseed/contracts"

export type PhaseRunStatus = "running" | "completed" | "failed" | "cancelled"

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

export type SceneSpacetimeBindingRecord = Readonly<{
  id: string
  projectId: string
  scopeId: ScopeId
  sourceId?: string
  sceneIndex: number
  sceneAnchorId: string
  sourceUnitIndexes: readonly number[]
  temporalReferenceRefs: readonly string[]
  timeAnchorRefs: readonly string[]
  spatialReferenceRefs: readonly string[]
  locationAnchorRefs: readonly string[]
  predecessorSceneIndexes: readonly number[]
  predecessorSceneRefs: readonly string[]
  transitionPathRefs: readonly string[]
  correspondenceRefs: readonly string[]
  reason: string
  selfReview: string
  visibility: "pending" | "committed" | "retired"
  digest: string
  createdAtMs: number
}>

export type GraphRevisionSpacetimeRecord = Readonly<{
  id: string
  projectId: string
  scopeId: ScopeId
  graphRevisionId: string
  effectDisposition: "world_effect" | "representation_only"
  effectiveSceneBindingIds: readonly string[]
  effectiveExistingSceneRefs: readonly string[]
  currentEntryRefs: readonly string[]
  predecessorRevisionRequired: boolean
  predecessorRevisionIds: readonly string[]
  historicalReturnRefs: readonly string[]
  reason: string
  selfReview: string
  visibility: "pending" | "committed" | "retired"
  digest: string
  createdAtMs: number
}>

export type FrontierRecord = Readonly<{
  id: string
  projectId: ProjectId
  scopeId: ScopeId
  frontierAnchorRef: string
  disposition: "active" | "deferred" | "archived"
  lastSceneAnchorRefs: readonly string[]
  lastTimeAnchorRefs: readonly string[]
  lastLocationAnchorRefs: readonly string[]
  correspondenceRefs: readonly string[]
  lastProcessedAt: number
  reason: string
  revisitCondition?: string
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
  listSettlementsForSourceUnits(projectId: ProjectId, sourceUnitIds: readonly string[]): Promise<readonly SettlementRecord[]>
  stageSceneSpacetimeBindings(records: readonly SceneSpacetimeBindingRecord[]): Promise<void>
  stageGraphRevisionSpacetime(records: readonly GraphRevisionSpacetimeRecord[]): Promise<void>
  stageFrontiers(records: readonly FrontierRecord[]): Promise<void>
  listSchedulableFrontiers(projectId: ProjectId, limit: number): Promise<readonly FrontierRecord[]>
  updateTask(taskId: string, status: TaskStatus, lastPhase?: AIPhase, updatedAtMs?: number, error?: unknown): Promise<void>
  findContext(contextId: string): Promise<TurnContext | undefined>
  findContextByTask(taskId: string): Promise<TurnContext | undefined>
  listPhaseRuns(taskId: string): Promise<readonly StoredPhaseRun[]>
}

export type TurnPersistenceProjectScope = Readonly<{
  projectId: ProjectId
  taskId: string
  turnId: TurnId
  scopeId: ScopeId
}>
