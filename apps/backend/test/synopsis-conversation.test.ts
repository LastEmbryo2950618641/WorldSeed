import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import { openChapterHarness, waitForTask, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Synopsis Conversation Test")
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

describe("synopsis conversation", () => {
  it("starts a session and creates synopsis placeholder markdown", async () => {
    await withHarness(async (harness) => {
      const started = await invoke<{ session: { synopsisPath: string; chapterSequence: number }; messages: unknown[] }>(
        harness,
        "synopsis.conversation.start",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          title: "雾港站的末班车",
        },
      )
      expect(started.messages).toEqual([])
      expect(started.session.synopsisPath).toContain("[剧情梗概].md")
      const file = readFileSync(join(harness.workspaceRootRef, started.session.synopsisPath), "utf8")
      expect(file).toContain("剧情梗概")
    })
  })

  it("persists messages and renames synopsis file when agent sets chapter title", async () => {
    await withHarness(async (harness) => {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const sent = await invoke<{
        session: { synopsisPath: string; title: string }
        messages: Array<{ role: string; content: string; choices?: unknown[] }>
      }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这一章从雨夜站台开始",
      })
      expect(sent.session.synopsisPath).toBe("章节正文/第一卷 待命名/第一章 世界种子 [剧情梗概].md")
      expect(sent.session.title).toBe("世界种子")
      expect(sent.messages.filter((message) => message.role === "assistant")).toHaveLength(1)
      const file = readFileSync(join(harness.workspaceRootRef, sent.session.synopsisPath), "utf8")
      expect(file).toContain("雨夜站台")
    })
  })

  it("persists messages and overwrites synopsis file on send", async () => {
    await withHarness(async (harness) => {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        title: "开端",
      })
      const sent = await invoke<{
        session: { synopsisPath: string }
        messages: Array<{ role: string; content: string; choices?: unknown[] }>
      }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这一章从雨夜站台开始",
      })
      expect(sent.messages.filter((message) => message.role === "user")).toHaveLength(1)
      expect(sent.messages.filter((message) => message.role === "assistant")).toHaveLength(1)
      expect(sent.messages[1]?.choices?.length ?? 0).toBeGreaterThan(0)
      const file = readFileSync(join(harness.workspaceRootRef, sent.session.synopsisPath), "utf8")
      expect(file).toContain("雨夜站台")
    })
  })

  it("refreshChoices appends hidden context and merges new chips onto the visible message", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      const sent = await invoke<{
        messages: Array<{
          messageId: string
          role: string
          hidden?: boolean
          choices?: Array<{ label: string }>
        }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "这一章从雨夜站台开始",
      })
      const visibleAssistant = sent.messages.find((message) => message.role === "assistant" && message.hidden !== true)
      expect(visibleAssistant?.choices?.length ?? 0).toBeGreaterThan(0)
      const beforeLabels = new Set((visibleAssistant?.choices ?? []).map((choice) => choice.label))
      const refreshed = await invoke<{
        messages: Array<{
          messageId: string
          role: string
          hidden?: boolean
          choices?: Array<{ label: string }>
        }>
      }>(harness, "synopsis.conversation.refreshChoices", {
        ...base,
        messageId: visibleAssistant!.messageId,
      })
      const hidden = refreshed.messages.filter((message) => message.hidden === true)
      expect(hidden.length).toBeGreaterThanOrEqual(2)
      expect(hidden.some((message) => message.role === "user")).toBe(true)
      expect(hidden.some((message) => message.role === "assistant")).toBe(true)
      const updated = refreshed.messages.find((message) => message.messageId === visibleAssistant!.messageId)
      expect((updated?.choices?.length ?? 0)).toBeGreaterThanOrEqual(beforeLabels.size)
      const visibleCount = refreshed.messages.filter((message) => message.hidden !== true).length
      expect(visibleCount).toBe(2)
    })
  })

  it("persists agent goal proposals from synopsis send without applying them", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      const created = await invoke<{ goals: Array<{ goalId: string }> }>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清雾港站夜班名单来源",
      })
      const goalId = created.goals[0]!.goalId
      const sent = await invoke<{
        pendingProposals?: Array<{ kind: string; payload: { kind: string; goalId?: string } }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "这一章从雨夜站台开始，林序要拿到登记簿",
      })
      expect(sent.pendingProposals?.length ?? 0).toBeGreaterThan(0)
      expect(sent.pendingProposals?.[0]?.kind).toBe("set_chapter_progress")
      expect(sent.pendingProposals?.[0]?.payload.goalId).toBe(goalId)

      const snapshot = await invoke<{
        goals: unknown[]
        progress: unknown[]
        pendingProposals: unknown[]
      }>(harness, "deduction.goals.list", base)
      expect(snapshot.goals).toHaveLength(1)
      expect(snapshot.progress).toHaveLength(0)
      expect(snapshot.pendingProposals.length).toBeGreaterThan(0)
    })
  })

  it("resolves turn input from synopsis file before conversation", async () => {
    await withHarness(async (harness) => {
      const started = await invoke<{ session: { sessionId: string; synopsisPath: string } }>(
        harness,
        "synopsis.conversation.start",
        { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef },
      )
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "先讨论一下",
      })
      const resolved = await invoke<{
        userInput: string
        source: string
        deductionGoalBundle?: { activeGoals: unknown[] }
        reconcile?: { warnings: unknown[]; blocking: unknown[] }
      }>(
        harness,
        "synopsis.conversation.resolveTurnInput",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          sessionId: started.session.sessionId,
        },
      )
      expect(resolved.source).toBe("synopsis_file")
      expect(resolved.userInput.length).toBeGreaterThan(0)
      expect(resolved.deductionGoalBundle).toBeDefined()
      expect(resolved.reconcile).toBeDefined()
    })
  })

  it("beginTurn locks planned progress and starts a turn with goal bundle", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      await invoke(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台，林序追查名单",
      })
      const created = await invoke<{ goals: Array<{ goalId: string }> }>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清雾港站夜班名单来源",
      })
      const goalId = created.goals[0]!.goalId
      await invoke(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "planned",
      })

      const begun = await invoke<{ taskId: string }>(harness, "synopsis.conversation.beginTurn", {
        ...base,
        acknowledgeWarnings: true,
      })
      expect(begun.taskId).toMatch(/^[0-9a-f-]{36}$/iu)

      const snapshot = await invoke<{
        progress: Array<{ goalId: string; lockedAtMs?: number; summary: string }>
      }>(harness, "deduction.goals.list", base)
      const locked = snapshot.progress.find((item) => item.goalId === goalId)
      expect(locked?.summary).toBe("获得登记簿副本")
      expect(locked?.lockedAtMs).toBeTypeOf("number")

      await waitForTask(harness.facade, begun.taskId)
    })
  })

  it("reviews beginTurn-locked planned progress via progress.set after turn completes", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      await invoke(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台，林序追查名单",
      })
      const created = await invoke<{ goals: Array<{ goalId: string }> }>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清雾港站夜班名单来源",
      })
      const goalId = created.goals[0]!.goalId
      await invoke(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "planned",
      })

      const begun = await invoke<{ taskId: string }>(harness, "synopsis.conversation.beginTurn", {
        ...base,
        acknowledgeWarnings: true,
      })
      await waitForTask(harness.facade, begun.taskId)

      const reviewed = await invoke<{
        progress: Array<{ goalId: string; status: string; source: string; lockedAtMs?: number }>
      }>(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "achieved",
      })
      const current = reviewed.progress.find((item) => item.goalId === goalId && item.status !== "superseded")
      expect(current?.status).toBe("achieved")
      expect(current?.source).toBe("turn_review")
      expect(current?.lockedAtMs).toBeUndefined()
    })
  })

  it("beginTurn blocks when synopsis clearly conflicts with locked goal progress", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", {
        ...base,
        title: "无关天气",
      })
      // Overwrite synopsis with content that shares no tokens with the goal constraint.
      const listed = await invoke<{ session: { synopsisPath: string } }>(harness, "synopsis.conversation.list", base)
      await invoke(harness, "workspace.save", {
        ...base,
        relativePath: listed.session.synopsisPath,
        content: "# 第一章 无关天气 剧情梗概\n\n只写晴空与海鸥，完全不提人物行动。\n",
      })
      const created = await invoke<{ goals: Array<{ goalId: string }> }>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清雾港站夜班名单来源",
      })
      await invoke(harness, "deduction.goals.progress.set", {
        ...base,
        goalId: created.goals[0]!.goalId,
        chapterSequence: 1,
        summary: "禁止出现名单追查",
        status: "planned",
      })

      const response = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "synopsis.conversation.beginTurn",
        payload: base,
      })
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.message).toContain("冲突")
    })
  })

  it("runs a request_read round before finalizing synopsis discuss", async () => {
    await withHarness(async (harness) => {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const sent = await invoke<{
        messages: Array<{
          role: string
          content: string
          searching?: Array<{ query: string; status: string }>
        }>
      }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这一章从雨夜站台开始",
      })
      const assistant = sent.messages.find((message) => message.role === "assistant")
      expect(assistant?.content).toContain("设定集索引")
      expect(assistant?.searching?.some((item) => (
        item.query.includes("reference") || item.query.includes("设定集")
      ))).toBe(true)
    })
  }, 20_000)
})
