import { describe, expect, it } from "vitest"
import { synopsisDiscussArtifactSchema } from "@worldseed/prompt-contracts"

import { filterDiscussChoices } from "../src/application/chapters/synopsis-conversation-service.js"
import { discussAgentModePromptAppendix } from "../src/application/chapters/discuss-agent-mode.js"

describe("discuss focusChange", () => {
  it("accepts focusChange on discuss artifacts", () => {
    const parsed = synopsisDiscussArtifactSchema.safeParse({
      assistantMessage: "第二章已完结，焦点切到第三章继续。",
      finalSelfReview: "已交付 focusChange，无需用户点确认。",
      focusChange: { chapterSequence: 3, focusKind: "plot_synopsis" },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.focusChange).toEqual({
      chapterSequence: 3,
      focusKind: "plot_synopsis",
    })
  })

  it("strips matching set_focus choices after focusChange applies", () => {
    const choices = filterDiscussChoices([
      { label: "是否将焦点调整到第3章", action: "set_focus", chapterSequence: 3 },
      { label: "整卷批量推", action: "continue_discuss" },
      { label: "是否将焦点调整到第4章", action: "set_focus", chapterSequence: 4 },
    ], { focusLocked: false, appliedFocusSequence: 3 })
    expect(choices).toEqual([
      { label: "整卷批量推", action: "continue_discuss" },
      { label: "是否将焦点调整到第4章", action: "set_focus", chapterSequence: 4 },
    ])
  })

  it("prompts Auto/Accept to use focusChange instead of confirmation buttons", () => {
    expect(discussAgentModePromptAppendix("auto", { batchProceed: true })).toContain("focusChange")
    expect(discussAgentModePromptAppendix("accept_edits", { batchProceed: true })).toContain("换章用 focusChange")
  })
})
