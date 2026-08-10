import { describe, expect, it } from "vitest"

import {
  calculateKVCacheHitRate,
  graphMutationSchema,
  kvCacheUsageSchema,
  modelPhaseResultSchema,
  projectSettingsSchema,
  phaseResultEnvelopeSchema,
  evidenceSchema,
  workspaceCatalogSnapshotSchema,
  graphNeighborhoodPayloadSchema,
} from "../src/index.js"

const ids = {
  envelope: "00000000-0000-4000-8000-000000000001",
  context: "00000000-0000-4000-8000-000000000002",
  node: "00000000-0000-4000-8000-000000000003",
  outlet: "00000000-0000-4000-8000-000000000004",
}

describe("shared contracts", () => {
  it("uses model aliases instead of UUIDs in the model-facing result contract", () => {
    const valid = modelPhaseResultSchema.safeParse({
      outcome: "request_read",
      requestedReads: [{
        reason: "Follow the visible graph anchor",
        expectedEvidence: "The current node neighborhood",
        query: { anchorIds: ["node-1"] },
      }],
      citedReadIds: ["read-1"],
      unresolvedDependencies: [],
      reason: "More graph evidence is required",
      selfReview: "Only request-local aliases were used",
    })
    const invalid = modelPhaseResultSchema.safeParse({
      outcome: "continue",
      requestedReads: [],
      citedReadIds: [ids.node],
      unresolvedDependencies: [],
      reason: "A technical UUID leaked into the model result",
      selfReview: "Invalid",
    })
    const invalidFallbackAlias = modelPhaseResultSchema.safeParse({
      outcome: "request_read",
      requestedReads: [{
        reason: "Use an undeclared fallback alias",
        expectedEvidence: "Invalid graph reference",
        query: { anchorIds: ["id-1"] },
      }],
      citedReadIds: [],
      unresolvedDependencies: [],
      reason: "Fallback aliases are not part of the protocol",
      selfReview: "Invalid",
    })

    expect(valid.success).toBe(true)
    expect(invalid.success).toBe(false)
    expect(invalidFallbackAlias.success).toBe(false)
  })

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

  it("rejects read requests attached to a non-read outcome", () => {
    const modelResult = modelPhaseResultSchema.safeParse({
      outcome: "continue",
      requestedReads: [{
        reason: "This read must not run after the phase chose to continue",
        expectedEvidence: "More evidence",
      }],
      citedReadIds: [],
      unresolvedDependencies: [],
      reason: "The phase claims it can continue",
      selfReview: "The contradictory read request must be rejected",
    })

    expect(modelResult.success).toBe(false)
  })

  it("supports a blocked retrieval result when evidence cannot be obtained", () => {
    const result = phaseResultEnvelopeSchema.parse({
      schemaVersion: 1,
      envelopeId: ids.envelope,
      contextId: ids.context,
      phase: "source_retrieval",
      outcome: "blocked",
      requestedReads: [],
      citedReadIds: [],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: "The required source is outside the available budget",
      selfReview: "No missing source was treated as a fact",
    })

    expect(result.outcome).toBe("blocked")
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

  it("accepts a large graph anchor set for windowed backend processing", () => {
    const payload = graphNeighborhoodPayloadSchema.parse({
      projectId: ids.context,
      workspaceRootRef: "C:\\Worldseed\\Test",
      anchorIds: Array.from({ length: 65 }, () => ids.node),
      anchorOffset: 32,
    })

    expect(payload.anchorIds).toHaveLength(65)
    expect(payload.anchorOffset).toBe(32)
  })

  it("validates immutable evidence and workspace catalog snapshots", () => {
    const snapshot = workspaceCatalogSnapshotSchema.parse({
      snapshotId: ids.envelope,
      projectId: ids.context,
      generatedAtMs: 10,
      entries: [{
        relativePath: "设定集/readme.md",
        entryKind: "file",
        role: "settings",
        version: "digest-1",
        digest: "digest-1",
        size: 20,
      }],
      digest: "snapshot-digest",
    })
    const evidence = evidenceSchema.parse({
      evidenceId: ids.node,
      projectId: ids.context,
      contextId: ids.outlet,
      sourceKind: "workspace",
      ownerId: "设定集/readme.md",
      version: "digest-1",
      digest: "digest-1",
      locator: "设定集/readme.md",
      contentRef: "objects/documents/evidence.md",
      readReason: "Read the settings index",
      createdAtMs: 11,
    })

    expect(snapshot.entries[0]?.role).toBe("settings")
    expect(evidence.sourceKind).toBe("workspace")
  })

  it("rejects project graph thresholds that cannot trigger before capacity", () => {
    const result = projectSettingsSchema.safeParse({
      version: 2,
      execution: {
        maxModelCalls: 128,
        contextWindowTokens: 1_000_000,
        contextCompactionThresholdRatio: 0.95,
        outputTokenLimitMode: "model",
        maxWallTimeMs: 3_600_000,
        maxRetrievalRounds: 4,
      },
      retrieval: {
        maxRequestsPerRound: 10,
        maxCandidates: 20,
        maxDepth: 2,
        maxEvidenceTokens: 12000,
      },
      graph: {
        maxDirectOutDegree: 12,
        maxDirectInDegree: 12,
        mergeWarningThreshold: 13,
        preferredExpansionDepth: 2,
        maxExpansionDepth: 4,
        maxVisitedNodes: 96,
        maxVisitedLinks: 192,
        layoutMode: "layered_collision_avoidance",
      },
    })

    expect(result.success).toBe(false)
  })

  it("accepts the expanded execution budget range", () => {
    const result = projectSettingsSchema.safeParse({
      version: 2,
      execution: {
        maxModelCalls: 400,
        contextWindowTokens: 1_000_000,
        contextCompactionThresholdRatio: 0.95,
        outputTokenLimitMode: "model",
        maxWallTimeMs: 7_200_000,
        maxRetrievalRounds: 10,
      },
      retrieval: {
        maxRequestsPerRound: 10,
        maxCandidates: 20,
        maxDepth: 2,
        maxEvidenceTokens: 12_000,
      },
      graph: {
        maxDirectOutDegree: 12,
        maxDirectInDegree: 12,
        mergeWarningThreshold: 10,
        preferredExpansionDepth: 2,
        maxExpansionDepth: 4,
        maxVisitedNodes: 96,
        maxVisitedLinks: 192,
        layoutMode: "layered_collision_avoidance",
      },
    })

    expect(result.success).toBe(true)
  })

  it("rejects obsolete project settings instead of migrating them", () => {
    const obsoleteSettings = {
      version: 1,
      execution: {
        maxModelCalls: 12,
        maxTurnInputTokens: 64_000,
        maxTurnOutputTokens: 16_000,
        maxWallTimeMs: 120_000,
        maxRetrievalRounds: 3,
      },
      retrieval: {
        maxRequestsPerRound: 10,
        maxCandidates: 20,
        maxDepth: 2,
        maxEvidenceTokens: 12_000,
      },
      graph: {
        maxDirectOutDegree: 12,
        maxDirectInDegree: 12,
        mergeWarningThreshold: 10,
        preferredExpansionDepth: 2,
        maxExpansionDepth: 4,
        maxVisitedNodes: 96,
        maxVisitedLinks: 192,
        layoutMode: "layered_collision_avoidance",
      },
    }

    expect(projectSettingsSchema.safeParse(obsoleteSettings).success).toBe(false)
  })
})
