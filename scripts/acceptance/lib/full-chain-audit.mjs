export function auditCompletedTurn(database, taskId, expectedChapterSequence, auditKv) {
  const task = database.prepare("select status from tasks where id = ? and kind = 'turn'").get(taskId)
  const finalization = database.prepare("select status, chapter_path, graph_anchor_ids_json from turn_finalizations where task_id = ?").get(taskId)
  const chapter = database.prepare("select chapter_sequence from canonical_chapter_messages where task_id = ?").get(taskId)
  const chapterMessages = database.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(taskId)?.count ?? 0
  const automaticHistory = database.prepare("select count(*) count from history_entries where task_id = ? and kind = 'automatic' and status = 'ready'").get(taskId)?.count ?? 0
  const totalChapters = database.prepare("select count(*) count from canonical_chapter_messages").get()?.count ?? 0
  const kv = auditKv(database, taskId)
  return {
    taskStatus: task?.status,
    finalizationStatus: finalization?.status,
    chapterSequence: chapter?.chapter_sequence,
    graphAnchorCount: parseArray(finalization?.graph_anchor_ids_json).length,
    chapterMessages,
    automaticHistory,
    totalChapters,
    kv,
    passed: task?.status === "completed"
      && finalization?.status === "completed"
      && chapterMessages === 1
      && chapter?.chapter_sequence === expectedChapterSequence
      && automaticHistory === 1
      && kv.passed,
  }
}

export function auditAutomaticEvolution(database, evolution, auditKv) {
  const task = database.prepare("select status, scope_id, last_phase from tasks where id = ? and kind = 'evolution'").get(evolution.taskId)
  const graphRevisionCount = task === undefined
    ? 0
    : database.prepare("select count(*) count from graph_revisions where scope_id = ?").get(task.scope_id)?.count ?? 0
  const canonicalChapterCount = database.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(evolution.taskId)?.count ?? 0
  const graphGovernanceCompleted = completedPhaseExists(database, evolution.taskId, "graph_governance_review")
  const commitReviewCompleted = completedPhaseExists(database, evolution.taskId, "commit_review")
  const kv = auditKv(database, evolution.taskId)
  return {
    taskId: evolution.taskId,
    triggerTaskId: evolution.triggerTaskId,
    status: task?.status,
    lastPhase: task?.last_phase,
    graphRevisionCount,
    canonicalChapterCount,
    graphGovernanceCompleted,
    graphGovernancePhase: "graph_governance_review",
    commitReviewCompleted,
    kv,
    passed: task?.status === "completed"
      && graphGovernanceCompleted
      && commitReviewCompleted
      && canonicalChapterCount === 0
      && kv.passed,
  }
}

export function collectTrackedIncompleteTasks(database, taskIds) {
  const uniqueTaskIds = [...new Set(taskIds)]
  if (uniqueTaskIds.length === 0) return []
  const placeholders = uniqueTaskIds.map(() => "?").join(", ")
  return database.prepare(`
    select id, kind, status from tasks
    where id in (${placeholders}) and status not in ('completed', 'cancelled')
    order by created_at, id
  `).all(...uniqueTaskIds)
}

export function auditPromptPrefix(events, taskId, phaseRunStatusByEnvelopeId) {
  const profiles = events.filter((event) => event.component === "deepseek-model"
    && event.event === "completion.prompt_profiled"
    && event.taskId === taskId)
  if (profiles.length < 2) return auditResult("byte_exact_prompt_prefix", "insufficient", { profileCount: profiles.length })
  let excludedRecoveryTransitions = 0
  const comparisons = profiles.slice(1).flatMap((current, index) => {
    const previous = profiles[index]
    if (current.previousPhase === undefined) return []
    const previousStatus = phaseRunStatusByEnvelopeId.get(previous.envelopeId)
    const currentStatus = phaseRunStatusByEnvelopeId.get(current.envelopeId)
    if (previousStatus !== "completed" || currentStatus !== "completed") {
      excludedRecoveryTransitions += 1
      return []
    }
    const previousMessageCount = Array.isArray(previous.messages) ? previous.messages.length : undefined
    return [{
      phase: current.phase,
      previousPhase: current.previousPhase,
      previousMessageCount,
      exactMessagePrefixCount: current.exactMessagePrefixCount,
      commonPrefixCharacters: current.commonPrefixCharacters,
      previousPromptCharacters: current.previousPromptCharacters,
      passed: previousMessageCount !== undefined
        && current.exactMessagePrefixCount === previousMessageCount
        && current.commonPrefixCharacters === current.previousPromptCharacters,
    }]
  })
  const status = comparisons.length === 0
    ? "insufficient"
    : comparisons.some((item) => !item.passed) ? "fail" : "pass"
  return auditResult("byte_exact_prompt_prefix", status, {
    comparisons,
    excludedRecoveryTransitions,
  })
}

export function auditPhaseCompletion(taskKind, rows) {
  const completed = new Set(rows.filter((row) => row.status === "completed").map((row) => row.phase))
  const expected = expectedPhases(taskKind)
  const missing = expected.filter((phase) => !completed.has(phase))
  const recoveredRunningAttempts = rows.filter((row) => row.status === "running" && rows.some((candidate) => (
    candidate.phase === row.phase
      && candidate.attempt > row.attempt
      && (candidate.status === "completed" || candidate.status === "superseded")
  )))
  const recoveredRunningIds = new Set(recoveredRunningAttempts.map((row) => `${row.phase}:${String(row.attempt)}`))
  const unfinished = rows.filter((row) => row.status === "running"
    && !recoveredRunningIds.has(`${row.phase}:${String(row.attempt)}`))
  const recoveredAttempts = rows.filter((row) => row.status === "failed"
    || row.status === "cancelled"
    || row.status === "superseded")
  return auditResult("all_turn_phases_completed", missing.length === 0 && unfinished.length === 0 ? "pass" : "fail", {
    missing,
    unfinished,
    recoveredAttempts,
    recoveredRunningAttempts,
    rows,
  })
}

function completedPhaseExists(database, taskId, phase) {
  return (database.prepare("select count(*) count from phase_runs where task_id = ? and phase = ? and status = 'completed'").get(taskId, phase)?.count ?? 0) > 0
}

function parseArray(value) {
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function auditResult(id, status, evidence) {
  return { id, status, evidence }
}

function expectedPhases(kind) {
  if (kind === "query") return ["interpret", "rule_assembly", "source_retrieval", "draft", "response_review"]
  if (kind === "evolution") return [
    "interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review",
    "dependency_audit", ...stagedGraphPhases, "settlement_review", "frontier_settlement", "commit_review",
  ]
  return [
    "interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review", "draft",
    "chapter_naming", "dependency_audit", ...stagedGraphPhases, "settlement_review",
    "frontier_settlement", "commit_review",
  ]
}

const stagedGraphPhases = [
  "graph_structure_plan",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
]
