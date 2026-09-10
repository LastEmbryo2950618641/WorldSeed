import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  DEFAULT_VOLUME_FOLDER_NAME,
  extractVolumeFolderNameFromPath,
} from "../src/core/chapters/chapter-volume.js"
import { deriveSynopsisMarkdownPath } from "../src/core/chapters/synopsis-path.js"
import {
  openChapterHarness,
  seedCommittedChapter,
  type ChapterHarness,
} from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Chapter Body Rematerialize Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

async function invoke<T>(harness: ChapterHarness, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) expect.fail(JSON.stringify(response.error))
  return response.data as T
}

describe("chapter body rematerialize from contentRef", () => {
  it("restores a missing published body on rematerialize and on workspace.list", async () => {
    await withHarness(async (harness) => {
      const seeded = await seedCommittedChapter(harness)
      const listed = await invoke<Array<{ publishPath: string; heading: string }>>(harness, "chapter.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const chapter = listed[0]
      expect(chapter).toBeDefined()
      const publishPath = chapter!.publishPath
      const absolute = join(harness.workspaceRootRef, publishPath)
      expect(existsSync(absolute)).toBe(true)
      const original = readFileSync(absolute, "utf8")
      expect(original).toContain(seeded.body.slice(0, Math.min(12, seeded.body.length)))

      unlinkSync(absolute)
      expect(existsSync(absolute)).toBe(false)

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const result = await runtime.rematerializeMissingPublishedBodies()
      expect(result.restored).toBe(1)
      expect(result.paths).toContain(publishPath)
      expect(existsSync(absolute)).toBe(true)
      expect(readFileSync(absolute, "utf8")).toBe(original)

      unlinkSync(absolute)
      await invoke(harness, "workspace.list", { workspaceRootRef: harness.workspaceRootRef })
      expect(existsSync(absolute)).toBe(true)
      expect(readFileSync(absolute, "utf8")).toBe(original)
    })
  }, 120_000)

  it("aligns planning titles when restoring a missing body", async () => {
    await withHarness(async (harness) => {
      await seedCommittedChapter(harness)
      const listed = await invoke<Array<{ publishPath: string; heading: string }>>(harness, "chapter.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const chapter = listed[0]!
      const absolute = join(harness.workspaceRootRef, chapter.publishPath)
      const volume = extractVolumeFolderNameFromPath(chapter.publishPath) ?? DEFAULT_VOLUME_FOLDER_NAME
      const bodyHeading = chapter.publishPath.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.md$/u, "")

      const wrongSynopsis = deriveSynopsisMarkdownPath(1, "旧标题占位", volume)
      const wrongAbsolute = join(harness.workspaceRootRef, wrongSynopsis)
      mkdirSync(dirname(wrongAbsolute), { recursive: true })
      writeFileSync(wrongAbsolute, "# 第一章 旧标题占位 剧情梗概\n\n占位梗概。\n", "utf8")

      unlinkSync(absolute)
      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const result = await runtime.rematerializeMissingPublishedBodies()
      expect(result.restored).toBe(1)
      expect(result.aligned).toBeGreaterThanOrEqual(1)
      expect(existsSync(absolute)).toBe(true)

      const expectedSynopsis = deriveSynopsisMarkdownPath(1, bodyHeading, volume)
      expect(existsSync(join(harness.workspaceRootRef, expectedSynopsis))).toBe(true)
      expect(existsSync(wrongAbsolute)).toBe(false)
    })
  }, 120_000)
})
