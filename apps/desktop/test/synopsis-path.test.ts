import { describe, expect, it } from "vitest"

import {
  resolveChapterArtifactRelations,
  resolveChapterArtifactRelationsWithInventory,
  chapterArtifactStageLabel,
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
})
