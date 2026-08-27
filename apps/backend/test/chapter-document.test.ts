import { describe, expect, it } from "vitest"

import {
  assembleChapterDocument,
  deriveChapterPublishPath,
  formatChapterSequenceLabel,
  parseChapterSequenceFromLabel,
  readChapterBody,
} from "../src/core/index.js"

describe("chapter document title contract", () => {
  it("uses one normalized heading for markdown and publish path", () => {
    const content = assembleChapterDocument("第一章 灯火新生", "正文从这里开始。")

    expect(content).toBe("# 第一章 灯火新生\n\n正文从这里开始。")
    expect(readChapterBody("第一章 灯火新生", content)).toBe("正文从这里开始。")
    expect(deriveChapterPublishPath("第一章 灯火新生")).toBe("章节正文/第一章 灯火新生.md")
  })

  it("keeps body content when a draft has no title", () => {
    expect(assembleChapterDocument("第一章 世界种子", "正文从这里开始。"))
      .toBe("# 第一章 世界种子\n\n正文从这里开始。")
  })

  it("does not infer a title from body text", () => {
    expect(assembleChapterDocument("第一章 灯火新生", "正文第一行不是标题。\n\n正文继续。"))
      .toBe("# 第一章 灯火新生\n\n正文第一行不是标题。\n\n正文继续。")
  })

  it("requires the title field to contain plain text", () => {
    expect(() => assembleChapterDocument("# 第一章 灯火新生", "正文从这里开始。"))
      .toThrow("plain text without Markdown markers")
    expect(() => assembleChapterDocument("第一章\n灯火新生", "正文从这里开始。"))
      .toThrow("single line")
  })

  it("parses chapter sequence labels from publish filenames", () => {
    expect(parseChapterSequenceFromLabel("第一章 世界种子")).toBe(1)
    expect(parseChapterSequenceFromLabel("第21章 世界种子")).toBe(21)
    expect(parseChapterSequenceFromLabel("第十二章 灯火")).toBe(12)
    expect(parseChapterSequenceFromLabel("第二十一章")).toBe(21)
    expect(parseChapterSequenceFromLabel("设定说明")).toBeUndefined()
  })

  it("formats chapter sequence labels with chinese numerals", () => {
    expect(formatChapterSequenceLabel(1)).toBe("第一章")
    expect(formatChapterSequenceLabel(2)).toBe("第二章")
    expect(formatChapterSequenceLabel(11)).toBe("第十一章")
    expect(formatChapterSequenceLabel(21)).toBe("第二十一章")
  })
})
