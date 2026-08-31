import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"
import { ARC_PLAN_STAGING_PATH } from "../src/application/chapters/staging-entries.js"
import { formatTurnHandoffSystemMessage, truncateChapterBodyDigest } from "../src/application/chapters/turn-handoff.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Arc Continuity Test")
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

describe("arc planning continuity and handoff", () => {
  it("writes arc plan markdown when discuss requests outline-first", async () => {
    await withHarness(async (harness) => {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这段要分几章，先落大纲再写",
      })
      const arcPath = join(harness.workspaceRootRef, ARC_PLAN_STAGING_PATH)
      expect(existsSync(arcPath)).toBe(true)
      expect(readFileSync(arcPath, "utf8")).toContain("弧线规划")
    })
  })

  it("claims an existing prebuilt synopsis file instead of overwriting", async () => {
    await withHarness(async (harness) => {
      const prebuilt = "章节正文/第一章 预建航线 [剧情梗概].md"
      const absolute = join(harness.workspaceRootRef, prebuilt)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, "# 第一章 预建航线 剧情梗概\n\n预建正文不得被覆盖。\n", "utf8")

      const started = await invoke<{ session: { synopsisPath: string; title: string } }>(
        harness,
        "synopsis.conversation.start",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
        },
      )
      expect(started.session.synopsisPath).toBe(prebuilt)
      expect(started.session.title).toBe("预建航线")
      expect(readFileSync(absolute, "utf8")).toContain("预建正文不得被覆盖")
    })
  })

  it("keeps staging files after synopsis linkAfterPublish and preserves arc messages", async () => {
    await withHarness(async (harness) => {
      writeFileSync(
        join(harness.workspaceRootRef, ARC_PLAN_STAGING_PATH),
        "# 弧线规划\n\n保留我\n",
        "utf8",
      )

      const started = await invoke<{ session: { sessionId: string; chapterSequence: number; synopsisPath: string } }>(
        harness,
        "synopsis.conversation.start",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
        },
      )
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "先记下开篇",
      })
      const notesPath = join(harness.workspaceRootRef, "暂存区/本章讨论笔记.md")
      const notesAfterSend = readFileSync(notesPath, "utf8")
      expect(notesAfterSend.length).toBeGreaterThan(0)

      await invoke(harness, "synopsis.conversation.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const runtime = harness.container.getCurrentRuntime()
      expect(runtime).toBeDefined()
      await runtime!.createChapterSynopsisService().linkAfterPublish({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: "chapter-test-1",
        chapterSequence: started.session.chapterSequence,
        chapterPath: "章节正文/第一章 世界种子.md",
      })

      expect(existsSync(notesPath)).toBe(true)
      expect(readFileSync(notesPath, "utf8")).toBe(notesAfterSend)
      expect(readFileSync(join(harness.workspaceRootRef, ARC_PLAN_STAGING_PATH), "utf8")).toContain("保留我")

      const listed = await invoke<{
        session?: { chapterSequence: number }
        messages: Array<{ role: string; content: string }>
      }>(harness, "synopsis.conversation.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(listed.messages.some((message) => message.role === "user")).toBe(true)

      const next = await invoke<{
        session: { chapterSequence: number }
        messages: Array<{ role: string }>
      }>(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(next.session.chapterSequence).toBe(started.session.chapterSequence + 1)
      expect(next.messages.some((message) => message.role === "user")).toBe(true)
    })
  })

  it("records turn handoff system message and auto-analysis without beginTurn", async () => {
    await withHarness(async (harness) => {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const runtime = harness.container.getCurrentRuntime()
      expect(runtime).toBeDefined()
      await runtime!.createSynopsisConversationService().recordTurnHandoff({
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        brief: {
          taskId: "task-handoff-1",
          chapterSequence: 1,
          chapterPath: "章节正文/第一章 世界种子.md",
          chapterHeading: "第一章 世界种子",
          bodyDigest: truncateChapterBodyDigest("正文很长".repeat(100)),
          outlineNotes: ["兑现了开篇冲突"],
          createdAtMs: Date.now(),
        },
        model: new FakeAiModelAdapter(),
        runAutoAnalysis: true,
      })

      const listed = await invoke<{
        messages: Array<{ role: string; content: string; choices?: Array<{ action: string }> }>
      }>(harness, "synopsis.conversation.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(listed.messages.some((message) => (
        message.role === "system" && message.content.includes("推演完成交接")
      ))).toBe(true)
      expect(listed.messages.some((message) => (
        message.role === "assistant" && message.content.includes("不会自动开始正式推演")
      ))).toBe(true)
      const assistant = listed.messages.find((message) => message.role === "assistant")
      expect(assistant?.choices?.some((choice) => choice.action === "start_turn")).toBeFalsy()
      expect(existsSync(join(harness.workspaceRootRef, ARC_PLAN_STAGING_PATH))).toBe(true)
    })
  })

  it("formats handoff brief with truncated body", () => {
    const brief = {
      taskId: "t1",
      chapterSequence: 2,
      chapterPath: "章节正文/第二章.md",
      chapterHeading: "第二章",
      bodyDigest: truncateChapterBodyDigest("x".repeat(5_000), 100),
      outlineNotes: ["note"],
      createdAtMs: 1,
    }
    expect(brief.bodyDigest.length).toBeLessThanOrEqual(101)
    expect(formatTurnHandoffSystemMessage(brief)).toContain("第 2 章")
  })
})
