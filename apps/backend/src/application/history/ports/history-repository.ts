import type {
  HistoryBranchSummary,
  HistoryCheckoutResult,
  HistoryEntryKind,
  HistoryEntryState,
  HistoryEntrySummary,
  HistoryManifest,
  HistoryOverview,
  HistoryRetentionPreview,
  ModelContextMessage,
  ProjectId,
} from "@worldseed/contracts"

export type BeginHistorySaveInput = Readonly<{
  projectId: ProjectId
  operationId: string
  kind: HistoryEntryKind
  state: HistoryEntryState
  name: string
  note?: string
  taskId?: string
  checkpointId?: string
  createdAtMs: number
}>

export type HistorySaveIntent = Readonly<{
  entry: HistoryEntrySummary
  branch: HistoryBranchSummary
  parentCommitOid?: string
  alreadyReady: boolean
}>

export type HistoryCheckoutMode = "restore" | "continue_from" | "return_previous_round"

export type HistoryCheckoutIntent = Readonly<{
  operationId: string
  mode: HistoryCheckoutMode
  entry: HistoryEntrySummary
  sourceBranch: HistoryBranchSummary
  commitOid: string
  expectedGeneration: number
  alreadyCompleted: boolean
  completedResult?: HistoryCheckoutResult
}>

export type HistoryProjectionSnapshot = Readonly<{
  committedSequence: number
  activeGeneration: number
  activeScopeIds: readonly string[]
  nodeHeads: readonly {
    objectId: string
    revisionId: string
    sourceScopeId: string
    visibility: "pending" | "committed" | "retired"
    effectiveAtMs: number
    digest: string
  }[]
  linkHeads: readonly {
    objectId: string
    revisionId: string
    sourceScopeId: string
    visibility: "pending" | "committed" | "retired"
    effectiveAtMs: number
    digest: string
  }[]
  documentHeads: readonly { chapterId: string; documentVersionId: string; scopeId: string }[]
  canonicalChapters: readonly {
    messageId: string
    taskId: string
    turnId: string
    contextId: string
    sourceId: string
    chapterSequence: number
    chapterPath: string
    chapterHeading: string
    contentRef: string
    contentDigest: string
    createdAtMs: number
  }[]
  modelContext?: Readonly<{
    chainId: string
    messages: readonly ModelContextMessage[]
    hiddenMessages: readonly { messageId: string; hiddenAtMs: number }[]
  }>
  baseRulesDigest: string
}>

export type HistoryRetentionCandidate = Readonly<{
  entry: HistoryEntrySummary
  commitOid: string
}>

export type HistoryRetentionPlan = Readonly<{
  preview: HistoryRetentionPreview
  deletedEntryIds: readonly string[]
  retained: readonly HistoryRetentionCandidate[]
}>

export type HistoryRetentionRewrite = Readonly<{
  entryId: string
  commitOid: string
  manifestDigest: string
  parentEntryId?: string
}>

export interface HistoryRepository {
  beginSave(input: BeginHistorySaveInput): Promise<HistorySaveIntent>
  readProjectionSnapshot(projectId: ProjectId, checkpointId?: string): Promise<HistoryProjectionSnapshot>
  completeSave(entryId: string, commitOid: string, manifestDigest: string, completedAtMs: number): Promise<HistoryEntrySummary>
  failSave(entryId: string, error: unknown, failedAtMs: number): Promise<void>
  listEntries(projectId: ProjectId): Promise<readonly HistoryEntrySummary[]>
  listBranches(projectId: ProjectId): Promise<readonly HistoryBranchSummary[]>
  readOverview(projectId: ProjectId): Promise<HistoryOverview>
  findPreviousAutomaticEntry(projectId: ProjectId): Promise<HistoryEntrySummary>
  beginCheckout(input: Readonly<{
    projectId: ProjectId
    operationId: string
    entryId: string
    mode: HistoryCheckoutMode
    startedAtMs: number
  }>): Promise<HistoryCheckoutIntent>
  completeCheckout(
    intent: HistoryCheckoutIntent,
    manifest: HistoryManifest,
    completedAtMs: number,
  ): Promise<HistoryCheckoutResult>
  failCheckout(operationId: string, error: unknown, failedAtMs: number): Promise<void>
  ensureWritableBranch(projectId: ProjectId, createdAtMs: number): Promise<HistoryBranchSummary | undefined>
  previewRetention(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPreview>
  readRetentionPlan(projectId: ProjectId, retentionLimit: number | null): Promise<HistoryRetentionPlan>
  applyRetention(
    projectId: ProjectId,
    retentionLimit: number | null,
    deletedAtMs: number,
    rewrites?: readonly HistoryRetentionRewrite[],
  ): Promise<HistoryRetentionPreview>
}
