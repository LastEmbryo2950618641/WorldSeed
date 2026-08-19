import { describe, expect, it } from "vitest"

import { auditGraphCostPairs } from "../lib/graph-cost-ab-audit.mjs"

describe("graph cost A/B audit", () => {
  it("passes three equivalent pairs when optimized medians improve without semantic regression", () => {
    const reports = [1, 2, 3].flatMap((index) => [
      report({ pairId: `pair-${index}`, variant: "baseline", inputTokens: 1_000 + index, governanceTokens: 600 + index, latencyMs: 500 + index }),
      report({ pairId: `pair-${index}`, variant: "optimized", inputTokens: 700 + index, governanceTokens: 300 + index, latencyMs: 350 + index }),
    ])

    const result = auditGraphCostPairs(reports)

    expect(result.status).toBe("pass")
    expect(result.validPairCount).toBe(3)
    expect(result.medians.totalInputTokens).toEqual({ baseline: 1_002, optimized: 702 })
    expect(result.medians.graphGovernanceInputTokens).toEqual({ baseline: 602, optimized: 302 })
    expect(result.medians.providerLatencyMs).toEqual({ baseline: 502, optimized: 352 })
  })

  it("rejects pairs whose frozen start differs", () => {
    const baseline = report({ pairId: "pair-1", variant: "baseline" })
    const optimized = report({ pairId: "pair-1", variant: "optimized" })
    optimized.start.contextDigest = "different-context"

    const result = auditGraphCostPairs([baseline, optimized], { minimumPairs: 1 })

    expect(result.status).toBe("fail")
    expect(result.invalidPairs[0].failedChecks).toContain("same_frozen_start")
  })

  it("rejects optimized results that lose temporal continuity coverage", () => {
    const baseline = report({ pairId: "pair-1", variant: "baseline" })
    const optimized = report({ pairId: "pair-1", variant: "optimized" })
    optimized.temporalContinuityAudit.passed = false

    const result = auditGraphCostPairs([baseline, optimized], { minimumPairs: 1 })

    expect(result.status).toBe("fail")
    expect(result.invalidPairs[0].failedChecks).toContain("optimized_semantic_gates")
  })

  it("fails when optimized median cost does not decrease", () => {
    const baseline = report({ pairId: "pair-1", variant: "baseline", inputTokens: 800, governanceTokens: 300, latencyMs: 300 })
    const optimized = report({ pairId: "pair-1", variant: "optimized", inputTokens: 900, governanceTokens: 400, latencyMs: 350 })

    const result = auditGraphCostPairs([baseline, optimized], { minimumPairs: 1 })

    expect(result.status).toBe("fail")
    expect(result.failedAggregateChecks).toEqual(expect.arrayContaining([
      "total_input_tokens_decreased",
      "governance_input_tokens_decreased",
      "provider_latency_decreased",
    ]))
  })
})

function report(input) {
  const variant = input.variant
  return {
    status: "pass",
    pairId: input.pairId,
    variant,
    projectId: "project-1",
    userInput: "continue",
    model: { provider: "deepseek", model: "deepseek-v4-flash", contextWindowTokens: 1_000_000 },
    start: {
      historyState: { selectedEntryId: "entry-1" },
      selectedEntry: { id: "entry-1", manifestDigest: "manifest-1", committedSequence: 25 },
      projectSettingsDigest: "settings-1",
      contextDigest: "context-1",
      workspaceDigest: "workspace-1",
      chapterCount: 25,
    },
    graphRevisionCount: 3,
    sourceUnitCount: 8,
    checks: [{ id: "task_completed", status: "pass" }],
    stageProjectionAudit: {
      status: variant === "optimized" ? "pass" : "not_applicable",
      evidence: { deduplicatedEvidenceCharacters: variant === "optimized" ? 120 : 0 },
    },
    temporalContinuityAudit: { passed: true, claimRefs: ["claim:one"] },
    promptPrefixAudit: { status: "pass" },
    validationFailures: [],
    totalUsage: {
      modelCalls: 10,
      inputTokens: input.inputTokens ?? (variant === "baseline" ? 1_000 : 700),
      outputTokens: 100,
      latencyMs: input.latencyMs ?? (variant === "baseline" ? 500 : 350),
      kvCacheHitRate: variant === "baseline" ? 0.95 : 0.96,
    },
    graphGovernanceUsage: {
      modelCalls: 4,
      inputTokens: input.governanceTokens ?? (variant === "baseline" ? 600 : 300),
      outputTokens: 40,
      latencyMs: 100,
      kvCacheHitRate: variant === "baseline" ? 0.94 : 0.95,
    },
  }
}
