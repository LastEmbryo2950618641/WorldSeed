import { describe, expect, it } from "vitest"

import {
  resolveChapterArtifactRelations,
  resolveChapterArtifactRelationsWithInventory,
  resolveChapterPathWithInventory,
  chapterArtifactStageLabel,
  listDiscussFocusChapters,
  discussFocusOpenLabel,
} from "../src/renderer/src/features/editor/synopsis-path.js"

describe("chapter artifact relations", () => {
  it("resolves sibling synopsis/outline/body paths from an outline file", () => {
    const relations = resolveChapterArtifactRelations(
      "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md",
    )
    expect(relations).toEqual({
      kind: "plot_outline",
      currentPath: "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md",
      synopsisPath: "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情梗概].md",
      outlinePath: "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md",
      bodyPath: "章节正文/第一卷 王旗未立/第一章 潮水退去时.md",
    })
    expect(chapterArtifactStageLabel("plot_outline")).toBe("细纲")
  })

  it("resolves sibling planning paths from a body file", () => {
    const relations = resolveChapterArtifactRelations(
      "章节正文/第一卷 王旗未立/第一章 潮水退去时.md",
    )
    expect(relations?.synopsisPath).toBe("章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情梗概].md")
    expect(relations?.outlinePath).toBe("章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md")
    expect(relations?.kind).toBe("chapter_body")
  })

  it("falls back to same-sequence planning files when titles diverge", () => {
    const relations = resolveChapterArtifactRelationsWithInventory(
      "章节正文/第一卷 王旗未立/第三章 秤与约.md",
      [
        "章节正文/第一卷 王旗未立/第三章 北地来的信使 [剧情细纲].md",
        "章节正文/第一卷 王旗未立/第三章 秤与约.md",
        "章节正文/第一卷 王旗未立/第二章 盐与账本.md",
      ],
    )
    expect(relations?.outlinePath).toBe("章节正文/第一卷 王旗未立/第三章 北地来的信使 [剧情细纲].md")
    expect(relations?.bodyPath).toBe("章节正文/第一卷 王旗未立/第三章 秤与约.md")
  })

  it("recovers a stale untitled planning path after the chapter title is written", () => {
    expect(resolveChapterPathWithInventory(
      "章节正文/第一卷 开局即仇敌/第二章 [剧情细纲].md",
      [
        "章节正文/第一卷 开局即仇敌/第二章 清河会 [剧情梗概].md",
        "章节正文/第一卷 开局即仇敌/第二章 清河会 [剧情细纲].md",
      ],
    )).toBe("章节正文/第一卷 开局即仇敌/第二章 清河会 [剧情细纲].md")
  })

  it("does not guess between multiple same-chapter files", () => {
    const old = "章节正文/第一卷 开局即仇敌/第二章 [剧情细纲].md"
    expect(resolveChapterPathWithInventory(old, [
      old.replace("第二章 ", "第二章 清河会 "),
      old.replace("第二章 ", "第二章 新标题 "),
    ])).toBe(old)
  })

  it("matches numeric chapter identities but never another volume or artifact kind", () => {
    const old = "章节正文/第一卷 开局即仇敌/第二章 [剧情细纲].md"
    const renamed = "章节正文/第一卷 开局即仇敌/第2章 清河会 [剧情细纲].md"
    expect(resolveChapterPathWithInventory(old, [renamed])).toBe(renamed)
    expect(resolveChapterPathWithInventory(old, [
      renamed.replace("第一卷", "第二卷"),
      renamed.replace("剧情细纲", "剧情梗概"),
      renamed.replace("第2章", "第3章"),
    ])).toBe(old)
    expect(resolveChapterPathWithInventory(old, [renamed, old])).toBe(old)
  })
})

describe("discuss focus chapters", () => {
  it("groups planning and body files by chapter sequence", () => {
    const chapters = listDiscussFocusChapters([
      "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情梗概].md",
      "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md",
      "章节正文/第一卷 王旗未立/第一章 潮水退去时.md",
      "章节正文/第一卷 王旗未立/第二章 盐与账本 [剧情梗概].md",
      "设定集/人物.md",
    ])
    expect(chapters).toEqual([
      {
        sequence: 1,
        label: "第一章 潮水退去时",
        synopsisPath: "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情梗概].md",
        outlinePath: "章节正文/第一卷 王旗未立/第一章 潮水退去时 [剧情细纲].md",
        bodyPath: "章节正文/第一卷 王旗未立/第一章 潮水退去时.md",
      },
      {
        sequence: 2,
        label: "第二章 盐与账本",
        synopsisPath: "章节正文/第一卷 王旗未立/第二章 盐与账本 [剧情梗概].md",
      },
    ])
    expect(discussFocusOpenLabel("plot_synopsis")).toBe("打开梗概文件")
    expect(discussFocusOpenLabel("plot_outline")).toBe("打开细纲文件")
    expect(discussFocusOpenLabel("chapter_body")).toBe("打开正文文件")
  })
})
