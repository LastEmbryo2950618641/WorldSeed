import { describe, expect, it } from "vitest"

import { MODEL_CONTEXT_DELTA_HEADER } from "../src/application/context/model-context-appender.js"
import { buildContextUsageBreakdown } from "../src/application/context/context-usage-breakdown.js"
import { estimateModelMessageTokens } from "../src/application/context/context-window-manager.js"
import type { ModelContextMessage } from "@worldseed/contracts"

function message(
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
    contentDigest: "d",
    tokenEstimate: partial.tokenEstimate ?? estimateModelMessageTokens(content),
    createdAtMs: 1,
  }
}

describe("buildContextUsageBreakdown", () => {
  it("returns empty when there are no messages", () => {
    const result = buildContextUsageBreakdown({
      messages: [],
      contextWindowTokens: 100_000,
    })
    expect(result.empty).toBe(true)
    expect(result.usedTokens).toBe(0)
    expect(result.categories).toEqual([])
  })

  it("classifies system rules and conversation history", () => {
    const result = buildContextUsageBreakdown({
      contextWindowTokens: 100_000,
      messages: [
        message({ kind: "system_rules", sequence: 0, content: "base rules ".repeat(20), role: "system" }),
        message({ kind: "phase_response", sequence: 1, content: "assistant reply ".repeat(30), role: "assistant" }),
      ],
    })
    expect(result.empty).toBe(false)
    const ids = result.categories.map((category) => category.id)
    expect(ids).toContain("system_rules")
    expect(ids).toContain("conversation")
    expect(result.categories.find((category) => category.id === "system_rules")?.compressible).toBe(false)
    expect(result.categories.find((category) => category.id === "conversation")?.compressible).toBe(true)
  })

  it("classifies skill packs as compressible skills", () => {
    const result = buildContextUsageBreakdown({
      contextWindowTokens: 100_000,
      messages: [
        message({ kind: "system_rules", sequence: 0, content: "skill index only", role: "system" }),
        message({
          kind: "phase_instruction",
          sequence: 1,
          content: "【skill-pack:synopsis_discuss】\n{\"protocol\":\"synopsis-skills-v1\",\"kind\":\"default_pack\"}\n【skill:webnovel-deslop】body",
          role: "system",
        }),
      ],
    })
    const skills = result.categories.find((category) => category.id === "skills")
    expect(skills?.tokens).toBeGreaterThan(0)
    expect(skills?.compressible).toBe(true)
    expect(result.categories.find((category) => category.id === "system_rules")?.label).toContain("索引")
  })

  it("does not mislabel markdown phase prompts as tools", () => {
    const result = buildContextUsageBreakdown({
      contextWindowTokens: 100_000,
      messages: [
        message({
          kind: "phase_instruction",
          sequence: 0,
          content: "# synopsis_discuss\n使用 todo_write 与 request_read 推进工作流。",
          role: "user",
        }),
        message({
          kind: "phase_instruction",
          sequence: 1,
          content: JSON.stringify({
            protocol: "synopsis-tools-v1",
            instruction: "按需使用工具",
            tools: [{ name: "todo_write" }],
          }),
          role: "system",
        }),
      ],
    })
    const byId = Object.fromEntries(result.categories.map((category) => [category.id, category.tokens]))
    expect(byId.phase_prompt).toBeGreaterThan(0)
    expect(byId.tools).toBeGreaterThan(0)
  })

  it("splits latest phase_request delta into presentation and evidence", () => {
    const delta = {
      phase: "synopsis_discuss",
      protocolVersion: 1,
      input: {
        presentation: { proseStyleRulePath: "规则.md" },
        presentationEvidence: [{ readId: "p1", ownerKind: "workspace:presentation", relativePath: "规则.md" }],
        readEvidence: [
          { readId: "m1", relativePath: "世界推演规则/Agent记忆/MEMORY.md", content: "mem" },
          { readId: "e1", relativePath: "设定集/人物.md", content: "char ".repeat(40) },
        ],
        synopsisDiscuss: { synopsisBody: "梗概 ".repeat(50) },
        userInput: "继续写",
      },
    }
    const content = `${MODEL_CONTEXT_DELTA_HEADER}\n${JSON.stringify(delta)}`
    const result = buildContextUsageBreakdown({
      contextWindowTokens: 256_000,
      lastRequestInputTokens: 12_000,
      messages: [
        message({ kind: "system_rules", sequence: 0, content: "rules", role: "system" }),
        message({ kind: "phase_request", sequence: 1, content }),
      ],
    })
    expect(result.usedTokens).toBe(12_000)
    const ids = new Set(result.categories.map((category) => category.id))
    expect(ids.has("presentation_rules") || ids.has("evidence") || ids.has("narrative") || ids.has("memory")).toBe(true)
  })
})
