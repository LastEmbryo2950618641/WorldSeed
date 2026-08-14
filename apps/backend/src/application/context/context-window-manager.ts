import type { ModelContextMessage } from "@worldseed/contracts"

const MODEL_MESSAGE_OVERHEAD_TOKENS = 8

export type ContextCompactionPlan = Readonly<{
  phase: "none" | "non_narrative" | "chapter"
  hiddenMessageIds: readonly string[]
  visibleMessages: readonly ModelContextMessage[]
  estimatedTokens: number
  thresholdTokens: number
  targetTokens: number
  protectedTokens: number
  blocked: boolean
  reason?: string
}>

export type ContextCompactionInput = Readonly<{
  messages: readonly ModelContextMessage[]
  currentTurnId?: string
  contextWindowTokens: number
  triggerRatio: number
  targetRatio: number
  incomingTokenEstimate: number
}>

export class ContextWindowManager {
  public plan(input: ContextCompactionInput): ContextCompactionPlan {
    const thresholdTokens = Math.max(1, Math.floor(input.contextWindowTokens * input.triggerRatio))
    const targetTokens = Math.max(1, Math.floor(input.contextWindowTokens * input.targetRatio))
    const currentMessages = [...input.messages].sort((left, right) => left.sequence - right.sequence)
    const protectedMessages = currentMessages.filter((message) => isProtected(message, input.currentTurnId))
    const protectedTokens = sumTokens(protectedMessages) + input.incomingTokenEstimate
    const initialTokens = sumTokens(currentMessages) + input.incomingTokenEstimate

    if (protectedTokens > input.contextWindowTokens) {
      return {
        phase: "none",
        hiddenMessageIds: [],
        visibleMessages: currentMessages,
        estimatedTokens: initialTokens,
        thresholdTokens,
        targetTokens,
        protectedTokens,
        blocked: true,
        reason: "Protected system rules, current turn, and incoming request exceed the model context window",
      }
    }
    if (initialTokens < thresholdTokens) {
      return completePlan("none", [], currentMessages, initialTokens, thresholdTokens, targetTokens, protectedTokens)
    }

    const nonNarrative = currentMessages.filter((message) => (
      !isProtected(message, input.currentTurnId) && message.kind !== "canonical_chapter"
    ))
    const firstVisible = currentMessages.filter((message) => !nonNarrative.includes(message))
    const firstTokens = sumTokens(firstVisible) + input.incomingTokenEstimate
    if (firstTokens <= targetTokens) {
      return completePlan("non_narrative", nonNarrative.map((message) => message.messageId), firstVisible, firstTokens, thresholdTokens, targetTokens, protectedTokens)
    }

    const oldChapters = firstVisible
      .filter((message) => message.kind === "canonical_chapter" && !isCurrentTurn(message, input.currentTurnId))
      .sort((left, right) => left.sequence - right.sequence)
    const hiddenMessageIds = nonNarrative.map((message) => message.messageId)
    const secondVisible = [...firstVisible]
    let estimatedTokens = firstTokens
    for (const chapter of oldChapters) {
      if (estimatedTokens <= targetTokens) break
      const index = secondVisible.findIndex((message) => message.messageId === chapter.messageId)
      if (index >= 0) secondVisible.splice(index, 1)
      hiddenMessageIds.push(chapter.messageId)
      estimatedTokens -= chapter.tokenEstimate
    }
    return completePlan(
      "chapter",
      hiddenMessageIds,
      secondVisible,
      estimatedTokens,
      thresholdTokens,
      targetTokens,
      protectedTokens,
      estimatedTokens > targetTokens
        ? "Protected current-turn content prevents reaching the configured compression target"
        : undefined,
    )
  }
}

function completePlan(
  phase: ContextCompactionPlan["phase"],
  hiddenMessageIds: readonly string[],
  visibleMessages: readonly ModelContextMessage[],
  estimatedTokens: number,
  thresholdTokens: number,
  targetTokens: number,
  protectedTokens: number,
  reason?: string,
): ContextCompactionPlan {
  return {
    phase,
    hiddenMessageIds,
    visibleMessages,
    estimatedTokens,
    thresholdTokens,
    targetTokens,
    protectedTokens,
    blocked: false,
    ...(reason === undefined ? {} : { reason }),
  }
}

function isProtected(message: ModelContextMessage, currentTurnId: string | undefined): boolean {
  return message.kind === "system_rules" || isCurrentTurn(message, currentTurnId)
}

function isCurrentTurn(message: ModelContextMessage, currentTurnId: string | undefined): boolean {
  return currentTurnId !== undefined && message.turnId === currentTurnId
}

function sumTokens(messages: readonly ModelContextMessage[]): number {
  return messages.reduce((total, message) => total + message.tokenEstimate, 0)
}

export function estimateModelMessageTokens(content: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(content).length / 4) + MODEL_MESSAGE_OVERHEAD_TOKENS)
}
