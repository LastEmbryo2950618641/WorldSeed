import { describe, expect, it } from "vitest"

import {
  calculateKVCacheHitRate,
  graphMutationSchema,
  kvCacheUsageSchema,
  phaseResultEnvelopeSchema,
} from "../src/index.js"

const ids = {
  envelope: "00000000-0000-4000-8000-000000000001",
  context: "00000000-0000-4000-8000-000000000002",
  node: "00000000-0000-4000-8000-000000000003",
  outlet: "00000000-0000-4000-8000-000000000004",
}

describe("shared contracts", () => {
  it("requires reads when a phase requests more evidence", () => {
    const result = phaseResultEnvelopeSchema.safeParse({
      schemaVersion: 1,
      envelopeId: ids.envelope,
      contextId: ids.context,
      phase: "source_retrieval",
      outcome: "request_read",
      requestedReads: [],
      citedReadIds: [],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: "More evidence is required",
      selfReview: "No unreturned evidence was used",
    })

    expect(result.success).toBe(false)
  })

  it("supports archive-preserving graph retirement", () => {
    expect(graphMutationSchema.parse({
      operation: "retire_node",
      nodeId: ids.node,
      archiveOutletIds: [ids.outlet],
    })).toEqual({
      operation: "retire_node",
      nodeId: ids.node,
      archiveOutletIds: [ids.outlet],
    })
  })

  it("reports cache hit rate only when provider details are complete", () => {
    const complete = kvCacheUsageSchema.parse({
      totalInputTokens: 100,
      cacheHitInputTokens: 35,
      cacheMissInputTokens: 65,
    })
    const unavailable = kvCacheUsageSchema.parse({ totalInputTokens: 100 })

    expect(calculateKVCacheHitRate(complete)).toBe(0.35)
    expect(calculateKVCacheHitRate(unavailable)).toBeUndefined()
    expect(calculateKVCacheHitRate({
      totalInputTokens: 0,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
    })).toBeUndefined()
  })
})
