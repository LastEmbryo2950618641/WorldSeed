import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION, type BackendMethod, type GraphRevisionTask } from "@worldseed/contracts"
import { graphRevisionProgress } from "../src/application/chapters/graph-revision-progress.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"
import { NodeWorkspaceAdapter } from "../src/infrastructure/filesystem/node-workspace-adapter.js"
import { openChapterHarness, seedCommittedChapter } from "./helpers/chapter-coordination-harness.js"

describe("graph revision progress", () => {
  it("does not invent a total while routing and counts retries only once", () => {
    expect(graphRevisionProgress([{ phase: "graph_governance", status: "running", attempt: 1 }], false).total).toBeNull()
    const progress = graphRevisionProgress([
      { phase: "graph_governance", status: "completed", attempt: 1 },
      { phase: "dependency_audit", status: "failed", attempt: 1 },
      { phase: "dependency_audit", status: "running", attempt: 2 },
    ], false)
    expect(progress).toMatchObject({ completed: 1, total: 6, phase: "dependency_audit" })
    expect(progress.phases).toHaveLength(2)
    expect(graphRevisionProgress([{ phase: "graph_governance", status: "completed", attempt: 1 }], true)).toMatchObject({ completed: 1, total: 1 })
  })
  it("includes the initial routing call when the full route is selected", () => {
    expect(graphRevisionProgress([
      { phase: "graph_governance", status: "completed", attempt: 1 },
      { phase: "interpret", status: "running", attempt: 1 },
    ], false)).toMatchObject({ completed: 0, total: 6, phase: "graph_governance" })
  })

  it("folds technical graph phases into six user-facing stages", () => {
    expect(graphRevisionProgress([
      { phase: "graph_governance", status: "completed", attempt: 1 },
      { phase: "dependency_audit", status: "completed", attempt: 1 },
      { phase: "graph_structure_plan", status: "completed", attempt: 1 },
      { phase: "graph_capacity_rewrite", status: "completed", attempt: 1 },
      { phase: "graph_spacetime_settlement", status: "running", attempt: 1 },
    ], false)).toMatchObject({
      completed: 2,
      total: 6,
      phase: "graph_structure_plan",
      phases: [
        { phase: "graph_governance", status: "completed" },
        { phase: "dependency_audit", status: "completed" },
        { phase: "graph_structure_plan", status: "running" },
      ],
    })
  })
})

describe("graph revision task operations", () => {
  it("lists lightweight progress, aborts a live request, and retries without publishing the chapter twice", async () => {
    const fake = new FakeAiModelAdapter()
    let hold = false
    let entered = false
    let aborted = false
    let revisionCalls = 0
    const harness = await openChapterHarness("Graph revision tasks", { model: {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase === "graph_governance") {
          revisionCalls++
          if (hold) {
            entered = true
            options?.onSchemaRepair?.()
            options?.onPartial?.({ reasoningDelta: "Reviewing graph" })
            await new Promise<void>((_resolve, reject) => {
              const abort = (): void => { aborted = true; reject(new Error("fixture cancelled")) }
              if (options?.signal?.aborted) abort()
              else options?.signal?.addEventListener("abort", abort, { once: true })
            })
          }
        }
        return fake.execute(request, options)
      },
    } })
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      const chapter = await seedCommittedChapter(harness)
      expect(await call("chapter.graphRevision.list")).toEqual([])
      const revision = await call<{ revisionTaskId: string }>("chapter.startRevision", {
        chapterId: chapter.chapterId, baseSourceId: chapter.sourceId, heading: chapter.heading, body: `${chapter.body}\n\nA new detail.`,
      })
      hold = true
      await call("chapter.submitRevision", { ...revision, mode: "direct", forced: true })
      await expect.poll(() => entered).toBe(true)
      const before = await call<{ sourceId: string; body: string }>("chapter.read", { chapterId: chapter.chapterId })
      const tasks = await call<GraphRevisionTask[]>("chapter.graphRevision.list")
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ status: "running", canCancel: true, canRetry: false, blocksTurn: true })
      expect(JSON.stringify(tasks)).not.toContain("A new detail.")
      expect(tasks[0]?.progress.phase).toBe("graph_governance")
      expect(tasks[0]?.activity).toMatchObject({ phase: "graph_governance", stage: "thinking", attempt: 2, reasoningCharacters: 15 })
      await call("chapter.graphRevision.cancel", revision)
      expect(aborted).toBe(true)
      expect((await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]).toMatchObject({ status: "cancelled", canCancel: false, canRetry: true, blocksTurn: true })
      await harness.container.getCurrentRuntime()?.close()
      expect((await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]).toMatchObject({ status: "cancelled", canRetry: true })
      hold = false
      await Promise.all([call("chapter.graphRevision.retry", revision), call("chapter.graphRevision.retry", revision)])
      await expect.poll(async () => (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]?.status, { timeout: 15000 }).toBe("completed")
      expect(revisionCalls).toBe(2)
      const after = await call<{ sourceId: string; body: string }>("chapter.read", { chapterId: chapter.chapterId })
      expect(after).toMatchObject({ sourceId: before.sourceId, body: before.body })
      expect((await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]).toMatchObject({ canCancel: false, canRetry: false, blocksTurn: false })
    } finally {
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30000)

  it("rejects an existing file conflict before committing content or blocking later turns", async () => {
    const harness = await openChapterHarness("Revision preflight")
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      const chapter = await seedCommittedChapter(harness)
      const original = await call<{ sourceId: string; publishPath: string; body: string }>("chapter.read", { chapterId: chapter.chapterId })
      const conflictPath = join(harness.workspaceRootRef, dirname(original.publishPath), "第一章 Conflicting.md")
      writeFileSync(conflictPath, "Independent content", "utf8")
      const revision = await call<{ revisionTaskId: string }>("chapter.startRevision", {
        chapterId: chapter.chapterId, baseSourceId: chapter.sourceId, heading: "第一章 Conflicting", body: `${chapter.body}\n\nNew content.`,
      })
      await expect(call("chapter.submitRevision", { ...revision, mode: "direct", forced: true })).rejects.toThrow("conflicts with an existing file")
      expect(await call("chapter.read", { chapterId: chapter.chapterId })).toMatchObject(original)
      expect(await call("chapter.readRevision", revision)).toMatchObject({ decision: "pending", status: "editing" })
      expect(await call("chapter.graphRevision.list")).toEqual([])
      expect(readFileSync(conflictPath, "utf8")).toBe("Independent content")
      unlinkSync(conflictPath)
      await call("chapter.submitRevision", { ...revision, mode: "direct", forced: true })
      await expect.poll(async () => (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]?.status, { timeout: 15000 }).toBe("completed")
    } finally {
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30000)

  it("keeps a conflict introduced after preflight visible and recovers without duplicating committed content", async () => {
    const harness = await openChapterHarness("Graph revision conflict")
    const originalValidate = NodeWorkspaceAdapter.prototype.validatePublishedChapterReplacement.bind(new NodeWorkspaceAdapter())
    const validation = vi.spyOn(NodeWorkspaceAdapter.prototype, "validatePublishedChapterReplacement")
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      const chapter = await seedCommittedChapter(harness)
      const original = await call<{ publishPath: string }>("chapter.read", { chapterId: chapter.chapterId })
      const conflictPath = join(harness.workspaceRootRef, dirname(original.publishPath), "第一章 Conflicting.md")
      validation.mockImplementationOnce(async (...args) => {
        await originalValidate(...args)
        writeFileSync(conflictPath, "Existing different content", "utf8")
      })
      const revision = await call<{ revisionTaskId: string }>("chapter.startRevision", {
        chapterId: chapter.chapterId, baseSourceId: chapter.sourceId, heading: "第一章 Conflicting", body: `${chapter.body}\n\nNew content.`,
      })
      await expect(call("chapter.submitRevision", { ...revision, mode: "direct", forced: true })).rejects.toThrow("conflicts with an existing file")
      await expect.poll(async () => (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]?.canRetry).toBe(true)
      const committed = await call<{ sourceId: string }>("chapter.read", { chapterId: chapter.chapterId })
      await expect(call("chapter.graphRevision.retry", revision)).rejects.toThrow("conflicts with an existing file")
      await expect.poll(async () => (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]?.canRetry).toBe(true)
      const stopped = (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]
      expect(stopped).toMatchObject({ status: "interrupted", canCancel: false, blocksTurn: true })
      expect(stopped?.error).toContain("conflicts with an existing file")
      await harness.container.getCurrentRuntime()?.close()
      const persisted = await call<GraphRevisionTask[]>("chapter.graphRevision.list")
      expect(persisted[0]?.error).toContain("conflicts with an existing file")
      unlinkSync(conflictPath)
      renameSync(join(harness.workspaceRootRef, original.publishPath), conflictPath)
      await call("chapter.graphRevision.retry", revision)
      await expect.poll(async () => (await call<GraphRevisionTask[]>("chapter.graphRevision.list"))[0]?.status, { timeout: 15000 }).toBe("completed")
      expect((await call<{ sourceId: string }>("chapter.read", { chapterId: chapter.chapterId })).sourceId).toBe(committed.sourceId)
    } finally {
      validation.mockRestore()
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30000)
})
