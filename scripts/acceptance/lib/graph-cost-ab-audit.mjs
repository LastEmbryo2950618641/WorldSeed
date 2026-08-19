export function auditGraphCostPairs(reports, options = {}) {
  const minimumPairs = options.minimumPairs ?? 3
  const grouped = new Map()
  for (const report of reports) {
    grouped.set(report.pairId, [...(grouped.get(report.pairId) ?? []), report])
  }
  const auditedPairs = [...grouped.entries()].map(([pairId, pairReports]) => auditPair(pairId, pairReports))
  const validPairs = auditedPairs.filter((pair) => pair.status === "pass")
  const pairSummaries = auditedPairs.map(pairSummary)
  const invalidPairs = pairSummaries.filter((pair) => pair.status === "fail")
  const medians = buildMedians(validPairs)
  const aggregateChecks = [
    aggregateCheck("minimum_valid_pairs", validPairs.length >= minimumPairs, { minimumPairs, validPairCount: validPairs.length }),
    aggregateCheck("total_input_tokens_decreased", medians.totalInputTokens.optimized < medians.totalInputTokens.baseline, medians.totalInputTokens),
    aggregateCheck("governance_input_tokens_decreased", medians.graphGovernanceInputTokens.optimized < medians.graphGovernanceInputTokens.baseline, medians.graphGovernanceInputTokens),
    aggregateCheck("provider_latency_decreased", medians.providerLatencyMs.optimized < medians.providerLatencyMs.baseline, medians.providerLatencyMs),
    aggregateCheck("schema_repairs_not_increased", medians.validationFailures.optimized <= medians.validationFailures.baseline, medians.validationFailures),
    aggregateCheck("kv_cache_not_regressed", Number.isFinite(medians.kvCacheHitRate.optimized)
      && medians.kvCacheHitRate.optimized >= 0.9
      && medians.kvCacheHitRate.optimized >= medians.kvCacheHitRate.baseline - 0.02, medians.kvCacheHitRate),
  ]
  const failedAggregateChecks = aggregateChecks.filter((check) => check.status === "fail").map((check) => check.id)
  return {
    status: invalidPairs.length === 0 && failedAggregateChecks.length === 0 ? "pass" : "fail",
    minimumPairs,
    validPairCount: validPairs.length,
    invalidPairs,
    pairs: pairSummaries,
    medians,
    aggregateChecks,
    failedAggregateChecks,
  }
}

function pairSummary(pair) {
  return {
    pairId: pair.pairId,
    status: pair.status,
    failedChecks: pair.failedChecks,
    checks: pair.checks,
    baseline: reportSummary(pair.baseline),
    optimized: reportSummary(pair.optimized),
  }
}

function reportSummary(report) {
  if (report === undefined) return undefined
  return {
    taskId: report.taskId,
    codeRevision: report.codeRevision,
    graphRevisionCount: report.graphRevisionCount,
    sourceUnitCount: report.sourceUnitCount,
    validationFailureCount: report.validationFailures?.length ?? 0,
    totalUsage: report.totalUsage,
    graphGovernanceUsage: report.graphGovernanceUsage,
  }
}

function auditPair(pairId, reports) {
  const baselineReports = reports.filter((report) => report.variant === "baseline")
  const optimizedReports = reports.filter((report) => report.variant === "optimized")
  const baseline = baselineReports[0]
  const optimized = optimizedReports[0]
  const checks = [
    pairCheck("single_baseline_and_optimized", baselineReports.length === 1 && optimizedReports.length === 1, {
      baselineCount: baselineReports.length,
      optimizedCount: optimizedReports.length,
    }),
    pairCheck("same_frozen_start", baseline !== undefined && optimized !== undefined
      && canonicalStringify(pairIdentity(baseline)) === canonicalStringify(pairIdentity(optimized)), {
      baseline: baseline === undefined ? undefined : pairIdentity(baseline),
      optimized: optimized === undefined ? undefined : pairIdentity(optimized),
    }),
    pairCheck("baseline_delivery_gates", deliveryGatesPass(baseline), deliveryGateEvidence(baseline)),
    pairCheck("optimized_delivery_gates", deliveryGatesPass(optimized), deliveryGateEvidence(optimized)),
    pairCheck("optimized_semantic_gates", optimizedSemanticGatesPass(optimized), optimizedSemanticEvidence(optimized)),
  ]
  const failedChecks = checks.filter((check) => check.status === "fail").map((check) => check.id)
  return {
    pairId,
    status: failedChecks.length === 0 ? "pass" : "fail",
    failedChecks,
    checks,
    baseline,
    optimized,
  }
}

function deliveryGatesPass(report) {
  return report?.status === "pass"
    && Array.isArray(report.checks)
    && report.checks.length > 0
    && report.checks.every((check) => check.status === "pass")
    && Number(report.graphRevisionCount) > 0
    && Number(report.sourceUnitCount) > 0
}

function deliveryGateEvidence(report) {
  return report === undefined ? undefined : {
    status: report.status,
    failedChecks: report.checks?.filter((check) => check.status !== "pass").map((check) => check.id) ?? [],
    graphRevisionCount: report.graphRevisionCount,
    sourceUnitCount: report.sourceUnitCount,
  }
}

function optimizedSemanticGatesPass(report) {
  return report?.stageProjectionAudit?.status === "pass"
    && Number(report.stageProjectionAudit?.evidence?.deduplicatedEvidenceCharacters) > 0
    && report.temporalContinuityAudit?.passed === true
    && Array.isArray(report.temporalContinuityAudit?.claimRefs)
    && report.temporalContinuityAudit.claimRefs.length > 0
    && report.promptPrefixAudit?.status === "pass"
}

function optimizedSemanticEvidence(report) {
  return report === undefined ? undefined : {
    stageProjectionAudit: report.stageProjectionAudit,
    temporalContinuityAudit: report.temporalContinuityAudit,
    promptPrefixAudit: report.promptPrefixAudit,
  }
}

function pairIdentity(report) {
  return {
    projectId: report.projectId,
    userInput: report.userInput,
    model: report.model,
    historyState: report.start?.historyState,
    selectedEntry: report.start?.selectedEntry,
    projectSettingsDigest: report.start?.projectSettingsDigest,
    contextDigest: report.start?.contextDigest,
    workspaceDigest: report.start?.workspaceDigest,
    chapterCount: report.start?.chapterCount,
  }
}

function buildMedians(pairs) {
  return {
    totalInputTokens: pairedMedian(pairs, (report) => report.totalUsage?.inputTokens),
    graphGovernanceInputTokens: pairedMedian(pairs, (report) => report.graphGovernanceUsage?.inputTokens),
    providerLatencyMs: pairedMedian(pairs, (report) => report.totalUsage?.latencyMs),
    validationFailures: pairedMedian(pairs, (report) => report.validationFailures?.length ?? 0),
    kvCacheHitRate: pairedMedian(pairs, (report) => report.totalUsage?.kvCacheHitRate),
    modelCalls: pairedMedian(pairs, (report) => report.totalUsage?.modelCalls),
    outputTokens: pairedMedian(pairs, (report) => report.totalUsage?.outputTokens),
  }
}

function pairedMedian(pairs, select) {
  return {
    baseline: median(pairs.map((pair) => Number(select(pair.baseline)))),
    optimized: median(pairs.map((pair) => Number(select(pair.optimized)))),
  }
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return Number.NaN
  const middle = Math.floor(finite.length / 2)
  return finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2
}

function pairCheck(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function aggregateCheck(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function canonicalStringify(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]))
}
