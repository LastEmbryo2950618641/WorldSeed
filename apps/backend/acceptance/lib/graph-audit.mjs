export function auditVerificationProbeCoverage(database, taskId) {
  const probeRows = database.prepare(`
    select probes.probe_index
    from verification_probe_executions probes
    join phase_runs runs on runs.id = probes.phase_run_id
    where probes.task_id = ? and runs.status = 'completed'
    order by probes.probe_index
  `).all(taskId)
  const probeIndexes = uniqueSortedIndexes(probeRows.map((row) => row.probe_index))
  const review = database.prepare(`
    select id, result_json
    from phase_runs
    where task_id = ? and phase = 'graph_governance_review' and status = 'completed'
    order by attempt desc, started_at desc, id desc
    limit 1
  `).get(taskId)
  const assessments = readAssessments(review?.result_json)
  const assessmentIndexes = assessments.map((assessment) => assessment?.probeIndex)
    .filter((probeIndex) => Number.isInteger(probeIndex))
  const uniqueAssessmentIndexes = uniqueSortedIndexes(assessmentIndexes)
  const exactCoverage = probeIndexes.length > 0
    && assessmentIndexes.length === assessments.length
    && uniqueAssessmentIndexes.length === assessmentIndexes.length
    && arraysEqual(probeIndexes, uniqueAssessmentIndexes)

  return {
    passed: exactCoverage,
    reviewPhaseRunId: review?.id,
    probeIndexes,
    assessmentIndexes,
  }
}

function readAssessments(resultJson) {
  if (typeof resultJson !== "string") return []
  try {
    const parsed = JSON.parse(resultJson)
    return Array.isArray(parsed?.artifact?.verificationProbeAssessments)
      ? parsed.artifact.verificationProbeAssessments
      : []
  } catch {
    return []
  }
}

function uniqueSortedIndexes(indexes) {
  return [...new Set(indexes.filter((index) => Number.isInteger(index)))].sort((left, right) => left - right)
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
