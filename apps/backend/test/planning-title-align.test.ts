import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  deriveChapterPublishPath,
  deriveOutlineMarkdownPath,
  deriveSynopsisMarkdownPath,
} from "../src/core/index.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Planning Title Align Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

describe("planning title alignment on publish", () => {
  it("renames divergent synopsis/outline stems to the published chapter heading", async () => {
    await withHarness(async (harness) => {
      const volume = "第一卷 测试卷"
      const oldSynopsis = deriveSynopsisMarkdownPath(3, "北地来的信使", volume)
      const oldOutline = deriveOutlineMarkdownPath(3, "北地来的信使", volume)
      const publishedHeading = "第三章 秤与约"
      const chapterPath = deriveChapterPublishPath(publishedHeading, volume)
      const targetSynopsis = deriveSynopsisMarkdownPath(3, publishedHeading, volume)
      const targetOutline = deriveOutlineMarkdownPath(3, publishedHeading, volume)

      for (const relative of [oldSynopsis, oldOutline]) {
        const absolute = join(harness.workspaceRootRef, relative)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, `# ${relative}\n\n规划正文\n`, "utf8")
      }
      const bodyAbsolute = join(harness.workspaceRootRef, chapterPath)
      mkdirSync(dirname(bodyAbsolute), { recursive: true })
      writeFileSync(bodyAbsolute, `# ${publishedHeading}\n\n正式正文\n`, "utf8")

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createChapterSynopsisService()
      await service.alignPlanningTitlesToPublishedHeading({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterSequence: 3,
        chapterHeading: publishedHeading,
        chapterPath,
      })

      expect(existsSync(join(harness.workspaceRootRef, oldSynopsis))).toBe(false)
      expect(existsSync(join(harness.workspaceRootRef, oldOutline))).toBe(false)
      expect(readFileSync(join(harness.workspaceRootRef, targetSynopsis), "utf8")).toContain("规划正文")
      expect(readFileSync(join(harness.workspaceRootRef, targetOutline), "utf8")).toContain("规划正文")
    })
  }, 60_000)

  it("reports existing outline title so publish can keep the same heading", async () => {
    await withHarness(async (harness) => {
      const volume = "第一卷 测试卷"
      const outline = deriveOutlineMarkdownPath(3, "北地来的信使", volume)
      const absolute = join(harness.workspaceRootRef, outline)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, "# 第三章 北地来的信使 剧情细纲\n\n细纲内容\n", "utf8")

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createChapterSynopsisService()
      const planning = await service.findPlanningHeading({
        workspaceRootRef: harness.workspaceRootRef,
        chapterSequence: 3,
      })

      expect(planning?.titleLabel).toBe("第三章 北地来的信使")
      expect(planning?.volumeFolderName).toBe(volume)
    })
  }, 60_000)

  it("detects title divergence between body and planning files", async () => {
    await withHarness(async (harness) => {
      const volume = "第一卷 测试卷"
      const outline = deriveOutlineMarkdownPath(3, "北地来的信使", volume)
      const bodyHeading = "第三章 秤与约"
      const bodyPath = deriveChapterPublishPath(bodyHeading, volume)
      mkdirSync(dirname(join(harness.workspaceRootRef, outline)), { recursive: true })
      writeFileSync(join(harness.workspaceRootRef, outline), "# 细纲\n", "utf8")
      mkdirSync(dirname(join(harness.workspaceRootRef, bodyPath)), { recursive: true })
      writeFileSync(join(harness.workspaceRootRef, bodyPath), `# ${bodyHeading}\n\n正文\n`, "utf8")

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createChapterSynopsisService()
      const issue = await service.detectTitleAlignmentIssue({
        workspaceRootRef: harness.workspaceRootRef,
        chapterSequence: 3,
      })
      expect(issue?.bodyHeading).toBe(bodyHeading)
      expect(issue?.planningHeading).toBe("第三章 北地来的信使")
      expect(issue?.recommendedTarget).toBe("body")
    })
  }, 60_000)
})
