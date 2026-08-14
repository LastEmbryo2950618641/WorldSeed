import { describe, expect, it } from "vitest"

import {
  applyGraphCapacityRewrite,
  assembleGraphGovernanceArtifact,
  invalidatedGraphGovernancePhases,
  replayGraphCapacityRewrites,
} from "../src/application/turns/graph-governance-assembler.js"

const structure = {
  proposals: [
    {
      proposalRef: "proposal:node:scene",
      mutation: { operation: "create_node" as const, ref: "local:scene", data: { content: "scene" } },
      reason: "Represent the scene",
      selfReview: "The proposal is locally minimal",
    },
    {
      proposalRef: "proposal:node:time",
      mutation: { operation: "create_node" as const, ref: "local:time", data: { content: "time" } },
      reason: "Represent its temporal anchor",
      selfReview: "The anchor is reusable",
    },
    {
      proposalRef: "proposal:link:scene-time",
      mutation: {
        operation: "create_link" as const,
        ref: "local:scene-time",
        fromRef: "local:scene",
        toRef: "local:time",
        content: "temporal outlet",
      },
      reason: "Connect the scene to its time",
      selfReview: "The link preserves selective discovery",
    },
  ],
  affectedFrontierRefs: ["local:scene"],
  archiveOutletRefs: [],
  decisionRecords: [{
    decisionKind: "initial_structure",
    proposalRefs: ["proposal:node:scene", "proposal:node:time", "proposal:link:scene-time"],
    reason: "Create the minimum connected local structure",
    payload: {},
    selfReview: "No fixed domain type was introduced",
  }],
}

describe("staged graph governance", () => {
  it("assembles staged artifacts into the existing persistence view", () => {
    const governance = assembleGraphGovernanceArtifact({
      structure,
      spacetime: {
        sceneSpacetimeBindings: [{
          sceneIndex: 0,
          sceneAnchorRef: "local:scene",
          sourceUnitIndexes: [0],
          temporalReferenceRefs: ["local:time"],
          timeAnchorRefs: ["local:time"],
          spatialReferenceRefs: ["local:scene"],
          locationAnchorRefs: ["local:scene"],
          predecessorSceneIndexes: [],
          predecessorSceneAnchorRefs: [],
          transitionPathRefs: [],
          correspondenceRefs: [],
          explanation: "The scene establishes its own anchors",
          selfReview: "The first scene has no invented predecessor",
        }],
        proposalSettlements: [{
          proposalRefs: ["proposal:node:scene", "proposal:node:time", "proposal:link:scene-time"],
          effectDisposition: "world_effect" as const,
          effectiveSceneBindingIndexes: [0],
          effectiveExistingSceneAnchorRefs: [],
          currentEntryRefs: ["local:scene"],
          predecessorRevisionRequired: false,
          predecessorRevisionReadRefs: [],
          historicalReturnRefs: ["local:scene"],
          reason: "All proposals become effective in this scene",
          selfReview: "Current and historical entry points remain discoverable",
        }],
      },
      retrieval: {
        projections: [{
          ownerProposalRef: "proposal:node:scene",
          exactKeys: ["原句"],
          semanticText: "Return the scene and its original prose",
        }],
        sourceSettlements: [{
          sourceUnitIndex: 0,
          graphRefs: [{ targetKind: "node" as const, targetRef: "local:scene", proposalRef: "proposal:node:scene" }],
          reason: "The source unit is anchored to the scene",
          status: "settled",
        }],
      },
      sourceUnitCount: 1,
    })

    expect(governance.mutations).toHaveLength(3)
    expect(governance.retrievalProjections[0]?.ownerMutationIndex).toBe(0)
    expect(governance.mutationSpacetimeSettlements[0]?.mutationIndexes).toEqual([0, 1, 2])
    expect(governance.decisionRecords[0]?.mutationIndexes).toEqual([0, 1, 2])
  })

  it("derives source settlements when staged retrieval omits the mechanical projection", () => {
    const governance = assembleGraphGovernanceArtifact({
      structure,
      spacetime: {
        sceneSpacetimeBindings: [{
          sceneIndex: 0,
          sceneAnchorRef: "local:scene",
          sourceUnitIndexes: [0, 1],
          temporalReferenceRefs: ["local:time"],
          timeAnchorRefs: ["local:time"],
          spatialReferenceRefs: ["local:scene"],
          locationAnchorRefs: ["local:scene"],
          predecessorSceneIndexes: [],
          predecessorSceneAnchorRefs: [],
          transitionPathRefs: [],
          correspondenceRefs: [],
          explanation: "Both source units belong to the same scene",
          selfReview: "The source coverage is explicit",
        }],
        proposalSettlements: [{
          proposalRefs: ["proposal:node:scene", "proposal:node:time", "proposal:link:scene-time"],
          effectDisposition: "world_effect" as const,
          effectiveSceneBindingIndexes: [0],
          effectiveExistingSceneAnchorRefs: [],
          currentEntryRefs: ["local:scene"],
          predecessorRevisionRequired: false,
          predecessorRevisionReadRefs: [],
          historicalReturnRefs: ["local:scene"],
          reason: "All proposals become effective in this scene",
          selfReview: "Current and historical entry points remain discoverable",
        }],
      },
      retrieval: {
        projections: [],
        sourceSettlements: [],
      },
      sourceUnitCount: 2,
    })

    expect(governance.settlementRecords).toEqual([
      expect.objectContaining({ sourceUnitIndex: 0, status: "derived" }),
      expect.objectContaining({ sourceUnitIndex: 1, status: "derived" }),
    ])
    expect(governance.settlementRecords.every((record) => record.graphRefs.length === 3)).toBe(true)
  })

  it("uses a scene anchor as the source return path when the scene has no graph mutation", () => {
    const governance = assembleGraphGovernanceArtifact({
      structure: {
        proposals: [],
        affectedFrontierRefs: [],
        archiveOutletRefs: [],
        decisionRecords: [],
      },
      spacetime: {
        sceneSpacetimeBindings: [{
          sceneIndex: 0,
          sceneAnchorRef: "node_42",
          sourceUnitIndexes: [0],
          temporalReferenceRefs: ["node_43"],
          timeAnchorRefs: ["node_43"],
          spatialReferenceRefs: ["node_42"],
          locationAnchorRefs: ["node_42"],
          predecessorSceneIndexes: [],
          predecessorSceneAnchorRefs: [],
          transitionPathRefs: [],
          correspondenceRefs: [],
          explanation: "The source unit belongs to an existing scene",
          selfReview: "The existing scene remains its graph return path",
        }],
        proposalSettlements: [],
      },
      retrieval: {
        projections: [],
        sourceSettlements: [],
      },
      sourceUnitCount: 1,
    })

    expect(governance.settlementRecords[0]?.graphRefs).toEqual([
      { targetKind: "node", targetRef: "node_42" },
    ])
  })

  it("applies a capacity rewrite only to its declared local proposal scope", () => {
    const rewritten = applyGraphCapacityRewrite(structure, {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:link:scene-time"],
      removeProposalRefs: ["proposal:link:scene-time"],
      upsertProposals: [],
      reason: "Remove one direct outlet from the hotspot",
      selfReview: "Unrelated proposals remain unchanged",
    })

    expect(rewritten.proposals.map((proposal) => proposal.proposalRef)).toEqual([
      "proposal:node:scene",
      "proposal:node:time",
    ])
    const replacement = applyGraphCapacityRewrite(structure, {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:link:scene-time"],
      removeProposalRefs: ["proposal:link:scene-time"],
      upsertProposals: [{
        proposalRef: "proposal:link:scene-time:replacement",
        mutation: {
          operation: "create_link",
          ref: "local:replacement-link",
          fromRef: "local:scene",
          toRef: "local:time",
          content: { relation: "replacement" },
        },
        reason: "Replace the affected direct outlet without overwriting unrelated proposals",
        selfReview: "The replacement has a new proposal identity",
      }],
      reason: "Replace one direct outlet from the hotspot",
      selfReview: "Unrelated existing proposals remain unchanged",
    })

    expect(replacement.proposals.map((proposal) => proposal.proposalRef)).toEqual([
      "proposal:node:scene",
      "proposal:node:time",
      "proposal:link:scene-time:replacement",
    ])
    expect(replacement.decisionRecords).toEqual([
      expect.objectContaining({
        decisionKind: "initial_structure",
        proposalRefs: ["proposal:node:scene", "proposal:node:time"],
      }),
      expect.objectContaining({
        decisionKind: "capacity_rewrite",
        proposalRefs: ["proposal:link:scene-time:replacement"],
        reason: "Replace one direct outlet from the hotspot",
      }),
    ])
    expect(() => assembleGraphGovernanceArtifact({
      structure: replacement,
      spacetime: {
        sceneSpacetimeBindings: [],
        proposalSettlements: [{
          proposalRefs: replacement.proposals.map((proposal) => proposal.proposalRef),
          effectDisposition: "representation_only",
          effectiveSceneBindingIndexes: [],
          effectiveExistingSceneAnchorRefs: [],
          currentEntryRefs: [],
          predecessorRevisionRequired: false,
          predecessorRevisionReadRefs: [],
          historicalReturnRefs: ["local:scene"],
          reason: "Capacity replacement settlement",
          selfReview: "Every live proposal remains resolvable",
        }],
      },
      retrieval: { projections: [], sourceSettlements: [] },
      sourceUnitCount: 0,
    })).not.toThrow()
    expect(() => applyGraphCapacityRewrite(structure, {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:node:scene"],
      removeProposalRefs: ["proposal:node:time"],
      upsertProposals: [],
      reason: "Invalid broad rewrite",
      selfReview: "Invalid",
    })).toThrow(/declared local proposal scope/u)
    expect(() => applyGraphCapacityRewrite(structure, {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:missing"],
      removeProposalRefs: [],
      upsertProposals: [],
      reason: "Invalid missing scope",
      selfReview: "Invalid",
    })).toThrow(/missing existing proposals/u)
  })

  it("invalidates only downstream staged governance work", () => {
    expect(invalidatedGraphGovernancePhases("capacity")).toEqual([
      "graph_spacetime_settlement",
      "graph_retrieval_design",
      "graph_governance_review",
    ])
    expect(invalidatedGraphGovernancePhases("retrieval")).toEqual(["graph_governance_review"])
  })

  it("replays persisted capacity rewrites in order when a task resumes", () => {
    const sceneProposal = structure.proposals[0]
    if (sceneProposal === undefined) throw new Error("The fixture requires a scene proposal")
    const first = {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:link:scene-time"],
      removeProposalRefs: ["proposal:link:scene-time"],
      upsertProposals: [],
      reason: "Remove the first hotspot outlet",
      selfReview: "The first patch is local",
    }
    const second = {
      hotspotRefs: ["local:scene"],
      affectedProposalRefs: ["proposal:node:scene"],
      removeProposalRefs: [],
      upsertProposals: [{
        ...sceneProposal,
        mutation: { operation: "edit_node" as const, nodeRef: "local:scene", next: { content: "rewritten scene" } },
      }],
      reason: "Rewrite the remaining hotspot representation",
      selfReview: "The second patch sees the first patch result",
    }

    const restored = replayGraphCapacityRewrites(structure, [first, second])

    expect(restored.proposals).toHaveLength(2)
    expect(restored.proposals[0]?.mutation).toMatchObject({ operation: "edit_node" })
  })
})
