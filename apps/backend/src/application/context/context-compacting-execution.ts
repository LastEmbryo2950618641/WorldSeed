import type { PhaseRequestEnvelope, VisibleModelContextMessage } from "@worldseed/contracts"
import type { AIModelPort, ModelExecutionOptions, PhaseModelExecution } from "../turns/ports/ai-model-port.js"
import { estimateModelMessageTokens } from "./context-window-manager.js"

export type ContextCompactionEvent = Readonly<{
  reason: "usage_threshold" | "context_length_error"
  observedInputTokens?: number
  thresholdTokens: number
  hiddenMessageIds: readonly string[]
  remainingMessageCount: number
}>

export function readContextLengthError(error: unknown): { inputTokens?: number; limitTokens?: number } | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (!/context_length_exceeded|maximum context length|context window.{0,60}(exceed|limit)|exceed.{0,60}context|too many tokens/i.test(message)) return undefined
  const inputMatch = message.match(/([\d,]+)\s+in the messages/i)
    ?? message.match(/requested\s+([\d,]+)\s+tokens/i)
  const limitMatch = message.match(/maximum context length(?:\s+is|\s+of)?\s+([\d,]+)\s+tokens/i)
  const inputTokens = inputMatch === null ? undefined : Number(inputMatch[1]?.replaceAll(",", ""))
  const limitTokens = limitMatch === null ? undefined : Number(limitMatch[1]?.replaceAll(",", ""))
  return {
    ...(inputTokens === undefined || !Number.isFinite(inputTokens) ? {} : { inputTokens }),
    ...(limitTokens === undefined || !Number.isFinite(limitTokens) ? {} : { limitTokens }),
  }
}

// Provider usage decides when to compact. Text weights only choose how much old
// history to remove; they are never reported as measured token counts.
export async function executeWithContextCompaction(input: {
  model: AIModelPort
  request: PhaseRequestEnvelope
  options: ModelExecutionOptions
  lastRequestInputTokens?: number
  triggerRatio: number
  targetRatio: number
  onCompacted(event: ContextCompactionEvent): Promise<void>
}): Promise<PhaseModelExecution> {
  let messages = [...(input.options.contextMessages ?? [])]
  let windowTokens = input.model.info?.contextWindowTokens ?? 64_000
  const compact = async (reason: ContextCompactionEvent["reason"], observedInputTokens?: number): Promise<boolean> => {
    const removable = messages.filter((message) => message.kind !== "system_rules" && message.turnId !== input.request.turnId)
    const narrative = (message: VisibleModelContextMessage): boolean => message.kind === "canonical_chapter" || message.kind === "chapter_revision"
    const hidden = new Set(removable.filter((message) => !narrative(message)).map((message) => message.messageId))
    const weights = new Map(messages.map((message) => [message.messageId, estimateModelMessageTokens(message.content)]))
    const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
    const targetWeight = observedInputTokens === undefined || observedInputTokens <= 0
      ? 0
      : totalWeight * Math.min(1, windowTokens * input.targetRatio / observedInputTokens)
    let remainingWeight = totalWeight - [...hidden].reduce((sum, id) => sum + (weights.get(id) ?? 0), 0)
    for (const message of removable.filter(narrative).sort((a, b) => a.sequence - b.sequence)) {
      if (remainingWeight <= targetWeight) break
      hidden.add(message.messageId)
      remainingWeight -= weights.get(message.messageId) ?? 0
    }
    if (hidden.size === 0) return false
    messages = messages.filter((message) => !hidden.has(message.messageId))
    await input.onCompacted({
      reason,
      ...(observedInputTokens === undefined ? {} : { observedInputTokens }),
      thresholdTokens: Math.floor(windowTokens * input.triggerRatio),
      hiddenMessageIds: [...hidden],
      remainingMessageCount: messages.length,
    })
    return true
  }
  if (input.lastRequestInputTokens !== undefined && input.lastRequestInputTokens >= windowTokens * input.triggerRatio) {
    await compact("usage_threshold", input.lastRequestInputTokens)
  }
  for (let retry = 0; ; retry += 1) {
    input.options.signal?.throwIfAborted()
    try {
      return await input.model.execute(input.request, { ...input.options, contextMessages: messages })
    } catch (error) {
      input.options.signal?.throwIfAborted()
      const overflow = readContextLengthError(error)
      if (overflow === undefined) throw error
      if (overflow.limitTokens !== undefined && overflow.limitTokens > 0) windowTokens = Math.min(windowTokens, overflow.limitTokens)
      if (retry >= 2 || !await compact("context_length_error", overflow.inputTokens)) {
        throw new Error("上下文超限：已无法继续裁剪旧历史，系统规则、当前轮次或本次资料仍过大。请缩小本次输入或资料范围后重试。", { cause: error })
      }
      input.options.onSchemaRepair?.()
    }
  }
}
