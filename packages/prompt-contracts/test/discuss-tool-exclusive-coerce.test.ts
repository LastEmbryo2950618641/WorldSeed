import { describe, expect, it } from "vitest"

import {
  coerceSynopsisDiscussToolExclusive,
  consumeDiscussToolExclusiveStrip,
  parsePhaseArtifact,
  synopsisDiscussArtifactSchema,
} from "../src/index.js"

describe("synopsis discuss toolRequest exclusive coerce", () => {
  it("strips write fields when toolRequest is present", () => {
    const coerced = coerceSynopsisDiscussToolExclusive({
      assistantMessage: "先读目录",
      finalSelfReview: "工具单独一轮",
      toolRequest: { name: "bash", action: "describe" },
      focusChange: { chapterSequence: 3 },
      choices: [{ label: "换焦点", action: "set_focus", chapterSequence: 3 }],
    })
    expect(coerced.strippedKeys).toEqual(["focusChange", "choices"])
    expect(synopsisDiscussArtifactSchema.safeParse(coerced.value).success).toBe(true)
  })

  it("accepts continueTurn for auto-continued multi-step work", () => {
    const parsed = synopsisDiscussArtifactSchema.safeParse({
      assistantMessage: "第3章草稿已写，继续下一章",
      finalSelfReview: "ok",
      continueTurn: true,
    })
    expect(parsed.success).toBe(true)
  })

  it("keeps continueTurn alongside toolRequest (loop control, not a write)", () => {
    const coerced = coerceSynopsisDiscussToolExclusive({
      assistantMessage: "先发布第四章",
      finalSelfReview: "ok",
      toolRequest: { name: "publish_draft", action: "invoke" },
      continueTurn: true,
    })
    expect(coerced.strippedKeys).toEqual([])
    expect(synopsisDiscussArtifactSchema.safeParse(coerced.value).success).toBe(true)
  })

  it("parsePhaseArtifact auto-coerces before validating", () => {
    consumeDiscussToolExclusiveStrip()
    const parsed = parsePhaseArtifact("synopsis_discuss", {
      assistantMessage: "先工具",
      finalSelfReview: "ok",
      toolRequest: { name: "todo_write", action: "describe" },
      synopsisBody: "# should defer",
    }) as { toolRequest?: unknown; synopsisBody?: unknown }
    expect(parsed.toolRequest).toBeDefined()
    expect(parsed.synopsisBody).toBeUndefined()
    expect(consumeDiscussToolExclusiveStrip()).toEqual(["synopsisBody"])
  })
})
