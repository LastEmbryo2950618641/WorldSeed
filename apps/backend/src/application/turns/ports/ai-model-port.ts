import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
} from "@worldseed/contracts"

export type PhaseModelUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  latencyMs: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
}>

export type PhaseModelExecution = Readonly<{
  result: PhaseResultEnvelope
  usage: PhaseModelUsage
}>

export interface AIModelPort {
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
  artifacts: Partial<Record<AIPhase, unknown>>
}>
