import { describe, expect, it } from "vitest"

import {
  decideAdaptiveGraphGovernance,
  type AdaptiveGraphGovernanceCandidate,
} from "../src/application/turns/adaptive-graph-governance-coordinator.js"

const emptyCandidate = (executionMode: AdaptiveGraphGovernanceCandidate["executionMode"]): AdaptiveGraphGovernanceCandidate => ({
  executionMode,
  mutations: [],
  retrievalProjections: [],
  settlementRecords: [],
  mutationSpacetimeSettlements: [],
  sceneSpacetimeBindings: [],
  affectedFrontierRefs: [],
  archiveOutletRefs: [],
  decisionRecords: [],
})

describe("adaptive graph governance coordinator", () => {
  it("routes an explicit no-change result without semantic inspection", () => {
    expect(decideAdaptiveGraphGovernance(emptyCandidate("no_change"))).toMatchObject({
      mode: "no_change",
    })
  })

  it("routes an explicit local result", () => {
    expect(decideAdaptiveGraphGovernance(emptyCandidate("local_governance"))).toMatchObject({
      mode: "local_governance",
    })
  })

  it("keeps full governance as the explicit fallback", () => {
    expect(decideAdaptiveGraphGovernance(emptyCandidate("full_governance"))).toMatchObject({
      mode: "full_governance",
      fallbackReason: "AI selected full governance",
    })
  })

  it("falls back for malformed candidates", () => {
    expect(decideAdaptiveGraphGovernance({})).toMatchObject({
      mode: "full_governance",
      fallbackReason: "Adaptive governance candidate failed contract validation",
    })
  })
})
