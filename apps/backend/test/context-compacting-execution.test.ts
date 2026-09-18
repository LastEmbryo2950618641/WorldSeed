import { describe, expect, it, vi } from "vitest"
import type { PhaseRequestEnvelope, VisibleModelContextMessage } from "@worldseed/contracts"
import type { AIModelPort, PhaseModelExecution } from "../src/application/turns/ports/ai-model-port.js"
import { executeWithContextCompaction, readContextLengthError } from "../src/application/context/context-compacting-execution.js"

const request = { turnId: "current" } as PhaseRequestEnvelope
const result = { usage: { inputTokens: 123, lastRequestInputTokens: 123 } } as PhaseModelExecution
const message = (id: string, kind: VisibleModelContextMessage["kind"], turnId: string, sequence: number): VisibleModelContextMessage => ({
  messageId: id, kind, turnId, sequence, role: "user", content: "短文本",
})
const messages = [message("system", "system_rules", "old", 0), message("old", "phase_response", "old", 1), message("chapter", "canonical_chapter", "old", 2), message("current", "phase_request", "current", 3)]
function setup(tokens?: number) {
  const execute = vi.fn<AIModelPort["execute"]>().mockResolvedValue(result)
  const onCompacted = vi.fn().mockResolvedValue(undefined)
  const input = {
    model: { info: { provider: "test", model: "test", available: true, contextWindowTokens: 1_000_000 }, execute },
    request, options: { contextMessages: messages }, triggerRatio: 0.9, targetRatio: 0.5,
    ...(tokens === undefined ? {} : { lastRequestInputTokens: tokens }), onCompacted,
  }
  return { input, execute, onCompacted }
}

describe("provider-measured context compaction", () => {
  it("triggers at 90% even when local text estimates are tiny", async () => {
    const { input, execute, onCompacted } = setup(900_000)
    await executeWithContextCompaction(input)
    expect(onCompacted).toHaveBeenCalledWith(expect.objectContaining({ reason: "usage_threshold", observedInputTokens: 900_000, thresholdTokens: 900_000 }))
    expect(execute.mock.calls[0]?.[1]?.contextMessages?.map((m) => m.messageId)).toEqual(["system", "current"])
  })
  it.each([undefined, 899_999])("does not substitute estimates for provider usage (%s)", async (tokens) => {
    const { input, execute, onCompacted } = setup(tokens)
    input.options.contextMessages = messages.map((m) => ({ ...m, content: "世界".repeat(100_000) }))
    await executeWithContextCompaction(input)
    expect(onCompacted).not.toHaveBeenCalled()
    expect(execute.mock.calls[0]?.[1]?.contextMessages).toHaveLength(4)
  })
  it("compacts and resubmits the same user request after the reported 400", async () => {
    const { input, execute, onCompacted } = setup()
    execute.mockRejectedValueOnce(new Error("DeepSeek request failed: 400 This model's maximum context length is 1048576 tokens. However, you requested 1056215 tokens (1056215 in the messages, 0 in the completion)."))
    await expect(executeWithContextCompaction(input)).resolves.toBe(result)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[0]).toBe(request)
    expect(execute.mock.calls[1]?.[1]?.contextMessages?.map((m) => m.messageId)).toEqual(["system", "current"])
    expect(onCompacted).toHaveBeenCalledWith(expect.objectContaining({ reason: "context_length_error", observedInputTokens: 1_056_215 }))
  })
  it("forces compaction even when the provider reports no token count", async () => {
    const { input, execute } = setup()
    execute.mockRejectedValueOnce(new Error("400 context_length_exceeded"))
    await executeWithContextCompaction(input)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it("stops when only protected content remains instead of retrying unchanged input", async () => {
    const { input, execute } = setup()
    execute.mockRejectedValue(new Error("400 context_length_exceeded"))
    await expect(executeWithContextCompaction(input)).rejects.toThrow("已无法继续裁剪")
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it("does not retry unrelated API errors", async () => {
    const { input, execute, onCompacted } = setup()
    execute.mockRejectedValue(new Error("401 Invalid API key"))
    await expect(executeWithContextCompaction(input)).rejects.toThrow("401")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(onCompacted).not.toHaveBeenCalled()
  })
  it("honors cancellation between compression and resubmission", async () => {
    const { input, execute, onCompacted } = setup()
    const controller = new AbortController()
    execute.mockRejectedValueOnce(new Error("context_length_exceeded"))
    onCompacted.mockImplementation(() => { controller.abort(); return Promise.resolve() })
    await expect(executeWithContextCompaction({ ...input, options: { ...input.options, signal: controller.signal } })).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it("parses comma-separated limits without treating other 400s as overflow", () => {
    expect(readContextLengthError(new Error("maximum context length is 1,048,576 tokens; requested 1,056,215 tokens"))).toEqual({ inputTokens: 1056215, limitTokens: 1048576 })
    expect(readContextLengthError(new Error("400 invalid response format"))).toBeUndefined()
    expect(readContextLengthError(new Error("maximum context length is 100 tokens; requested 110 tokens (95 in the messages, 15 in the completion)"))?.inputTokens).toBe(95)
  })
})
