import { describe, expect, it } from "vitest"

import {
  formatTemporalSearchLabel,
  validateTemporalChapterSequence,
} from "../src/application/chapters/synopsis-temporal-reads.js"

describe("synopsis temporal reads", () => {
  it("formats as-of search labels", () => {
    const label = formatTemporalSearchLabel({
      requestId: "22222222-2222-4222-8222-222222222222",
      reason: "flashback",
      expectedEvidence: "old lore",
      query: {
        exactKeys: ["设定集/人物/林照.md"],
        semanticTexts: ["林照"],
        anchorIds: [],
        directions: ["both"],
        maxCandidates: 2,
        maxDepth: 0,
        sourceKinds: ["reference"],
        purpose: "as_of_chapter",
        asOfChapterSequence: 8,
      },
    })
    expect(label).toContain("第8章")
    expect(label).toContain("林照")
  })

  it("validates chapter sequence against session cursor", () => {
    expect(validateTemporalChapterSequence({ asOfChapterSequence: 3, sessionChapterSequence: 12 })).toBe(true)
    expect(validateTemporalChapterSequence({ asOfChapterSequence: 12, sessionChapterSequence: 12 })).toBe(false)
    expect(validateTemporalChapterSequence({ asOfChapterSequence: 0, sessionChapterSequence: 5 })).toBe(false)
  })
})
