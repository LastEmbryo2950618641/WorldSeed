import { describe, expect, it } from "vitest"

import {
  buildCompletedRecoveryReport,
  selectLatestRestoredTask,
} from "../../../apps/backend/acceptance/lib/recovery-audit.mjs"

describe("recovery acceptance audit", () => {
  it("audits the latest restored task instead of requiring the archived original task to complete", () => {
    const mapping = selectLatestRestoredTask({
      restoredTasks: [
        { originalTaskId: "original", restoredTaskId: "restored-paused" },
        { originalTaskId: "other", restoredTaskId: "unrelated" },
        { originalTaskId: "original", restoredTaskId: "restored-completed" },
      ],
    }, "original")

    expect(mapping).toEqual({ originalTaskId: "original", restoredTaskId: "restored-completed" })
  })

  it("accepts completion on a restored task with the checkpoint prefix and protected phases preserved", () => {
    const baseline = evidence({
      taskId: "original",
      status: "paused",
      sequence: 12,
      messageCount: 13,
      completedPhaseCounts: { interpret: 1, draft: 1 },
      kvCalls: 3,
    })
    const completed = evidence({
      taskId: "restored",
      status: "completed",
      sequence: 20,
      messageCount: 21,
      completedPhaseCounts: { interpret: 1, draft: 1, graph_governance: 1 },
      kvCalls: 2,
      chapterCount: 1,
      finalizationCount: 1,
    })

    const report = buildCompletedRecoveryReport({
      originalTaskId: "original",
      restoredTaskId: "restored",
      historyEntryId: "history-1",
    }, baseline, completed)

    expect(report.status).toBe("pass")
    expect(report.taskId).toBe("original")
    expect(report.completedTaskId).toBe("restored")
    expect(report.checks.every((check) => check.status === "pass")).toBe(true)
  })
})

function evidence(input) {
  return {
    task: { id: input.taskId, status: input.status },
    checkpoint: {
      model_context_chain_id: "chain-1",
      model_context_sequence: input.sequence,
    },
    chainCount: 1,
    chain: { id: "chain-1", message_count: input.messageCount },
    completedPhaseCounts: input.completedPhaseCounts,
    kvCalls: input.kvCalls,
    totalInputTokens: input.kvCalls * 100,
    totalOutputTokens: input.kvCalls * 10,
    chapterCount: input.chapterCount ?? 0,
    finalizationCount: input.finalizationCount ?? 0,
  }
}
