import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
  ProjectSettings,
  ReadRequest,
  VerificationProbeDescriptor,
  ModelContextMessageDraft,
  VisibleModelContextMessage,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import type { GraphDegreeEntry } from "./graph-repository.js"

export type PhaseModelUsage = Readonly<{
  modelCalls?: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
  provider?: string
  model?: string
  reasoningContent?: string
}>

export type PhaseModelExecution = Readonly<{
  result: PhaseResultEnvelope
  usage: PhaseModelUsage
  contextExchange?: Readonly<{
    requestMessages: readonly ModelContextMessageDraft[]
    responseMessage: ModelContextMessageDraft
  }>
}>

export type ModelExecutionOptions = Readonly<{
  signal?: AbortSignal
  contextChainId?: string
  contextMessages?: readonly VisibleModelContextMessage[]
  phasePrompt?: PromptResource
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
  loadPhase(phase: AIPhase): Promise<PromptResource>
}

export type TurnPhaseInput = Readonly<{
  workflow: "turn" | "query" | "evolution"
  userInput: string
  chapterSequence: number
  allowWorkspaceChapterReads: boolean
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
    minimumWordCount: number
    maximumWordCount: number
  }>
  sourceId?: string
  sourceUnitIds: readonly string[]
  phaseRunIds: readonly string[]
  readEvidence: readonly TurnReadEvidence[]
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
  artifacts: Partial<Record<AIPhase, unknown>>
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
