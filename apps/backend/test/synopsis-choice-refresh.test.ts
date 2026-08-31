import { describe, expect, it } from "vitest"

import {
  buildRefreshChoicesPrompt,
  mergeSynopsisChoices,
} from "../src/application/chapters/synopsis-conversation-service.js"

describe("synopsis choice refresh helpers", () => {
  it("merges unique labels and keeps existing order", () => {
    const merged = mergeSynopsisChoices(
      [
        { label: "热血扬眉", action: "continue_discuss" },
        { label: "清冷求道", action: "continue_discuss" },
      ],
      [
        { label: "热血扬眉", action: "continue_discuss" },
        { label: "权谋暗斗", action: "continue_discuss" },
        { label: "先落大纲", action: "confirm_arc_plan" },
      ],
    )
    expect(merged.map((choice) => choice.label)).toEqual([
      "热血扬眉",
      "清冷求道",
      "权谋暗斗",
      "先落大纲",
    ])
  })

  it("caps total choices", () => {
    const existing = Array.from({ length: 14 }, (_, index) => ({
      label: `旧${String(index)}`,
      action: "continue_discuss" as const,
    }))
    const merged = mergeSynopsisChoices(
      existing,
      [
        { label: "新A", action: "continue_discuss" },
        { label: "新B", action: "continue_discuss" },
        { label: "新C", action: "continue_discuss" },
      ],
      16,
    )
    expect(merged).toHaveLength(16)
    expect(merged.at(-1)?.label).toBe("新B")
  })

  it("lists existing labels in the refresh prompt", () => {
    const prompt = buildRefreshChoicesPrompt([
      { label: "热血扬眉：开局受辱，立誓修仙", action: "continue_discuss" },
    ])
    expect(prompt).toContain("请换一批决策选项")
    expect(prompt).toContain("- 热血扬眉：开局受辱，立誓修仙")
    expect(prompt).toContain("静默刷新")
  })
})
