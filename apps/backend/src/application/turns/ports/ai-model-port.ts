import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
} from "@worldseed/contracts"

export type PhaseModelUsage = Readonly<{
  modelCalls?: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
  provider?: string
  model?: string
}>

export type PhaseModelExecution = Readonly<{
  result: PhaseResultEnvelope
  usage: PhaseModelUsage
}>

export type AIModelInfo = Readonly<{
  provider: string
  model: string
  available: boolean
  detail?: string
}>

export interface AIModelPort {
  readonly info?: AIModelInfo
  execute(request: PhaseRequestEnvelope): Promise<PhaseModelExecution>
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
  userInput: string
  chapterSequence: number
  sourceId?: string
  sourceUnitIds: readonly string[]
  phaseRunIds: readonly string[]
  readEvidence: readonly TurnReadEvidence[]
  artifacts: Partial<Record<AIPhase, unknown>>
}>

export type TurnReadEvidence = Readonly<{
  readId: string
  visibility: "committed" | "pending"
  ownerKind: string
  ownerId: string
  exactKeys: readonly string[]
  semanticText: string
  sourceRefs: readonly unknown[]
  digest: string
}>
