import { describe, expect, it } from "vitest"

import {
  alignTodosForChapterSequenceGate,
  alignTodosForToolExclusiveGate,
  discussChapterSequenceGateHint,
  DISCUSS_TODO_INCOMPLETE_HINT,
  DISCUSS_TODO_REQUIRED_HINT,
  discussArtifactRequiresTodos,
  discussTodosAreSettled,
  discussTurnHasTodos,
  isDiscussTodoBootstrapTool,
  isPrecedingChapterPublishGateError,
  partitionChapterDraftSequences,
  settleToolGateTodos,
} from "../src/application/chapters/synopsis-todo-gate.js"

describe("synopsis todo gate", () => {
  it("only allows todo_write before a list exists", () => {
    expect(isDiscussTodoBootstrapTool("todo_write")).toBe(true)
    expect(isDiscussTodoBootstrapTool("bash")).toBe(false)
    expect(discussTurnHasTodos([])).toBe(false)
    expect(discussTurnHasTodos([{ id: "1", content: "读本机目录", status: "in_progress" }])).toBe(true)
    expect(DISCUSS_TODO_REQUIRED_HINT).toContain("todo_write")
  })

  it("requires open todos to be settled before ending Auto/Accept turns", () => {
    expect(discussTodosAreSettled([])).toBe(true)
    expect(discussTodosAreSettled([
      { id: "1", content: "读", status: "completed" },
      { id: "2", content: "写", status: "cancelled" },
    ])).toBe(true)
    expect(discussTodosAreSettled([
      { id: "1", content: "读", status: "completed" },
      { id: "2", content: "写", status: "pending" },
    ])).toBe(false)
    expect(discussTodosAreSettled([
      { id: "1", content: "读", status: "in_progress" },
    ])).toBe(false)
    expect(DISCUSS_TODO_INCOMPLETE_HINT).toContain("不能结束回合")
  })

  it("treats write artifacts as requiring todos", () => {
    expect(discussArtifactRequiresTodos({})).toBe(false)
    expect(discussArtifactRequiresTodos({ synopsisBody: "# x" })).toBe(true)
    expect(discussArtifactRequiresTodos({
      toolRequest: { name: "bash", action: "describe" },
    })).toBe(true)
  })

  it("aligns todos when tool-exclusive gate defers writes", () => {
    const aligned = alignTodosForToolExclusiveGate([
      { id: "1", content: "读本机目录", status: "completed" },
      { id: "2", content: "写入第三章梗概", status: "in_progress" },
      { id: "3", content: "调整焦点到第三章", status: "pending" },
    ], ["synopsisBody", "focusChange"])
    expect(aligned.find((item) => item.id === "2")?.status).toBe("pending")
    expect(aligned.find((item) => item.id === "3")?.status).toBe("pending")
    const inProgress = aligned.filter((item) => item.status === "in_progress")
    expect(inProgress).toHaveLength(1)
    expect(inProgress[0]?.content).toMatch(/工具/)
    expect(aligned.some((item) => item.content.includes("延后交付"))).toBe(true)
  })

  it("treats preceding-publish failures as a process gate", () => {
    expect(isPrecedingChapterPublishGateError(
      new Error("Publish the preceding chapter before drafting the next chapter"),
    )).toBe(true)
    expect(partitionChapterDraftSequences([1, 2, 5], 2, new Set([1]))).toEqual({
      allowed: [1, 2],
      deferred: [5],
    })
    const aligned = alignTodosForChapterSequenceGate([
      { id: "1", content: "写入第2章草稿", status: "completed" },
      { id: "2", content: "写入第5章草稿", status: "in_progress" },
    ], 2, [3, 4, 5])
    expect(aligned.find((item) => item.id === "2")?.status).toBe("pending")
    expect(aligned.some((item) => item.status === "in_progress" && item.content.includes("第2章"))).toBe(true)
    expect(discussChapterSequenceGateHint(2, [5])).toContain("第2章")
  })

  it("settles the gate-tool step after a tool ran and promotes real work", () => {
    const settled = settleToolGateTodos([
      { id: "gate-tool", content: "先单独调用工具并等待结果", status: "in_progress" },
      { id: "a", content: "第五章补草稿并发布", status: "pending" },
      { id: "gate-deferred-5", content: "延后交付：choices", status: "pending" },
    ])
    expect(settled?.find((item) => item.id === "gate-tool")?.status).toBe("completed")
    expect(settled?.find((item) => item.id === "a")?.status).toBe("in_progress")
    expect(settleToolGateTodos([{ id: "a", content: "x", status: "pending" }])).toBeUndefined()
  })
})
