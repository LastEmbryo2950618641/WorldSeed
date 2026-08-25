import type {
  AIPhase,
  ContextSegmentRef,
  ModelContextMessage,
  ModelContextMessageDraft,
  ProjectId,
  ResettableRuntimeMetricId,
  RuntimeMetricsSnapshot,
  ScopeId,
  TaskStatus,
  TurnContext,
  TurnId,
} from "@worldseed/contracts"

import type { TurnReadEvidence, VerificationProbeExecution } from "./ai-model-port.js"

export type PhaseRunStatus = "running" | "completed" | "failed" | "cancelled" | "superseded"

export type TurnFinalizationStatus =
  | "prepared"
  | "scope_committed"
  | "chapter_published"
  | "chapter_registered"
  | "completed"

export type TurnFinalizationRecord = Readonly<{
  finalizationId: string
  projectId: ProjectId
  taskId: string
  turnId: TurnId
  scopeId: ScopeId
  contextId: string
  sourceId: string
  chapterSequence: number
  chapterPath: string
  chapterHeading: string
  contentRef: string
  contentDigest: string
  contentTokenEstimate: number
  canonicalMessageId: string
  graphAnchorIds: readonly string[]
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
  status: TurnFinalizationStatus
  committedSequence?: number
  lastError?: unknown
  createdAtMs: number
  updatedAtMs: number
}>

export type CreateTurnContextRecord = Readonly<{
  context: TurnContext
  createdAtMs: number
  updatedAtMs: number
}>

export type RuntimeBudgetUsage = Readonly<{
  modelCalls: number
  inputTokens: number
  outputTokens: number
  wallTimeMs: number
}>

export type InitializeRuntimeBudgetWindowsInput = Readonly<{
  projectId: ProjectId
  taskId: string
  limits: Readonly<Record<ResettableRuntimeMetricId, number | null>>
  createdAtMs: number
}>

export type ResetRuntimeBudgetWindowsInput = Readonly<{
  taskId: string
  metricIds: readonly ResettableRuntimeMetricId[]
  limits: Readonly<Record<ResettableRuntimeMetricId, number | null>>
  resetAtMs: number
}>

export type TaskCheckpointRecord = Readonly<{
  checkpointId: string
  projectId: ProjectId
  taskId: string
  phaseRunId: string
  contextId: string
  phase: AIPhase
  modelContextChainId: string
  modelContextSequence: number
  context: TurnContext
  createdAtMs: number
  updatedAtMs: number
}>

export type SaveTaskCheckpointInput = Readonly<{
  projectId: ProjectId
  taskId: string
  phaseRunId: string
  phase: AIPhase
  context: TurnContext
  modelContextChainId: string
  savedAtMs: number
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
  contextMessages?: readonly ModelContextMessageDraft[]
  finishedAtMs: number
}>

export type ModelContextChainRecord = Readonly<{
  chainId: string
  projectId: ProjectId
  protocolVersion: string
  systemRulesDigest: string
  messageCount: number
  tokenEstimate: number
  createdAtMs: number
  updatedAtMs: number
}>

export type EnsureModelContextChainInput = Readonly<{
  projectId: ProjectId
  protocolVersion: string
  systemRulesContent: string
  systemRulesDigest: string
  createdAtMs: number
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

export type VerificationProbeReadDelta = Readonly<{
  requestId: string
  returned: readonly Readonly<{
    readId: string
    reason: string
    segment: ContextSegmentRef
  }>[]
  rejectedReadIds: readonly string[]
}>

export type VerificationProbeCheckpoint = Readonly<{
  projectId: ProjectId
  taskId: string
  phaseRunId: string
  probeIndex: number
  planDigest: string
  execution: VerificationProbeExecution
  evidence: readonly TurnReadEvidence[]
  contextRead: VerificationProbeReadDelta
  recordDigest: string
  createdAtMs: number
}>

export interface TurnPersistencePort {
  ensureModelContextChain(input: EnsureModelContextChainInput): Promise<ModelContextChainRecord>
  appendChapterRevisionMessage(input: Readonly<{
    chainId: string
    projectId: ProjectId
    messageId: string
    taskId: string
    contentRef: string
    contentDigest: string
    tokenEstimate: number
    createdAtMs: number
  }>): Promise<void>
  listModelContextMessages(chainId: string): Promise<readonly ModelContextMessage[]>
  listVisibleModelContextEvidence(chainId: string): Promise<readonly TurnReadEvidence[]>
  hideModelContextMessages(chainId: string, messageIds: readonly string[], hiddenAtMs: number): Promise<void>
  createContext(input: CreateTurnContextRecord): Promise<void>
  initializeRuntimeBudgetWindows(input: InitializeRuntimeBudgetWindowsInput): Promise<void>
  readRuntimeBudgetUsage(taskId: string, nowMs: number): Promise<RuntimeBudgetUsage>
  listRuntimeMetrics(taskId: string, nowMs: number): Promise<RuntimeMetricsSnapshot>
  resetRuntimeBudgetWindows(input: ResetRuntimeBudgetWindowsInput): Promise<RuntimeMetricsSnapshot>
  wereRuntimeMetricsResetAfter(taskId: string, metricIds: readonly ResettableRuntimeMetricId[], afterMs: number): Promise<boolean>
  saveTaskCheckpoint(input: SaveTaskCheckpointInput): Promise<TaskCheckpointRecord>
  findTaskCheckpointByTask(taskId: string): Promise<TaskCheckpointRecord | undefined>
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
  supersedePhaseRuns(taskId: string, phaseRunIds: readonly string[], updatedAtMs: number): Promise<void>
  saveVerificationProbeCheckpoint(checkpoint: VerificationProbeCheckpoint): Promise<VerificationProbeCheckpoint>
  listVerificationProbeCheckpoints(taskId: string): Promise<readonly VerificationProbeCheckpoint[]>
  createFinalization(input: TurnFinalizationRecord): Promise<void>
  findFinalizationByTask(taskId: string): Promise<TurnFinalizationRecord | undefined>
  markFinalizationScopeCommitted(finalizationId: string, committedSequence: number, updatedAtMs: number): Promise<void>
  markFinalizationChapterPublished(finalizationId: string, updatedAtMs: number): Promise<void>
  registerCanonicalChapter(finalizationId: string, updatedAtMs: number): Promise<void>
  completeFinalization(finalizationId: string, taskId: string, lastPhase: AIPhase, updatedAtMs: number): Promise<void>
  recordFinalizationError(
    finalizationId: string,
    error: Readonly<Record<string, unknown>>,
    updatedAtMs: number,
  ): Promise<void>
}

export type TurnPersistenceProjectScope = Readonly<{
  projectId: ProjectId
  taskId: string
  turnId: TurnId
  scopeId: ScopeId
}>
