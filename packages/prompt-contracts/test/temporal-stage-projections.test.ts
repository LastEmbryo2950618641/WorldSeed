import { describe, expect, it } from "vitest"

import {
  assertCommitReviewCoversTemporalClaims,
  assertPhaseReferenceContract,
  assertTemporalClaimCoverage,
  dependencyAuditArtifactSchema,
  graphGovernanceReviewArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  stageProjectionSchema,
} from "../src/index.js"

describe("temporal continuity contracts", () => {
  it("requires unique AI-defined temporal claim references", () => {
    expect(() => dependencyAuditArtifactSchema.parse({
      ...dependencyArtifact(),
      temporalClaims: [temporalClaim("claim:one"), temporalClaim("claim:one")],
    })).toThrow(/temporal claim references must be unique/u)
  })

  it("requires spacetime settlement and governance review to cover every claim exactly once", () => {
    const dependency = dependencyAuditArtifactSchema.parse({
      ...dependencyArtifact(),
      temporalClaims: [temporalClaim("claim:one"), temporalClaim("claim:two")],
    })
    const settlement = graphSpacetimeSettlementArtifactSchema.parse({
      sceneSpacetimeBindings: [],
      proposalSettlements: [],
      temporalClaimSettlements: [temporalSettlement("claim:one")],
    })
    const review = graphGovernanceReviewArtifactSchema.parse({
      ...governanceReviewArtifact(),
      temporalClaimAssessments: [temporalAssessment("claim:one"), temporalAssessment("claim:two")],
    })

    expect(() => { assertTemporalClaimCoverage(dependency, settlement, review); })
      .toThrow(/Temporal claim settlements must contain every approved reference exactly once/u)
  })

  it("rejects a temporal settlement attached to a different scene", () => {
    const dependency = dependencyAuditArtifactSchema.parse({
      ...dependencyArtifact(),
      temporalClaims: [temporalClaim("claim:one", 1)],
    })
    const settlement = graphSpacetimeSettlementArtifactSchema.parse({
      sceneSpacetimeBindings: [],
      proposalSettlements: [],
      temporalClaimSettlements: [temporalSettlement("claim:one")],
    })
    const review = graphGovernanceReviewArtifactSchema.parse({
      ...governanceReviewArtifact(),
      temporalClaimAssessments: [temporalAssessment("claim:one")],
    })

    expect(() => { assertTemporalClaimCoverage(dependency, settlement, review); })
      .toThrow(/claim:one.*scene index 1.*received 0/u)
  })

  it("rejects temporal claim evidence that was not read in the current turn", () => {
    expect(() => { assertPhaseReferenceContract("dependency_audit", {
      ...dependencyArtifact(),
      temporalClaims: [temporalClaim("claim:one")],
    }, {
      readableEvidenceIds: new Set(["evidence_2"]),
      readableGraphIds: new Set(["node_1", "node_2"]),
      readableWorkspacePaths: new Set(),
    }); }).toThrow(/Read evidence references must belong to this turn/u)
  })

  it("rejects local graph handles in temporal assessment evidence fields", () => {
    expect(() => graphGovernanceReviewArtifactSchema.parse({
      ...governanceReviewArtifact(),
      temporalClaimAssessments: [{
        ...temporalAssessment("claim:one"),
        evidenceRefs: ["local:time-window"],
      }],
    })).toThrow()
  })

  it("requires commit advice to cover reviewed temporal claims exactly once", () => {
    expect(() => { assertCommitReviewCoversTemporalClaims(
      {
        ...governanceReviewArtifact(),
        temporalClaimAssessments: [temporalAssessment("claim:one")],
      },
      { recommendation: "commit", continuityAdvice: [], finalSelfReview: "提交建议只供用户查看" },
    ); }).toThrow(/Commit continuity advice must contain every approved reference exactly once/u)
  })
})

describe("stage projection contracts", () => {
  it.each([
    governanceProjection(),
    settlementProjection(),
    frontierProjection(),
    commitProjection(),
  ])("accepts the self-contained $kind projection", (projection) => {
    expect(stageProjectionSchema.parse(projection)).toEqual(projection)
  })

  it("rejects a projection without a canonical digest", () => {
    const { projectionDigest: ignored, ...projection } = commitProjection()
    void ignored
    expect(() => stageProjectionSchema.parse(projection)).toThrow()
  })
})

function dependencyArtifact() {
  return {
    missingDependencies: [],
    unplannedContent: [],
    sceneContinuity: [],
    temporalClaims: [],
    informationBoundary: "pass",
  }
}

function temporalClaim(claimRef: string, sceneIndex = 0) {
  return {
    claimRef,
    sceneIndex,
    sourceUnitIndexes: [0],
    proseExcerpt: "那是昨天留下的痕迹。",
    referenceDescription: "相对于人物前次抵达此处的事件",
    referenceRefs: ["node_1"],
    evidenceRefs: ["evidence_1"],
    timelineRefs: ["node_2"],
    relationDescription: "正文表达的时间距离应与当前场景入口一致",
    verdict: "uncertain",
    reason: "仍需绑定当前场景时间锚点",
    missingEvidence: ["当前场景时间入口"],
  }
}

function temporalSettlement(claimRef: string) {
  return {
    claimRef,
    sceneIndex: 0,
    referenceRefs: ["node_1"],
    timeAnchorRefs: ["node_2"],
    timelineRefs: ["node_3"],
    correspondenceRefs: [],
    historicalReturnRefs: ["node_1"],
    confidence: "uncertain",
    explanation: "现有信息只能确认先后关系，不能精确换算数值。",
    selfReview: "没有伪造时间数值。",
  }
}

function temporalAssessment(claimRef: string) {
  return {
    claimRef,
    evidenceSufficient: false,
    verdict: "uncertain",
    narrativeContext: "当前叙述直接描述角色认知到的时间关系",
    evidenceRefs: ["evidence_1"],
    responsibility: "retrieval",
    reason: "缺少参照事件的精确时间锚点",
    advice: "保留不确定表达或补充参照事件。",
  }
}

function governanceReviewArtifact() {
  return {
    recommendation: "pass",
    issues: [],
    graphStillDiscoverable: true,
    graphStillConcise: true,
    continuityPreserved: true,
    spacetimeContinuityPreserved: true,
    sourceReturnComplete: true,
    verificationProbeAssessments: [],
    temporalClaimAssessments: [],
    selfReview: "审核完成",
  }
}

function projectionBase(kind: string) {
  return {
    kind,
    version: 1,
    sourceArtifactDigests: { dependency_audit: "dependency-digest" },
    pendingScope: { scopeId: "scope_1", candidateDigest: "candidate-digest" },
    projectionDigest: `${kind}-digest`,
    unresolvedIssues: [],
  }
}

function governanceProjection() {
  return {
    ...projectionBase("graph_governance_review"),
    proposals: [],
    decisionRecords: [],
    sceneSpacetimeBindings: [],
    proposalSettlements: [],
    retrievalProjections: [],
    sourceSettlements: [],
    affectedFrontierRefs: [],
    archiveOutletRefs: [],
    temporalClaims: [],
    temporalClaimSettlements: [],
    verificationProbeExecutions: [],
    mechanicalChecks: { capacitySatisfied: true, sourceReturnComplete: true, referenceIntegrity: true },
  }
}

function settlementProjection() {
  return {
    ...projectionBase("settlement_review"),
    sourceCoverage: [],
    sceneCoverage: [],
    proposalCoverage: [],
    retrievalCoverage: [],
    uncoveredSourceUnitIndexes: [],
    mechanicalChecks: { sourceCoverageComplete: true, spacetimeCoverageComplete: true, retrievalCoverageComplete: true },
  }
}

function frontierProjection() {
  return {
    ...projectionBase("frontier_settlement"),
    affectedFrontierRefs: [],
    approvedSceneBindings: [],
    archiveOutletRefs: [],
    correspondenceRefs: [],
    priorFrontierStates: [],
  }
}

function commitProjection() {
  return {
    ...projectionBase("commit_review"),
    stageChain: [],
    governanceConclusion: { recommendation: "pass", issueCount: 0 },
    settlementConclusion: { complete: true, uncoveredSourceUnitIndexes: [] },
    frontierConclusion: { frontierCount: 0 },
    continuityAdvice: [],
    pendingWriteSummary: { mutationCount: 0, sourceSettlementCount: 0, frontierCount: 0 },
    mechanicalInvariants: { referenceIntegrity: true, digestAligned: true, finalizationReady: true },
    risks: [],
  }
}
