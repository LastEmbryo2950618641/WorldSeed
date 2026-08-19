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

export function auditTemporalContinuityCoverage(database, taskId) {
  const dependency = readLatestArtifact(database, taskId, "dependency_audit")
  const settlement = readLatestArtifact(database, taskId, "graph_spacetime_settlement")
  const review = readLatestArtifact(database, taskId, "graph_governance_review")
  const commit = readLatestArtifact(database, taskId, "commit_review")
  const claimRefs = readClaimRefs(dependency?.temporalClaims)
  const settlementClaimRefs = readClaimRefs(settlement?.temporalClaimSettlements)
  const assessmentClaimRefs = readClaimRefs(review?.temporalClaimAssessments)
  const adviceClaimRefs = readClaimRefs(commit?.continuityAdvice)
  const phasesPresent = [dependency, settlement, review, commit].every((artifact) => artifact !== undefined)
  const passed = phasesPresent
    && exactUniqueCoverage(claimRefs, settlementClaimRefs)
    && exactUniqueCoverage(claimRefs, assessmentClaimRefs)
    && exactUniqueCoverage(claimRefs, adviceClaimRefs)
  return {
    passed,
    claimRefs,
    settlementClaimRefs,
    assessmentClaimRefs,
    adviceClaimRefs,
    advisoryConflictCount: Array.isArray(commit?.continuityAdvice)
      ? commit.continuityAdvice.filter((advice) => advice?.verdict === "conflict").length
      : 0,
    commitRecommendation: commit?.recommendation,
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

function readLatestArtifact(database, taskId, phase) {
  const row = database.prepare(`
    select result_json from phase_runs
    where task_id = ? and phase = ? and status = 'completed'
    order by attempt desc, started_at desc, id desc
    limit 1
  `).get(taskId, phase)
  if (typeof row?.result_json !== "string") return undefined
  try {
    const parsed = JSON.parse(row.result_json)
    return typeof parsed?.artifact === "object" && parsed.artifact !== null ? parsed.artifact : undefined
  } catch {
    return undefined
  }
}

function readClaimRefs(items) {
  return Array.isArray(items)
    ? items.map((item) => item?.claimRef).filter((claimRef) => typeof claimRef === "string")
    : []
}

function exactUniqueCoverage(expected, actual) {
  return new Set(expected).size === expected.length
    && new Set(actual).size === actual.length
    && arraysEqual([...expected].sort(), [...actual].sort())
}

function uniqueSortedIndexes(indexes) {
  return [...new Set(indexes.filter((index) => Number.isInteger(index)))].sort((left, right) => left - right)
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
