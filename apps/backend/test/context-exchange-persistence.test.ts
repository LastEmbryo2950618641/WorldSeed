import { describe, expect, it } from "vitest"

import {
  filterNovelContextExchangeMessages,
  findExactDuplicateStaticMessageIds,
} from "../src/application/context/context-exchange-persistence.js"
import { estimateModelMessageTokens } from "../src/application/context/context-window-manager.js"
import type { ModelContextMessage, ModelContextMessageDraft } from "@worldseed/contracts"
import { digest } from "../src/core/index.js"

function stored(
  partial: Pick<ModelContextMessage, "kind" | "content" | "sequence"> & Partial<ModelContextMessage>,
): ModelContextMessage {
  const content = partial.content ?? "x"
  return {
    messageId: partial.messageId ?? crypto.randomUUID(),
    chainId: partial.chainId ?? crypto.randomUUID(),
    projectId: partial.projectId ?? "11111111-1111-4111-8111-111111111111",
    sequence: partial.sequence,
    role: partial.role ?? "user",
    kind: partial.kind,
    content,
    contentDigest: digest(content),
    tokenEstimate: estimateModelMessageTokens(content),
    createdAtMs: 1,
  }
}

describe("filterNovelContextExchangeMessages", () => {
  it("keeps the first static instruction and skips later identical copies", () => {
    const instruction = "# synopsis_discuss\n阶段提示"
    const contract = "MANDATORY OUTPUT CONTRACT - this is the final"
    const existing = [
      stored({ kind: "phase_instruction", content: instruction, sequence: 0 }),
      stored({ kind: "phase_request", content: contract, sequence: 1 }),
    ]
    const drafts: ModelContextMessageDraft[] = [
      { role: "user", kind: "phase_request", content: "Worldseed context delta JSON:\n{\"phase\":\"x\"}" },
      { role: "user", kind: "phase_instruction", content: instruction },
      { role: "user", kind: "phase_protocol", content: "protocol" },
      { role: "user", kind: "phase_request", content: contract },
      { role: "assistant", kind: "phase_response", content: "{\"ok\":true}" },
    ]
    const kept = filterNovelContextExchangeMessages(existing, drafts)
    expect(kept.map((message) => message.kind)).toEqual([
      "phase_request",
      "phase_protocol",
      "phase_response",
    ])
  })

  it("finds later exact duplicates for cleanup", () => {
    const instruction = "# synopsis_discuss\n阶段提示"
    const messages = [
      stored({ kind: "phase_instruction", content: instruction, sequence: 0, messageId: "keep" }),
      stored({ kind: "phase_instruction", content: instruction, sequence: 1, messageId: "dup-a" }),
      stored({ kind: "phase_instruction", content: instruction, sequence: 2, messageId: "dup-b" }),
      stored({ kind: "phase_response", content: "reply", sequence: 3, messageId: "reply" }),
    ]
    expect(findExactDuplicateStaticMessageIds(messages)).toEqual(["dup-a", "dup-b"])
  })
})
