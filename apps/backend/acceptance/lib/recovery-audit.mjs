export function selectLatestRestoredTask(fullChainReport, originalTaskId) {
  return (fullChainReport?.restoredTasks ?? [])
    .filter((mapping) => mapping.originalTaskId === originalTaskId)
    .at(-1)
}

export function buildCompletedRecoveryReport(mapping, baseline, completed) {
  const protectedPhases = Object.entries(baseline.completedPhaseCounts ?? {})
  const duplicatedProtectedPhases = protectedPhases.filter(([phase, count]) => completed.completedPhaseCounts[phase] !== count)
  const checks = [
    check("restored_task_completed", completed.task.status === "completed", completed.task),
    check("same_context_chain", completed.chain?.id === baseline.chain?.id, { before: baseline.chain?.id, after: completed.chain?.id }),
    check("checkpoint_prefix_preserved", completed.chain?.message_count >= (baseline.checkpoint?.model_context_sequence ?? 0) + 1, { checkpoint: baseline.checkpoint, chain: completed.chain }),
    check("completed_prefix_not_reexecuted", duplicatedProtectedPhases.length === 0, { duplicatedProtectedPhases, before: baseline.completedPhaseCounts, after: completed.completedPhaseCounts }),
    check("single_final_chapter", completed.chapterCount === 1 && completed.finalizationCount === 1, { chapterCount: completed.chapterCount, finalizationCount: completed.finalizationCount }),
    check("restored_task_recorded_usage", completed.kvCalls > 0 && completed.totalInputTokens > 0, { kvCalls: completed.kvCalls, totalInputTokens: completed.totalInputTokens, totalOutputTokens: completed.totalOutputTokens }),
  ]
  return {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    taskId: mapping.originalTaskId,
    completedTaskId: mapping.restoredTaskId,
    restoration: mapping,
    baseline,
    completed,
    checks,
  }
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}
