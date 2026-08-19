import { describe, expect, it } from "vitest"

import {
  buildCommitReviewProjection,
  buildFrontierSettlementProjection,
  buildGraphGovernanceReviewProjection,
  buildSettlementReviewProjection,
  readPriorFrontierStates,
} from "../src/application/turns/graph-governance-stage-projection.js"

describe("graph governance stage projections", () => {
  it("builds a deterministic self-contained governance review projection without the aggregate artifact", () => {
    const first = buildGraphGovernanceReviewProjection({
      scopeId: "scope_1",
      artifacts: stagedArtifacts(),
      sourceUnitCount: 0,
      verificationProbeExecutions: [],
    })
    const second = buildGraphGovernanceReviewProjection({
      scopeId: "scope_1",
      artifacts: stagedArtifacts(),
      sourceUnitCount: 0,
      verificationProbeExecutions: [],
    })

    expect(first).toEqual(second)
    expect(first.projectionDigest).toHaveLength(64)
    expect(first.temporalClaims).toHaveLength(1)
    expect(first.temporalClaimSettlements).toHaveLength(1)
    expect(first).not.toHaveProperty("graph_governance")
    expect(JSON.stringify(first)).not.toContain('"mutations"')
  })

  it("builds minimal settlement and frontier responsibility projections", () => {
    const artifacts = stagedArtifacts()
    const settlement = buildSettlementReviewProjection({ scopeId: "scope_1", artifacts, sourceUnitCount: 0 })
    const frontier = buildFrontierSettlementProjection({ scopeId: "scope_1", artifacts })

    expect(settlement.kind).toBe("settlement_review")
    expect(settlement).not.toHaveProperty("proposals")
    expect(frontier.kind).toBe("frontier_settlement")
    expect(frontier).not.toHaveProperty("sourceCoverage")
  })

  it("projects the previously read anchors for a background frontier settlement", () => {
    const artifacts = stagedArtifacts()
    ;(artifacts.semantic_review as Record<string, unknown>).approvedAffectedFrontierRefs = ["local:frontier"]
    const projection = buildFrontierSettlementProjection({
      scopeId: "scope_1",
      artifacts,
      readEvidence: [{
        ownerKind: "frontier",
        ownerId: "local:frontier",
        sourceRefs: [{
          frontierAnchorRef: "local:frontier",
          lastSceneAnchorRefs: ["local:old-scene"],
          lastTimeAnchorRefs: ["local:old-time"],
          lastLocationAnchorRefs: ["local:old-place"],
          correspondenceRefs: ["local:old-correspondence"],
        }],
      }],
    })

    expect(projection.priorFrontierStates).toEqual([{
      frontierAnchorRef: "local:frontier",
      lastSceneAnchorRefs: ["local:old-scene"],
      lastTimeAnchorRefs: ["local:old-time"],
      lastLocationAnchorRefs: ["local:old-place"],
      correspondenceRefs: ["local:old-correspondence"],
    }])
  })

  it("does not expose prior anchors from another frontier", () => {
    const states = readPriorFrontierStates([{
      ownerKind: "frontier",
      ownerId: "local:other-frontier",
      sourceRefs: [{
        frontierAnchorRef: "local:other-frontier",
        lastSceneAnchorRefs: ["local:other-scene"],
        lastTimeAnchorRefs: ["local:other-time"],
        lastLocationAnchorRefs: ["local:other-place"],
        correspondenceRefs: [],
      }],
    }], ["local:frontier"])

    expect(states).toEqual([])
  })

  it("summarizes temporal assessments as advisory commit continuity guidance", () => {
    const projection = buildCommitReviewProjection({ scopeId: "scope_1", artifacts: stagedArtifacts() })

    expect(projection.continuityAdvice).toEqual([expect.objectContaining({
      claimRef: "claim:one",
      proseExcerpt: "昨天留下的痕迹仍在。",
      verdict: "conflict",
      suggestedDirection: "将相对时间改成与当前场景入口一致的表达。",
    })])
    expect(projection.mechanicalInvariants.finalizationReady).toBe(true)
  })
})

function stagedArtifacts(): Record<string, unknown> {
  const claim = {
    claimRef: "claim:one",
    sceneIndex: 0,
    sourceUnitIndexes: [],
    proseExcerpt: "昨天留下的痕迹仍在。",
    referenceDescription: "相对于前次到达",
    referenceRefs: [],
    evidenceRefs: ["evidence_1"],
    timelineRefs: [],
    relationDescription: "相对时间应匹配当前场景入口",
    verdict: "uncertain",
    reason: "需要时空结算",
    missingEvidence: [],
  }
  return {
    dependency_audit: {
      missingDependencies: [],
      unplannedContent: [],
      sceneContinuity: [],
      temporalClaims: [claim],
      informationBoundary: "pass",
    },
    graph_structure_plan: {
      proposals: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    },
    graph_spacetime_settlement: {
      sceneSpacetimeBindings: [],
      proposalSettlements: [],
      temporalClaimSettlements: [{
        claimRef: "claim:one",
        sceneIndex: 0,
        referenceRefs: [],
        timeAnchorRefs: [],
        timelineRefs: [],
        correspondenceRefs: [],
        historicalReturnRefs: [],
        confidence: "uncertain",
        explanation: "只能确认顺序",
        selfReview: "没有伪造数值",
      }],
    },
    graph_retrieval_design: { projections: [], sourceSettlements: [] },
    graph_governance: {
      mutations: [],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    },
    graph_governance_review: {
      recommendation: "pass",
      issues: [],
      graphStillDiscoverable: true,
      graphStillConcise: true,
      continuityPreserved: true,
      spacetimeContinuityPreserved: true,
      sourceReturnComplete: true,
      verificationProbeAssessments: [],
      temporalClaimAssessments: [{
        claimRef: "claim:one",
        evidenceSufficient: true,
        verdict: "conflict",
        narrativeContext: "直接叙述",
        evidenceRefs: ["evidence_1"],
        responsibility: "draft",
        reason: "相对时间与当前场景入口不一致",
        advice: "将相对时间改成与当前场景入口一致的表达。",
      }],
      selfReview: "建议不阻断提交",
    },
    semantic_review: {
      approvedMutationIndexes: [],
      rejectedMutationIndexes: [],
      approvedSpacetimeBindingIndexes: [],
      rejectedSpacetimeBindingIndexes: [],
      approvedMutationSpacetimeSettlementIndexes: [],
      rejectedMutationSpacetimeSettlementIndexes: [],
      approvedAffectedFrontierRefs: [],
      rejectedAffectedFrontierRefs: [],
      verificationProbeAssessments: [],
      sceneInventoryComplete: true,
      graphStillDiscoverable: true,
      graphStillConcise: true,
      continuityPreserved: true,
      spacetimeContinuityPreserved: true,
    },
    settlement_review: {
      settledSourceUnitIndexes: [],
      uncoveredSourceUnitIndexes: [],
      sourceReturnComplete: true,
      retrievalProjectionComplete: true,
      semanticCoverageComplete: true,
      spacetimeBindingsComplete: true,
      mutationSpacetimeSettlementsComplete: true,
    },
    frontier_settlement: { frontiers: [] },
  }
}
