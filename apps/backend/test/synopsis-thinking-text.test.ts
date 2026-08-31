import { describe, expect, it } from "vitest"

import { normalizeThinkingDisplayText } from "../src/application/chapters/synopsis-thinking-text.js"

describe("normalizeThinkingDisplayText", () => {
  it("keeps natural-language provider reasoning", () => {
    expect(normalizeThinkingDisplayText("**Assessing access**\n\nNext step")).toContain("Assessing access")
  })

  it("extracts reason and selfReview from phase JSON reasoning", () => {
    const raw = JSON.stringify({
      outcome: "continue",
      reason: "用户仅给出修仙方向",
      selfReview: "符合 ReAct 引导",
      artifact: {
        assistantMessage: "你好",
        finalSelfReview: "未写正文",
      },
      requestedReads: [],
      citedReadIds: [],
      unresolvedDependencies: [],
    })
    expect(normalizeThinkingDisplayText(raw)).toBe("用户仅给出修仙方向\n\n符合 ReAct 引导\n\n未写正文")
  })

  it("extracts fields from partial streamed JSON", () => {
    const partial = '{"outcome":"continue","reason":"先收窄基调","selfReview":"暂未写'
    expect(normalizeThinkingDisplayText(partial)).toBe("先收窄基调")
  })

  it("hides raw JSON when no readable fields exist", () => {
    expect(normalizeThinkingDisplayText('{"outcome":"continue","requestedReads":[]}')).toBeUndefined()
  })
})
