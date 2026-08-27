import { describe, expect, it } from "vitest"

import {
  deriveSynopsisMarkdownPath,
  isChapterBodyMarkdownPath,
  isSynopsisMarkdownPath,
  parseSynopsisMarkdownPath,
  parseSynopsisTitleFromLabel,
  resolveChapterMarkdownKind,
} from "../src/core/chapters/synopsis-path.js"
import { formatChapterSequenceLabel } from "../src/core/chapters/chapter-document.js"

describe("synopsis path helpers", () => {
  it("recognizes synopsis markdown paths", () => {
    expect(isSynopsisMarkdownPath("章节正文/第二章 雾港站的末班车 [剧情梗概].md")).toBe(true)
    expect(isSynopsisMarkdownPath("章节正文/第二章 雾港站的末班车[剧情梗概].md")).toBe(true)
    expect(isSynopsisMarkdownPath("章节正文/第二章 雾港站的末班车.md")).toBe(false)
  })

  it("resolves chapter markdown kinds for code", () => {
    expect(resolveChapterMarkdownKind("章节正文/第一章 世界种子.md")).toBe("chapter_body")
    expect(resolveChapterMarkdownKind("章节正文/第二章 雾港站的末班车 [剧情梗概].md")).toBe("plot_synopsis")
    expect(isChapterBodyMarkdownPath("章节正文/第一章 世界种子.md")).toBe(true)
    expect(isChapterBodyMarkdownPath("章节正文/第二章 待命名 [剧情梗概].md")).toBe(false)
  })

  it("derives synopsis paths with chinese chapter label, title, and suffix", () => {
    expect(formatChapterSequenceLabel(2)).toBe("第二章")
    expect(deriveSynopsisMarkdownPath(2, "雾港站的末班车")).toBe("章节正文/第二章 雾港站的末班车 [剧情梗概].md")
    expect(deriveSynopsisMarkdownPath(2, "")).toBe("章节正文/第二章 待命名 [剧情梗概].md")
  })

  it("parses synopsis path labels", () => {
    expect(parseSynopsisMarkdownPath("章节正文/第二章 雾港站的末班车 [剧情梗概].md")).toEqual({
      sequence: 2,
      title: "雾港站的末班车",
      titleLabel: "第二章 雾港站的末班车",
    })
    expect(parseSynopsisTitleFromLabel("第二章 待命名")).toBeUndefined()
  })
})
