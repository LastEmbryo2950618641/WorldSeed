import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION, type GraphRevisionModelActivity, type PhaseRequestEnvelope, type VisibleModelContextMessage } from "@worldseed/contracts"
import type { AIModelPort } from "../src/application/turns/ports/ai-model-port.js"
import { createGraphRevisionModel } from "../src/application/chapters/graph-revision-model.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"

const request = (): PhaseRequestEnvelope => ({
  schemaVersion: 1, protocolVersion: PROTOCOL_VERSION, projectId: randomUUID(), taskId: randomUUID(), turnId: randomUUID(),
  scopeId: randomUUID(), contextId: randomUUID(), envelopeId: randomUUID(), phase: "interpret", promptRef: "v1:interpret",
  promptDigest: "test", contextViewRef: "test", committedReadIds: [], visiblePendingIds: [],
  remainingBudget: { maxCalls: 10, remainingCalls: 10, maxInputTokens: 10000, remainingInputTokens: 10000,
    maxOutputTokens: 10000, remainingOutputTokens: 10000, deadlineAtMs: Date.now() + 60000 },
  input: { workflow: "revision", userInput: "Revised chapter", chapterSequence: 1, sourceUnitIds: [], phaseRunIds: [], readEvidence: [], retrievalGaps: [], artifacts: {} },
})

describe("graph revision model", () => {
  it("keeps canonical prose, rules and this task while projecting out other phase exchanges", async () => {
    const input = request()
    const messages: VisibleModelContextMessage[] = ["system_rules", "canonical_chapter", "chapter_revision", "phase_request", "phase_response", "phase_instruction"].map((kind, sequence) => ({
      messageId: randomUUID(), sequence, role: "user", kind: kind as VisibleModelContextMessage["kind"], content: kind, taskId: "old-task",
    }))
    messages.push({ messageId: randomUUID(), sequence: 6, role: "user", kind: "phase_request", taskId: input.taskId, content: "current task" })
    const fake = new FakeAiModelAdapter()
    const execute = vi.fn<AIModelPort["execute"]>((req, options) => {
      expect(options?.contextMessages?.map((message) => message.content)).toEqual(["system_rules", "canonical_chapter", "chapter_revision", "current task"])
      expect(options?.contextChainId).toContain(input.taskId)
      return fake.execute(req)
    })
    await createGraphRevisionModel({ info: fake.info, execute }, () => undefined).execute(input, { contextMessages: messages, contextChainId: "shared-chain" })
    expect(messages).toHaveLength(7)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("reports streamed activity and repair attempts, and clears activity on completion", async () => {
    const updates = vi.fn<(activity: GraphRevisionModelActivity | undefined) => void>()
    const fake = new FakeAiModelAdapter()
    await createGraphRevisionModel({ execute: (req, options) => {
      options?.onPartial?.({ reasoningDelta: "thinking" })
      options?.onSchemaRepair?.()
      options?.onPartial?.({ contentDelta: "{}" })
      return fake.execute(req)
    } }, updates).execute(request())
    expect(updates.mock.calls.map(([activity]) => activity?.stage)).toEqual(["waiting", "thinking", "repairing", "responding", undefined])
    expect(updates.mock.calls[3]?.[0]).toMatchObject({ attempt: 2, contentCharacters: 2 })
  })

  it("ends a stalled provider even if it ignores cancellation, without late activity", async () => {
    vi.useFakeTimers()
    try {
      const updates = vi.fn<(activity: GraphRevisionModelActivity | undefined) => void>()
      const stalled = vi.fn(() => new Promise<never>(() => undefined))
      const pending = createGraphRevisionModel({ execute: stalled }, updates, { idleTimeoutMs: 1000 }).execute(request())
      const rejection = expect(pending).rejects.toThrow("未返回数据")
      await vi.advanceTimersByTimeAsync(1001)
      await rejection
      expect(stalled).toHaveBeenCalledOnce()
      expect(updates).toHaveBeenLastCalledWith(undefined)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("resets the inactivity deadline on each chunk and respects user cancellation", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let partial: ((delta: { contentDelta: string }) => void) | undefined
      const updates = vi.fn<(activity: GraphRevisionModelActivity | undefined) => void>()
      const pending = createGraphRevisionModel({ execute: (_req, options) => {
        partial = options?.onPartial
        return new Promise<never>(() => undefined)
      } }, updates, { idleTimeoutMs: 1000 }).execute(request(), { signal: controller.signal })
      const rejection = expect(pending).rejects.toThrow("user cancelled")
      await vi.advanceTimersByTimeAsync(800)
      partial?.({ contentDelta: "a" })
      await vi.advanceTimersByTimeAsync(800)
      expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "responding" })
      controller.abort(new Error("user cancelled"))
      await rejection
      partial?.({ contentDelta: "late data" })
      expect(updates).toHaveBeenLastCalledWith(undefined)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
