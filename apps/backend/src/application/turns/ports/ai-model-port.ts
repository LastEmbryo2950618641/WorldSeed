import type {
  AIPhase,
  ChapterNarrativeIntent,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
  ProjectSettings,
  ReadRequest,
  TurnDeductionGoalBundle,
  VerificationProbeDescriptor,
  ModelContextMessageDraft,
  ModelReasoningKind,
  VisibleModelContextMessage,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import type { GraphDegreeEntry } from "./graph-repository.js"
import type { StageProjection } from "@worldseed/prompt-contracts"

export type PhaseModelUsage = Readonly<{
  modelCalls?: number
  inputTokens: number
  lastRequestInputTokens?: number
  outputTokens: number
  latencyMs: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
  provider?: string
  model?: string
  reasoningContent?: string
  reasoningKind?: ModelReasoningKind
}>

export type PhaseModelExecution = Readonly<{
  result: PhaseResultEnvelope
  usage: PhaseModelUsage
  contextExchange?: Readonly<{
    requestMessages: readonly ModelContextMessageDraft[]
    responseMessage: ModelContextMessageDraft
  }>
}>

export type ModelStreamPartial = Readonly<{
  reasoningDelta?: string
  contentDelta?: string
}>

export type ModelExecutionOptions = Readonly<{
  signal?: AbortSignal
  contextChainId?: string
  contextMessages?: readonly VisibleModelContextMessage[]
  phasePrompt?: PromptResource
  /** When set, adapters should stream provider deltas when the protocol supports it. */
  onPartial?: (partial: ModelStreamPartial) => void
  /** Force DeepSeek thinking on for this call regardless of profile default. */
  forceThinking?: boolean
}>

export type AIModelInfo = Readonly<{
  provider: string
  model: string
  available: boolean
  contextWindowTokens: number
  detail?: string
}>

export interface AIModelPort {
  readonly info?: AIModelInfo
  execute(request: PhaseRequestEnvelope, options?: ModelExecutionOptions): Promise<PhaseModelExecution>
}

export type PromptResource = Readonly<{
  ref: string
  version: string
  digest: string
  text: string
}>

export interface PromptResourcePort {
  loadBaseRules(): Promise<PromptResource>
  loadPlotSynopsisGuide(): Promise<PromptResource>
  loadSettingsQueryGuide(): Promise<PromptResource>
  loadSettingsRevisionGuide(): Promise<PromptResource>
  loadTurnSystemRules(): Promise<PromptResource>
  loadSynopsisDiscussSystemRules(): Promise<PromptResource>
  loadPhase(phase: AIPhase): Promise<PromptResource>
}

export type TurnPhaseInput = Readonly<{
  workflow: "turn" | "query" | "evolution" | "revision" | "synopsis"
  userInput: string
  chapterSequence: number
  allowWorkspaceChapterReads: boolean
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
    minimumWordCount: number
    maximumWordCount: number
  }>
  chapterIntent?: ChapterNarrativeIntent
  deductionGoalBundle?: TurnDeductionGoalBundle
  deductionGoalConstraintMarkdown?: string
  sourceId?: string
  sourceUnitIds: readonly string[]
  phaseRunIds: readonly string[]
  readEvidence: readonly TurnReadEvidence[]
  resurfacedReadIds?: readonly string[]
  retrievalGaps: readonly TurnRetrievalGap[]
  verificationProbeExecutions?: readonly VerificationProbeExecution[]
  workspaceCatalog?: WorkspaceCatalogSnapshot
  projectSettings?: ProjectSettings
  graphCapacity?: Readonly<{
    nodeCount: number
    linkCount: number
    maxDirectInDegree: number
    maxDirectOutDegree: number
    mergeWarningThreshold: number
    hotspots: readonly GraphDegreeEntry[]
    candidateAssessment?: Readonly<{
      round: number
      nodeCount: number
      linkCount: number
      violations: readonly Readonly<{
        nodeId: string
        inDegree: number
        outDegree: number
        exceeded: readonly ("in" | "out")[]
      }>[]
    }>
  }>
  revisionFeedback?: Readonly<{
    phase: AIPhase
    outcome: "continue" | "request_read" | "blocked" | "approve" | "revise" | "reject" | "retire"
    artifact: unknown
    reason: string
    selfReview: string
  }>
  stageProjection?: StageProjection
  validationArtifacts?: Partial<Record<AIPhase, unknown>>
  artifacts: Partial<Record<AIPhase, unknown>>
  revision?: Readonly<{
    chapterId: string
    baseSourceId: string
    proposedSourceId: string
    baseContent: string
    proposedContent: string
  }>
  revisionAssist?: Readonly<{
    chapterId: string
    heading: string
    committedBody: string
    workingBody: string
    conversationHistory: readonly Readonly<{ role: "user" | "assistant"; content: string }>[]
  }>
  synopsisDiscuss?: Readonly<{
    heading: string
    chapterSequence: number
    synopsisMarkdown: string
    userEditedSinceAgent: boolean
    conversationHistory: readonly Readonly<{ role: "user" | "assistant"; content: string }>[]
    activeGoals?: readonly Readonly<{
      goalId: string
      content: string
      lifecycle: "active" | "completed" | "removed"
      narrativeKind?: "general" | "foreshadow" | "climax"
      scale?: "short" | "medium" | "long"
      plantChapterSequence?: number
      payoffChapterSequence?: number
    }>[]
    chapterProgress?: readonly Readonly<{
      goalId: string
      chapterSequence: number
      summary: string
      status: "planned" | "achieved" | "partial" | "missed" | "superseded"
    }>[]
    turnMonitor?: Readonly<{
      taskId: string
      status: string
      phases: readonly Readonly<{
        phase: string
        status: string
        summary: string
        finishedAtMs?: number
      }>[]
    }>
    discussTrigger?: "user" | "turn_handoff"
  }>
}>

export type VerificationProbeExecution = Readonly<{
  probeIndex: number
  requestId: string
  operationId: string
  descriptor: VerificationProbeDescriptor
  status: "completed"
  returnedReadRefs: readonly string[]
  returnedGraphRefs: readonly string[]
  returnedProposalRefs: readonly string[]
  resultDigest: string
}>

export type TurnReadEvidence = Readonly<{
  readId: string
  visibility: "committed" | "pending"
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys: readonly string[]
  semanticText: string
  sourceRefs: readonly unknown[]
  relatedOwnerRefs?: readonly RelatedOwnerRef[]
  digest: string
  stateRole?: "current" | "historical"
  temporalRole?: "as_of" | "current"
  asOfChapterSequence?: number
  committedSequence?: number
  sourcePosition?: Readonly<{
    sourceRef: string
    sequence: number
    firstSequence: number
    lastSequence: number
    unitCount: number
    isStart: boolean
    isEnd: boolean
  }>
}>

export type RelatedOwnerRef = Readonly<{
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}>

export type TurnRetrievalGap = Readonly<{
  typeId: "system:retrieval-gap"
  requestId: string
  expectedEvidence: string
  reason: string
  query: ReadRequest["query"]
}>
