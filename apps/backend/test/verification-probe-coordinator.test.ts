import { describe, expect, it } from "vitest"

import { VerificationProbeCoordinator } from "../src/application/turns/verification-probe-coordinator.js"

describe("VerificationProbeCoordinator", () => {
  const coordinator = new VerificationProbeCoordinator()
  const request = {
    requestId: "00000000-0000-4000-8000-000000000001",
    reason: "verify current state",
    expectedEvidence: "current state evidence",
    query: {
      exactKeys: [],
      semanticTexts: ["current state"],
      anchorIds: [],
      directions: ["both" as const],
      maxCandidates: 8,
      maxDepth: 2,
      sourceKinds: ["graph" as const, "source" as const],
    },
    verificationProbe: {
      purpose: "restore the governing object's current meaning" as const,
      sceneBindingIndexes: [0],
      mutationSpacetimeSettlementIndexes: [1],
    },
  }
  const governance = {
    mutations: [{ operation: "create_node" as const, ref: "local:current", data: { content: "current state" } }],
    retrievalProjections: [{
      ownerKind: "node" as const,
      ownerMutationIndex: 0,
      exactKeys: ["current state"],
      semanticText: "current state",
    }],
    settlementRecords: [],
    mutationSpacetimeSettlements: [],
    sceneSpacetimeBindings: [],
    affectedFrontierRefs: [],
    archiveOutletRefs: [],
    decisionRecords: [],
  }

  it("builds probe executions only from application read results", () => {
    const executions = coordinator.createExecutions([request], [{
      requestId: request.requestId,
      operationId: request.requestId,
      returnedReadRefs: ["00000000-0000-4000-8000-000000000002"],
      returnedGraphRefs: ["00000000-0000-4000-8000-000000000003"],
      resultDigest: "result-digest",
    }], governance)

    expect(executions).toEqual([expect.objectContaining({
      probeIndex: 0,
      descriptor: request.verificationProbe,
      returnedReadRefs: ["00000000-0000-4000-8000-000000000002"],
      returnedGraphRefs: ["00000000-0000-4000-8000-000000000003"],
      returnedProposalRefs: ["local:current"],
    })])
  })

  it("identifies a probe plan independently from its transient request ID", () => {
    const first = coordinator.planDigest(request, governance)
    const retried = coordinator.planDigest({
      ...request,
      requestId: "00000000-0000-4000-8000-000000000099",
    }, governance)
    const changedQuery = coordinator.planDigest({
      ...request,
      query: { ...request.query, maxDepth: 3 },
    }, governance)

    expect(retried).toBe(first)
    expect(changedQuery).not.toBe(first)
  })

  it("requires every executed probe to be assessed without changing its plan", () => {
    const executions = coordinator.createExecutions([request], [{
      requestId: request.requestId,
      operationId: request.requestId,
      returnedReadRefs: [],
      returnedGraphRefs: [],
      resultDigest: "empty-result",
    }], governance)
    const review = semanticReview([{
      probeIndex: 0,
      verdict: "fail",
      reason: "The real query returned no matching evidence",
    }])

    expect(() => { coordinator.assertAssessments(review, executions) }).not.toThrow()
    expect(() => { coordinator.assertAssessments(semanticReview([]), executions) })
      .toThrow("assess every application-executed verification probe exactly once")
  })

  it("rejects a final review before the AI has defined a verification probe", () => {
    expect(() => { coordinator.assertAssessments(semanticReview([]), []) })
      .toThrow("AI must define at least one verification probe before graph review can finish")
  })

  it("matches assessments by probe index rather than array position", () => {
    const executions = coordinator.createExecutions([request], [{
      requestId: request.requestId,
      operationId: request.requestId,
      returnedReadRefs: [],
      returnedGraphRefs: [],
      resultDigest: "empty-result",
    }], governance, 7)

    expect(() => { coordinator.assertAssessments(semanticReview([{
      probeIndex: 7,
      verdict: "uncertain",
      reason: "The application result is empty, so the semantic outcome remains uncertain",
    }]), executions) }).not.toThrow()
  })
})

function semanticReview(verificationProbeAssessments: readonly Record<string, unknown>[]) {
  return {
    approvedMutationIndexes: [],
    rejectedMutationIndexes: [],
    approvedSpacetimeBindingIndexes: [],
    rejectedSpacetimeBindingIndexes: [],
    approvedMutationSpacetimeSettlementIndexes: [],
    rejectedMutationSpacetimeSettlementIndexes: [],
    approvedAffectedFrontierRefs: [],
    rejectedAffectedFrontierRefs: [],
    verificationProbeAssessments,
    sceneInventoryComplete: true,
    graphStillDiscoverable: true,
    graphStillConcise: true,
    continuityPreserved: true,
    spacetimeContinuityPreserved: true,
  }
}
