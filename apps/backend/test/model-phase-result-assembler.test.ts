import { describe, expect, it } from "vitest"
import type { PhaseRequestEnvelope } from "@worldseed/contracts"

import { assembleModelPhaseResult } from "../src/infrastructure/models/deepseek/model-phase-result-assembler.js"

describe("assembleModelPhaseResult", () => {
  it("normalizes a visible evidence alias to its canonical read ID", () => {
    const request = createRequest()

    const result = assembleModelPhaseResult({
      outcome: "continue",
      artifact: {
        workflow: "turn",
        userIntent: "继续观察",
        worldIntent: "保持当前世界连续性",
        presentationIntent: "沿用当前表现规则",
        userClaims: [],
        requiredTimeAnchor: true,
        requiredLocationAnchor: true,
        initialReadHypotheses: [],
      },
      requestedReads: [],
      citedReadIds: ["evidence_2"],
      unresolvedDependencies: [],
      reason: "使用链中已可见的旧引用",
      selfReview: "引用应规范化后校验",
    }, request, () => "00000000-0000-4000-8000-000000000099")

    expect(result.citedReadIds).toEqual(["evidence_1"])
  })

  it("normalizes visible evidence aliases inside phase artifacts", () => {
    const request = { ...createRequest(), phase: "dependency_audit" as const }

    const result = assembleModelPhaseResult({
      outcome: "continue",
      artifact: {
        missingDependencies: [],
        unplannedContent: [],
        sceneContinuity: [],
        temporalClaims: [{
          claimRef: "claim:arrival",
          sceneIndex: 0,
          sourceUnitIndexes: [0],
          proseExcerpt: "他在黄昏抵达。",
          referenceDescription: "黄昏抵达",
          referenceRefs: [],
          evidenceRefs: ["evidence_2"],
          timelineRefs: [],
          relationDescription: "相对前一场景连续",
          verdict: "pass",
          reason: "旧链证据支持该判断",
          missingEvidence: [],
        }],
        informationBoundary: "pass",
      },
      requestedReads: [],
      citedReadIds: ["evidence_2"],
      unresolvedDependencies: [],
      reason: "审查正文时间连续性",
      selfReview: "引用应规范化后再做契约校验",
    }, request, () => "00000000-0000-4000-8000-000000000099")

    expect(result.citedReadIds).toEqual(["evidence_1"])
    expect(result.artifact).toMatchObject({
      temporalClaims: [{ evidenceRefs: ["evidence_1"] }],
    })
  })

  it("accepts only frontier anchors authorized by the stage projection", () => {
    const request = createFrontierRequest()
    const result = assembleModelPhaseResult(frontierResult("node_277"), request)

    expect(result.artifact).toMatchObject({
      frontiers: [{
        frontierAnchorRef: "node_154",
        lastSceneAnchorRefs: ["node_277"],
        correspondenceRefs: ["link_411"],
      }],
    })
    expect(() => assembleModelPhaseResult(frontierResult("node_999"), request))
      .toThrow("previously read anchors")
  })
})

function frontierResult(sceneAnchorRef: string) {
  return {
    outcome: "continue" as const,
    artifact: {
      frontiers: [{
        frontierAnchorRef: "node_154",
        disposition: "active" as const,
        lastSceneAnchorRefs: [sceneAnchorRef],
        lastTimeAnchorRefs: ["node_277"],
        lastLocationAnchorRefs: ["node_154"],
        correspondenceRefs: ["link_411"],
        reason: "继续保留该局部演化入口",
        revisitCondition: "局部状态发生变化时重访",
      }],
    },
    requestedReads: [],
    citedReadIds: [],
    unresolvedDependencies: [],
    reason: "完成前沿结算",
    selfReview: "只复用同一前沿旧锚点",
  }
}

function createFrontierRequest(): PhaseRequestEnvelope {
  const governance = {
    mutations: [],
    retrievalProjections: [],
    settlementRecords: [],
    mutationSpacetimeSettlements: [],
    sceneSpacetimeBindings: [],
    affectedFrontierRefs: ["node_154"],
    archiveOutletRefs: [],
    decisionRecords: [],
  }
  const semanticReview = {
    approvedMutationIndexes: [],
    rejectedMutationIndexes: [],
    approvedSpacetimeBindingIndexes: [],
    rejectedSpacetimeBindingIndexes: [],
    approvedMutationSpacetimeSettlementIndexes: [],
    rejectedMutationSpacetimeSettlementIndexes: [],
    approvedAffectedFrontierRefs: ["node_154"],
    rejectedAffectedFrontierRefs: [],
    verificationProbeAssessments: [],
    sceneInventoryComplete: true,
    graphStillDiscoverable: true,
    graphStillConcise: true,
    continuityPreserved: true,
    spacetimeContinuityPreserved: true,
  }
  return {
    ...createRequest(),
    phase: "frontier_settlement",
    input: {
      workflow: "evolution",
      userInput: "推进后台世界演化",
      chapterSequence: 1,
      allowWorkspaceChapterReads: false,
      sourceUnitIds: [],
      phaseRunIds: [],
      readEvidence: [{
        readId: "evidence_1",
        visibility: "committed",
        ownerKind: "node",
        ownerId: "node_154",
        exactKeys: [],
        semanticText: "寄存处当前状态",
        sourceRefs: [],
        digest: "evidence-digest",
      }],
      retrievalGaps: [],
      artifacts: {},
      validationArtifacts: { graph_governance: governance, semantic_review: semanticReview },
      stageProjection: {
        kind: "frontier_settlement",
        version: 1,
        sourceArtifactDigests: {
          graph_governance: "digest-governance",
          semantic_review: "digest-review",
          settlement_review: "digest-settlement",
        },
        pendingScope: { scopeId: "scope_1", candidateDigest: "digest-scope" },
        projectionDigest: "digest-projection",
        unresolvedIssues: [],
        affectedFrontierRefs: ["node_154"],
        approvedSceneBindings: [],
        archiveOutletRefs: [],
        correspondenceRefs: [],
        priorFrontierStates: [{
          frontierAnchorRef: "node_154",
          lastSceneAnchorRefs: ["node_277"],
          lastTimeAnchorRefs: ["node_277"],
          lastLocationAnchorRefs: ["node_154"],
          correspondenceRefs: ["link_411"],
        }],
      },
    },
  }
}

function createRequest(): PhaseRequestEnvelope {
  return {
    schemaVersion: 1,
    protocolVersion: "1.0.0",
    envelopeId: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    turnId: "00000000-0000-4000-8000-000000000003",
    scopeId: "00000000-0000-4000-8000-000000000004",
    contextId: "00000000-0000-4000-8000-000000000005",
    phase: "interpret",
    attempt: 1,
    promptRef: "prompt:interpret",
    promptDigest: "prompt-digest",
    contextViewRef: "context-view",
    committedReadIds: ["evidence_1"],
    visiblePendingIds: [],
    remainingBudget: {
      remainingCalls: 10,
      remainingInputTokens: 100_000,
      remainingOutputTokens: 100_000,
      deadlineAtMs: Date.now() + 60_000,
    },
    input: {
      artifacts: {},
      sourceUnitIds: [],
      readEvidence: [{
        readId: "evidence_1",
        canonicalReadId: "evidence_1",
        readIdAliases: ["evidence_2"],
        versionKey: "node:node_1:revision_1",
        visibility: "committed",
        ownerKind: "node",
        ownerId: "node_1",
        exactKeys: ["旧引用"],
        semanticText: "同一事实版本",
        digest: "projection-a",
        sourceRefs: [],
      }],
    },
  }
}
