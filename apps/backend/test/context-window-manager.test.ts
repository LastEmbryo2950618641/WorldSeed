import { describe, expect, it } from "vitest"

import { ContextWindowManager, estimateModelMessageTokens } from "../src/index.js"
import type { ModelContextMessage } from "@worldseed/contracts"

function message(input: Partial<ModelContextMessage> & Pick<ModelContextMessage, "messageId" | "sequence" | "kind" | "tokenEstimate">): ModelContextMessage {
  return {
    messageId: input.messageId,
    chainId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    sequence: input.sequence,
    role: input.role ?? "user",
    kind: input.kind,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    content: input.content ?? "content",
    contentDigest: "digest",
    tokenEstimate: input.tokenEstimate,
    createdAtMs: 1,
  }
}

describe("ContextWindowManager", () => {
  it("does not undercount common Chinese text as three quarters of a token per character", () => {
    expect(estimateModelMessageTokens("世界连续演化")).toBe(14)
  })

  it("treats chapter_revision as narrative during compaction", () => {
    const turnId = "00000000-0000-4000-8000-000000000010"
    const messages = [
      message({ messageId: "00000000-0000-4000-8000-000000000011", sequence: 0, kind: "system_rules", tokenEstimate: 10 }),
      message({ messageId: "00000000-0000-4000-8000-000000000012", sequence: 1, kind: "phase_response", tokenEstimate: 25, turnId: "00000000-0000-4000-8000-000000000020" }),
      message({ messageId: "00000000-0000-4000-8000-000000000013", sequence: 2, kind: "chapter_revision", tokenEstimate: 30, turnId: "00000000-0000-4000-8000-000000000020" }),
      message({ messageId: "00000000-0000-4000-8000-000000000014", sequence: 3, kind: "phase_response", tokenEstimate: 25, turnId }),
    ]
    const plan = new ContextWindowManager().plan({
      messages,
      currentTurnId: turnId,
      contextWindowTokens: 100,
      triggerRatio: 0.97,
      targetRatio: 0.5,
      incomingTokenEstimate: 10,
    })

    expect(plan.phase).toBe("chapter")
    expect(plan.hiddenMessageIds).toEqual([
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
    ])
  })

  it("removes older non-narrative messages before older chapters", () => {
    const turnId = "00000000-0000-4000-8000-000000000010"
    const messages = [
      message({ messageId: "00000000-0000-4000-8000-000000000011", sequence: 0, kind: "system_rules", tokenEstimate: 10 }),
      message({ messageId: "00000000-0000-4000-8000-000000000012", sequence: 1, kind: "phase_response", tokenEstimate: 25, turnId: "00000000-0000-4000-8000-000000000020" }),
      message({ messageId: "00000000-0000-4000-8000-000000000013", sequence: 2, kind: "canonical_chapter", tokenEstimate: 30, turnId: "00000000-0000-4000-8000-000000000020" }),
      message({ messageId: "00000000-0000-4000-8000-000000000014", sequence: 3, kind: "phase_response", tokenEstimate: 25, turnId }),
    ]
    const plan = new ContextWindowManager().plan({
      messages,
      currentTurnId: turnId,
      contextWindowTokens: 100,
      triggerRatio: 0.97,
      targetRatio: 0.5,
      incomingTokenEstimate: 10,
    })

    expect(plan.phase).toBe("chapter")
    expect(plan.hiddenMessageIds).toEqual([
      "00000000-0000-4000-8000-000000000012",
      "00000000-0000-4000-8000-000000000013",
    ])
    expect(plan.visibleMessages.map((item) => item.messageId)).toEqual([
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000014",
    ])
  })

  it("does not hide protected content when it alone exceeds the window", () => {
    const turnId = "00000000-0000-4000-8000-000000000010"
    const messages = [
      message({ messageId: "00000000-0000-4000-8000-000000000011", sequence: 0, kind: "system_rules", tokenEstimate: 70 }),
      message({ messageId: "00000000-0000-4000-8000-000000000012", sequence: 1, kind: "phase_request", tokenEstimate: 25, turnId }),
    ]
    const plan = new ContextWindowManager().plan({
      messages,
      currentTurnId: turnId,
      contextWindowTokens: 100,
      triggerRatio: 0.97,
      targetRatio: 0.5,
      incomingTokenEstimate: 10,
    })

    expect(plan.blocked).toBe(true)
    expect(plan.hiddenMessageIds).toEqual([])
  })
})
