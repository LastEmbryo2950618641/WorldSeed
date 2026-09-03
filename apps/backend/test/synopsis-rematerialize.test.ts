import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  assembleSynopsisPlaceholderDocument,
  deriveSynopsisMarkdownPath,
  isSynopsisPlaceholderDocument,
} from "../src/core/chapters/synopsis-path.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Synopsis Rematerialize Test")
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

async function ensureHistoryTask(harness: ChapterHarness): Promise<string> {
  const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
  const taskId = randomUUID()
  await runtime.taskScopes.create({
    projectId: harness.projectId,
    taskId,
    turnId: randomUUID(),
    scopeId: randomUUID(),
    kind: "turn",
    status: "created",
    reason: "synopsis rematerialize fixture",
    configSnapshot: {},
    promptSnapshot: {},
    createdAtMs: Date.now(),
  })
  return taskId
}

describe("synopsis rematerialize after return previous round", () => {
  it("detects placeholder-only synopsis documents", () => {
    expect(isSynopsisPlaceholderDocument(assembleSynopsisPlaceholderDocument(2, ""))).toBe(true)
    expect(isSynopsisPlaceholderDocument("# 第二章 待命名 剧情梗概\n\n")).toBe(true)
    expect(isSynopsisPlaceholderDocument("# 第二章 待命名 剧情梗概\n\n雨夜里旅人靠近无人认领的灯。\n")).toBe(false)
  })

  it("rematerializes captured disk synopsis over a placeholder file", async () => {
    await withHarness(async (harness) => {
      const synopsisPath = deriveSynopsisMarkdownPath(1, "")
      const absolute = join(harness.workspaceRootRef, synopsisPath)
      mkdirSync(dirname(absolute), { recursive: true })
      const filled = "# 第一章 待命名 剧情梗概\n\n雨夜里，旧站台尽头亮起一盏无人认领的灯。\n"
      writeFileSync(absolute, filled, "utf8")

      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createChapterSynopsisService()
      const captured = await service.captureSynopsisForRematerialize({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(captured.some((item) => item.markdown.includes("无人认领的灯"))).toBe(true)

      writeFileSync(absolute, assembleSynopsisPlaceholderDocument(1, ""), "utf8")
      const written = await service.rematerializeAfterHistoryCheckout({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        captured,
      })
      expect(written).toBeGreaterThan(0)
      expect(readFileSync(absolute, "utf8")).toContain("无人认领的灯")
    })
  }, 60_000)

  it("rematerializes from ChapterSynopsis when workspace file was archived", async () => {
    await withHarness(async (harness) => {
      const synopsisPath = deriveSynopsisMarkdownPath(1, "世界种子")
      const absolute = join(harness.workspaceRootRef, synopsisPath)
      mkdirSync(dirname(absolute), { recursive: true })
      const filled = "# 第一章 世界种子 剧情梗概\n\n穿越者初入盐雾城，尚无灵根。\n"
      writeFileSync(absolute, filled, "utf8")

      const started = await invoke<{ session: { chapterSequence: number; synopsisPath: string } }>(
        harness,
        "synopsis.conversation.start",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
        },
      )
      expect(started.session.synopsisPath).toBe(synopsisPath)

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createChapterSynopsisService()
      await service.linkAfterPublish({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: randomUUID(),
        chapterSequence: started.session.chapterSequence,
        chapterPath: "章节正文/第一章 世界种子.md",
      })
      expect(existsSync(absolute)).toBe(false)

      const captured = await service.captureSynopsisForRematerialize({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(captured.some((item) => item.markdown.includes("尚无灵根"))).toBe(true)

      writeFileSync(absolute, assembleSynopsisPlaceholderDocument(1, "世界种子"), "utf8")
      await service.rematerializeAfterHistoryCheckout({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        captured,
      })
      expect(readFileSync(absolute, "utf8")).toContain("尚无灵根")
    })
  }, 60_000)

  it("keeps filled synopsis through history.returnPreviousRound", async () => {
    await withHarness(async (harness) => {
      const synopsisPath = deriveSynopsisMarkdownPath(1, "")
      const absolute = join(harness.workspaceRootRef, synopsisPath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, assembleSynopsisPlaceholderDocument(1, ""), "utf8")

      const taskId = await ensureHistoryTask(harness)
      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      await runtime.saveAutomaticHistory({
        operationId: randomUUID(),
        name: "占位梗概快照",
        taskId,
        createdAtMs: Date.now(),
      })

      const filled = "# 第一章 待命名 剧情梗概\n\n雨夜里，旧站台尽头亮起一盏无人认领的灯。\n"
      writeFileSync(absolute, filled, "utf8")
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })

      writeFileSync(join(harness.workspaceRootRef, "设定集", "readme.md"), "# 设定集索引\n\n第二轮标记。\n", "utf8")
      await runtime.saveAutomaticHistory({
        operationId: randomUUID(),
        name: "第二轮快照",
        taskId,
        createdAtMs: Date.now() + 1,
      })
      writeFileSync(absolute, filled, "utf8")

      await invoke(harness, "history.returnPreviousRound", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        operationId: randomUUID(),
      })

      expect(existsSync(absolute)).toBe(true)
      const restored = readFileSync(absolute, "utf8")
      expect(restored).toContain("无人认领的灯")
      expect(isSynopsisPlaceholderDocument(restored)).toBe(false)
    })
  }, 60_000)
})
