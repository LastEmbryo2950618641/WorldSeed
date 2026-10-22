import { describe, expect, it } from "vitest"

import {
  buildInterruptedAssistantMessageFields,
  streamHasVisibleProgress,
} from "../src/application/chapters/synopsis-interrupted-turn.js"

describe("synopsis interrupted turn", () => {
  it("detects visible stream progress from tools or thinking", () => {
    expect(streamHasVisibleProgress({
      thinking: "",
      thinkingRounds: [],
      content: "",
      searching: [],
      editing: [],
      toolRuns: [],
      todos: [],
    })).toBe(false)
    expect(streamHasVisibleProgress({
      thinking: "先列步骤",
      thinkingRounds: [],
      content: "",
      searching: [],
      editing: [],
      toolRuns: [],
      todos: [],
    })).toBe(true)
    expect(streamHasVisibleProgress({
      thinking: "",
      thinkingRounds: [],
      content: "",
      searching: [],
      editing: [],
      toolRuns: [{
        runId: "r1",
        name: "todo_write",
        action: "describe",
        status: "completed",
      }],
      todos: [],
    })).toBe(true)
  })

  it("builds an interrupted assistant payload with error marker", () => {
    const fields = buildInterruptedAssistantMessageFields({
      status: "failed",
      thinking: "准备写 Todo",
      thinkingRounds: [{ round: 1, text: "准备写 Todo" }],
      content: "先创建本轮任务清单。",
      searching: [],
      editing: [],
      toolRuns: [],
      todos: [{ id: "1", content: "建清单", status: "in_progress" }],
      error: "boom",
      updatedAtMs: 1,
    }, "模型调用失败")
    expect(fields.content).toContain("先创建本轮任务清单")
    expect(fields.error).toBe("模型调用失败")
    expect(fields.todos?.[0]?.id).toBe("1")
    expect(fields.thinkingRounds?.[0]?.text).toContain("Todo")
  })
})
