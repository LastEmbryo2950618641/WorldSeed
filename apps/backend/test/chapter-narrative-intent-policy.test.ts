import { describe, expect, it } from "vitest"

import {
  chapterNarrativeIntentPhaseAppendix,
  chapterPresentationPhaseAppendix,
  DEFAULT_CHAPTER_NARRATIVE_INTENT,
  resolveChapterNarrativeIntent,
} from "../src/application/settings/chapter-narrative-intent-policy.js"

describe("chapter narrative intent policy", () => {
  it("defaults to advance_allowed + auto", () => {
    expect(resolveChapterNarrativeIntent(undefined)).toEqual(DEFAULT_CHAPTER_NARRATIVE_INTENT)
  })

  it("injects appendix for synopsis_discuss and draft only", () => {
    const hold = chapterNarrativeIntentPhaseAppendix({
      boundaryPace: "hold_without_resolution",
      causalityFocus: "payoff",
    }, "draft")
    expect(hold).toContain("压而不决")
    expect(hold).toContain("不可逆")
    expect(hold).toContain("落点")
    expect(hold).toContain("可逆/局部落点")
    expect(hold).toContain("不管设定能否新造")

    const discuss = chapterNarrativeIntentPhaseAppendix(undefined, "synopsis_discuss")
    expect(discuss).toContain("可推进")
    expect(discuss).toContain("自动")

    expect(chapterNarrativeIntentPhaseAppendix(undefined, "rule_assembly")).toBeUndefined()
    expect(chapterNarrativeIntentPhaseAppendix(undefined, "settings_extraction")).toBeUndefined()
  })

  it("injects creation-desk word budget into synopsis_discuss", () => {
    const appendix = chapterPresentationPhaseAppendix({
      minimumWordCount: 2000,
      maximumWordCount: 3000,
      proseStyleRulePath: "表现输出/笔风规则/吞心萌动.md",
    }, "synopsis_discuss")
    expect(appendix).toContain("2000–3000")
    expect(appendix).toContain("不得改用自拟")
    expect(appendix).toContain("吞心萌动.md")
    expect(chapterPresentationPhaseAppendix({
      minimumWordCount: 2000,
      maximumWordCount: 3000,
    }, "draft")).toBeUndefined()
  })
})
