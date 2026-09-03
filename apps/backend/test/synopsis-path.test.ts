import { describe, expect, it } from "vitest"

import {
  assembleSynopsisPlaceholderDocument,
  DEFAULT_VOLUME_FOLDER_NAME,
  deriveOutlineMarkdownPath,
  deriveSynopsisMarkdownPath,
  isChapterBodyMarkdownPath,
  isOutlineMarkdownPath,
  isSynopsisMarkdownPath,
  isSynopsisPlaceholderDocument,
  parseSynopsisMarkdownPath,
  parseSynopsisTitleFromLabel,
  resolveChapterMarkdownKind,
  siblingPlanningMarkdownPath,
  validateSynopsisMarkdownPath,
} from "../src/core/index.js"
import { formatChapterSequenceLabel } from "../src/core/chapters/chapter-document.js"

const VOL = "第一卷 潮水退去时"

describe("synopsis path helpers", () => {
  it("recognizes synopsis markdown paths under a volume", () => {
    expect(isSynopsisMarkdownPath(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`)).toBe(true)
    expect(isSynopsisMarkdownPath(`章节正文/${VOL}/第二章 雾港站的末班车[剧情梗概].md`)).toBe(true)
    expect(isSynopsisMarkdownPath(`章节正文/${VOL}/第二章 雾港站的末班车.md`)).toBe(false)
    expect(isSynopsisMarkdownPath("章节正文/第一桶金 [剧情梗概].md")).toBe(true)
  })

  it("gates synopsis that lack 第N章 or sit outside a volume", () => {
    const missingChapter = validateSynopsisMarkdownPath(`章节正文/${VOL}/第一桶金 [剧情梗概].md`)
    expect(missingChapter.ok).toBe(false)
    if (!missingChapter.ok) {
      expect(missingChapter.reason).toContain("第N章")
      expect(missingChapter.reason).toContain("第一桶金")
    }
    const loose = validateSynopsisMarkdownPath("章节正文/第二章 雾港站的末班车 [剧情梗概].md")
    expect(loose.ok).toBe(false)
    if (!loose.ok) expect(loose.reason).toContain("卷")
    const valid = validateSynopsisMarkdownPath(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`)
    expect(valid).toMatchObject({
      ok: true,
      sequence: 2,
      title: "雾港站的末班车",
      volumeFolderName: VOL,
    })
  })

  it("does not treat titles that merely start with 第 as full chapter headings", () => {
    expect(deriveSynopsisMarkdownPath(3, "第一桶金", VOL))
      .toBe(`章节正文/${VOL}/第三章 第一桶金 [剧情梗概].md`)
    expect(deriveSynopsisMarkdownPath(2, "第二章 已有标题", VOL))
      .toBe(`章节正文/${VOL}/第二章 已有标题 [剧情梗概].md`)
  })

  it("resolves chapter markdown kinds for code", () => {
    expect(resolveChapterMarkdownKind(`章节正文/${VOL}/第一章 世界种子.md`)).toBe("chapter_body")
    expect(resolveChapterMarkdownKind(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`)).toBe("plot_synopsis")
    expect(resolveChapterMarkdownKind(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情细纲].md`)).toBe("plot_outline")
    expect(isChapterBodyMarkdownPath(`章节正文/${VOL}/第一章 世界种子.md`)).toBe(true)
    expect(isChapterBodyMarkdownPath(`章节正文/${VOL}/第二章 待命名 [剧情梗概].md`)).toBe(false)
    expect(isChapterBodyMarkdownPath(`章节正文/${VOL}/第二章 待命名 [剧情细纲].md`)).toBe(false)
  })

  it("derives outline paths and siblings from synopsis", () => {
    expect(deriveOutlineMarkdownPath(2, "雾港站的末班车", VOL))
      .toBe(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情细纲].md`)
    const synopsis = `章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`
    expect(isOutlineMarkdownPath(siblingPlanningMarkdownPath(synopsis, "outline")!)).toBe(true)
    expect(siblingPlanningMarkdownPath(
      `章节正文/${VOL}/第二章 雾港站的末班车 [剧情细纲].md`,
      "synopsis",
    )).toBe(synopsis)
  })

  it("derives synopsis paths with volume, chinese chapter label, title, and suffix", () => {
    expect(formatChapterSequenceLabel(2)).toBe("第二章")
    expect(deriveSynopsisMarkdownPath(2, "雾港站的末班车", VOL))
      .toBe(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`)
    expect(deriveSynopsisMarkdownPath(2, "")).toBe(
      `章节正文/${DEFAULT_VOLUME_FOLDER_NAME}/第二章 待命名 [剧情梗概].md`,
    )
  })

  it("parses synopsis path labels", () => {
    expect(parseSynopsisMarkdownPath(`章节正文/${VOL}/第二章 雾港站的末班车 [剧情梗概].md`)).toEqual({
      sequence: 2,
      title: "雾港站的末班车",
      titleLabel: "第二章 雾港站的末班车",
      volumeFolderName: VOL,
    })
    expect(parseSynopsisTitleFromLabel("第二章 待命名")).toBeUndefined()
  })

  it("detects placeholder-only synopsis documents", () => {
    expect(isSynopsisPlaceholderDocument(assembleSynopsisPlaceholderDocument(2, ""))).toBe(true)
    expect(isSynopsisPlaceholderDocument("# 第二章 待命名 剧情梗概\n\n正文\n")).toBe(false)
  })
})
