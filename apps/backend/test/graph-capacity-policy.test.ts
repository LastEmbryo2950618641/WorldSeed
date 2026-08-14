import { describe, expect, it } from "vitest"
import { graphGovernanceArtifactSchema } from "@worldseed/prompt-contracts"

import { assessGraphGovernanceCapacity } from "../src/index.js"

describe("graph capacity policy", () => {
  it("projects generic candidate link changes without interpreting node content", async () => {
    const governance = graphGovernanceArtifactSchema.parse({
      mutations: [
        { operation: "create_node", ref: "local:root", data: { content: { arbitrary: 1 } } },
        { operation: "create_node", ref: "local:left", data: { content: ["opaque"] } },
        { operation: "create_node", ref: "local:right", data: { content: "untyped" } },
        { operation: "create_link", ref: "local:first", fromRef: "local:root", toRef: "local:left" },
        { operation: "create_link", ref: "local:second", fromRef: "local:root", toRef: "local:right" },
      ],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    })

    const assessment = await assessGraphGovernanceCapacity({
      projectId: "00000000-0000-4000-8000-000000000001",
      profile: { nodeCount: 0, linkCount: 0, entries: [] },
      governance,
      limits: { maxDirectInDegree: 1, maxDirectOutDegree: 1 },
      graph: { getLink: () => Promise.resolve(undefined) },
    })

    expect(assessment).toMatchObject({ nodeCount: 3, linkCount: 2 })
    expect(assessment.violations).toEqual([{
      nodeId: "local:root",
      inDegree: 0,
      outDegree: 2,
      exceeded: ["out"],
    }])
  })

  it("applies edits and retirements in candidate order", async () => {
    const governance = graphGovernanceArtifactSchema.parse({
      mutations: [
        {
          operation: "edit_link",
          linkRef: "link_1",
          fromRef: "node_2",
          toRef: "node_3",
        },
        { operation: "retire_link", linkRef: "link_1", archiveOutletRefs: ["node_2"] },
      ],
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    })
    let reads = 0
    const assessment = await assessGraphGovernanceCapacity({
      projectId: "00000000-0000-4000-8000-000000000001",
      profile: {
        nodeCount: 3,
        linkCount: 1,
        entries: [
          { nodeId: "node_1", inDegree: 0, outDegree: 1 },
          { nodeId: "node_2", inDegree: 1, outDegree: 0 },
          { nodeId: "node_3", inDegree: 0, outDegree: 0 },
        ],
      },
      governance,
      limits: { maxDirectInDegree: 1, maxDirectOutDegree: 1 },
      graph: {
        getLink: () => {
          reads += 1
          return Promise.resolve({ id: "link_1", fromNodeId: "node_1", toNodeId: "node_2" })
        },
      },
    })

    expect(reads).toBe(1)
    expect(assessment.linkCount).toBe(0)
    expect(assessment.entries.every((entry) => entry.inDegree === 0 && entry.outDegree === 0)).toBe(true)
    expect(assessment.violations).toEqual([])
  })
})
