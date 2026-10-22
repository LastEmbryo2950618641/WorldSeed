import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"
import { PROTOCOL_VERSION, type DeductionTask } from "@worldseed/contracts"

import { deductionTaskProgress } from "../src/application/turns/deduction-task-progress.js"
import { openChapterHarness, waitForTask } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("deductionTaskProgress", () => {
  it("orders draft phases and counts completed rows", () => {
    const progress = deductionTaskProgress([
      { phase: "draft", status: "completed", attempt: 1 },
      { phase: "interpret", status: "completed", attempt: 1 },
      { phase: "rule_assembly", status: "running", attempt: 1 },
    ], false)
    expect(progress.phases.map((phase) => phase.phase)).toEqual(["interpret", "rule_assembly", "draft"])
    expect(progress.completed).toBe(2)
    expect(progress.total).toBe(6)
    expect(progress.phase).toBe("rule_assembly")
  })
})

describe("turn.list", () => {
  it("returns turn tasks newest first", async () => {
    const harness = await openChapterHarness("Deduction Task List")
    temporaryRoots.push(harness.root)
    const call = async <T>(method: string, payload: Record<string, unknown> = {}): Promise<T> => {
      const response = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method,
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          ...payload,
        },
      })
      if (!response.ok) expect.fail(JSON.stringify(response.error))
      return response.data as T
    }
    try {
      expect(await call<DeductionTask[]>("turn.list")).toEqual([])
      const first = await call<{ taskId: string }>("turn.start", {
        chapterSequence: 1,
        userInput: "先推第一章",
      })
      await waitForTask(harness.facade, first.taskId)
      const second = await call<{ taskId: string }>("turn.start", {
        chapterSequence: 1,
        userInput: "再推一次",
      })
      await waitForTask(harness.facade, second.taskId)
      const listed = await call<DeductionTask[]>("turn.list")
      expect(listed.length).toBeGreaterThanOrEqual(2)
      expect(listed[0]?.taskId).toBe(second.taskId)
      expect(listed.some((task) => task.taskId === first.taskId)).toBe(true)
      expect(listed.every((task) => task.heading.length > 0)).toBe(true)
      expect(listed.every((task) => Array.isArray(task.progress.phases))).toBe(true)
      expect(listed[0]?.status).toBe("completed")
    } finally {
      await harness.container.close()
    }
  }, 90000)
})
