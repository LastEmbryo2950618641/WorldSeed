import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PROTOCOL_VERSION, type BackendMethod, type RevisionDraftVersion, type ChapterRevisionReadResult } from "@worldseed/contracts"
import type { AIModelPort } from "../src/application/turns/ports/ai-model-port.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"
import { openChapterHarness, waitForTask, waitForRevisionGraphSync } from "./helpers/chapter-coordination-harness.js"

describe("workflow drafts and publication", () => {
  it("persists manual edits to the selected current draft and refuses stale version writes", async () => {
    const harness = await openChapterHarness()
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      const first = await call<RevisionDraftVersion>("chapter.draft.start", { chapterSequence: 1, heading: "第一章 草稿", body: "First", source: "workflow" })
      await call("chapter.updateRevision", { revisionTaskId: first.revisionTaskId, draftVersionId: first.versionId, heading: first.heading, body: "Edited" })
      expect(await call("chapter.revision.draftVersion.read", { versionId: first.versionId })).toMatchObject({ body: "Edited", source: "manual" })
      const second = await call<RevisionDraftVersion>("chapter.draft.start", { chapterSequence: 1, heading: first.heading, body: "Second", source: "agent" })
      await expect(call("chapter.updateRevision", { revisionTaskId: first.revisionTaskId, draftVersionId: first.versionId, heading: first.heading, body: "Stale overwrite" })).rejects.toThrow("current working draft")
      expect(await call("chapter.readRevision", { revisionTaskId: second.revisionTaskId })).toMatchObject({ proposedBody: "Second" })
      expect(await call("chapter.list")).toEqual([])
    } finally {
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true })
    }
  })

  it("keeps repeated focused runs as separate drafts and restores their results after reopening", async () => {
    const harness = await openChapterHarness()
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      const taskIds: string[] = []
      for (let index = 0; index < 2; index += 1) {
        const started = await call<{ taskId: string }>("turn.start", { chapterSequence: 1, userInput: "Write this chapter" })
        taskIds.push(started.taskId)
        await waitForTask(harness.facade, started.taskId)
      }
      expect(await call("chapter.list")).toEqual([])
      const drafts = await call<ChapterRevisionReadResult[]>("chapter.draft.list")
      expect(drafts).toHaveLength(1)
      const draft = drafts[0]!
      expect(existsSync(join(harness.workspaceRootRef, draft.publishPath!))).toBe(false)
      const listed = await call<{ versions: RevisionDraftVersion[] }>("chapter.revision.draftVersion.list", { revisionTaskId: draft.revisionTaskId })
      expect(listed.versions.map((version) => [version.label, version.source])).toEqual([["v1", "workflow"], ["v2", "workflow"]])
      await expect(call("turn.start", { chapterSequence: 2, userInput: "skip" })).rejects.toThrow("前一章")
      await harness.container.getCurrentRuntime()!.close()
      const latest = await call<{ result: { kind: string; revisionTaskId: string }; phaseRuns: { phase: string }[] }>("turn.latest.get", { chapterSequence: 1 })
      expect(latest.result).toMatchObject({ kind: "draft", revisionTaskId: draft.revisionTaskId })
      expect(latest.phaseRuns.some((run) => run.phase.startsWith("graph"))).toBe(false)
      expect(await call("turn.latest.get", { chapterSequence: 2 })).toBeNull()
    } finally {
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true })
    }
  }, 30000)

  it("lets discussion discover, repeatedly invoke, and publish an exact draft only after graph revision", async () => {
    const fake = new FakeAiModelAdapter(randomUUID)
    let discussCalls = 0
    let graphCalls = 0
    let releaseGraph!: () => void
    const graphGate = new Promise<void>((resolve) => { releaseGraph = resolve })
    let firstDraft: { revisionTaskId: string; draftVersionId: string; body: string } | undefined
    const model: AIModelPort = {
      info: fake.info,
      execute: async (request, options) => {
        if (request.phase.startsWith("graph")) {
          graphCalls += 1
          await graphGate
        }
        const execution = await fake.execute(request, options)
        if (request.phase !== "synopsis_discuss") return execution
        discussCalls += 1
        const results = (options?.contextMessages ?? []).flatMap((message) => {
          try { return [JSON.parse(message.content) as Record<string, unknown>] } catch { return [] }
        })
        if (discussCalls === 3) {
          expect(graphCalls).toBe(0)
          firstDraft = results.find((item) => item.status === "draft_created")?.result as typeof firstDraft
          expect(firstDraft).toBeDefined()
        }
        const toolRequest = discussCalls === 1 ? { name: "chapter_workflow", action: "describe" }
          : discussCalls === 2 || discussCalls === 3 ? { name: "chapter_workflow", action: "invoke", arguments: JSON.stringify({ userInput: `draft ${String(discussCalls)}` }) }
          : discussCalls === 4 ? { name: "publish_draft", action: "describe" }
          : discussCalls === 5 ? { name: "publish_draft", action: "invoke", arguments: JSON.stringify({ revisionTaskId: firstDraft!.revisionTaskId, draftVersionId: firstDraft!.draftVersionId }) }
          : undefined
        return { usage: execution.usage, result: { ...execution.result, outcome: "continue", requestedReads: [],
          artifact: { assistantMessage: "Done", finalSelfReview: "OK", ...(toolRequest === undefined ? {} : { toolRequest }) } } }
      },
    }
    const harness = await openChapterHarness("Workflow discussion", { model })
    const call = async <T>(method: BackendMethod, payload = {}): Promise<T> => {
      const response = await harness.facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
        payload: { projectId: harness.projectId, workspaceRootRef: harness.workspaceRootRef, ...payload } })
      if (!response.ok) throw new Error(response.error.message)
      return response.data as T
    }
    try {
      await call("synopsis.conversation.start")
      await call("synopsis.conversation.send", { message: "Draft twice and publish the first version", maxModelCalls: 40 })
      expect(discussCalls).toBe(6)
      expect(await call("chapter.list")).toEqual([])
      const pending = await call<ChapterRevisionReadResult>("chapter.readRevision", { revisionTaskId: firstDraft!.revisionTaskId })
      expect(pending.proposedBody).toBe(firstDraft!.body)
      expect(pending.graphSyncStatus).not.toBe("completed")
      expect(existsSync(join(harness.workspaceRootRef, pending.publishPath!))).toBe(false)
      await expect(call("synopsis.conversation.setFocus", { chapterSequence: 2 })).rejects.toThrow()
      releaseGraph()
      await waitForRevisionGraphSync(harness.facade, harness.projectId, harness.workspaceRootRef, pending.revisionTaskId)
      const published = await call<{ body: string }>("chapter.read", { chapterId: pending.chapterId })
      expect(published.body).toBe(firstDraft!.body)
      expect(await call("chapter.draft.list")).toEqual([])
      expect(graphCalls).toBeGreaterThan(0)
      expect(await call("synopsis.conversation.setFocus", { chapterSequence: 2 })).toMatchObject({ session: { chapterSequence: 2 } })
    } finally {
      releaseGraph()
      await harness.container.close()
      await rm(harness.root, { recursive: true, force: true })
    }
  }, 30000)
})
