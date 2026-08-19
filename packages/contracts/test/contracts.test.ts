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
  backendPayloadSchemas,
  backendMethodSchema,
  historyManifestSchema,
  runtimeMetricSchema,
  turnStartPayloadSchema,
} from "../src/index.js"

const ids = {
  envelope: "00000000-0000-4000-8000-000000000001",
  context: "00000000-0000-4000-8000-000000000002",
  node: "00000000-0000-4000-8000-000000000003",
  outlet: "00000000-0000-4000-8000-000000000004",
}

describe("shared contracts", () => {
  it("allows a turn acceptance run to disable workspace chapter reads", () => {
    const payload = turnStartPayloadSchema.parse({
      projectId: ids.context,
      workspaceRootRef: "C:\\Worldseed\\Acceptance",
      userInput: "Continue from persisted world state",
      chapterSequence: 21,
      allowWorkspaceChapterReads: false,
    })

    expect(payload.allowWorkspaceChapterReads).toBe(false)
  })

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

  it("accepts project-level permanent IDs without weakening technical UUID contracts", () => {
    expect(modelPhaseResultSchema.safeParse({
      outcome: "request_read",
      requestedReads: [{
        reason: "Follow the persisted graph identity",
        expectedEvidence: "The current node neighborhood",
        query: { anchorIds: ["node_12"] },
      }],
      citedReadIds: ["evidence_9"],
      unresolvedDependencies: [],
      reason: "Permanent IDs are stable across requests",
      selfReview: "The supplied IDs were reused unchanged",
    }).success).toBe(true)

    expect(graphMutationSchema.safeParse({
      operation: "create_link",
      link: {
        id: "link_4",
        fromNodeId: "node_12",
        toNodeId: "node_13",
        sourceRefs: [{ sourceId: "source_3" }],
      },
    }).success).toBe(true)
    expect(evidenceSchema.safeParse({
      evidenceId: "evidence_9",
      projectId: ids.context,
      sourceKind: "graph",
      ownerId: "node_12",
      version: "revision_7",
      digest: "digest",
      locator: "projection",
      contentRef: "content",
      readReason: "test",
      createdAtMs: 1,
    }).success).toBe(true)
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

  it("preserves provider reasoning display metadata in stored phase results", () => {
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
      reason: "The source is unavailable",
      selfReview: "No unavailable source was treated as fact",
      modelReasoning: "**Checking available sources**",
      modelReasoningKind: "provider_summary",
    })

    expect(result.modelReasoning).toBe("**Checking available sources**")
    expect(result.modelReasoningKind).toBe("provider_summary")
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
        contextCompactionThresholdRatio: 0.97,
        contextCompressionTargetRatio: 0.5,
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
        contextCompactionThresholdRatio: 0.97,
        contextCompressionTargetRatio: 0.5,
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

  it("requires idempotency IDs for history mutations", () => {
    const base = { projectId: ids.context, workspaceRootRef: "C:\\Worldseed\\Test" }
    expect(backendPayloadSchemas["history.saveManual"].safeParse({ ...base, name: "保存点" }).success).toBe(false)
    expect(backendPayloadSchemas["history.restore"].safeParse({ ...base, entryId: ids.envelope }).success).toBe(false)
    expect(backendPayloadSchemas["history.saveManual"].safeParse({
      ...base,
      operationId: ids.outlet,
      name: "保存点",
    }).success).toBe(true)
  })

  it("accepts explicit runtime metric resets as a separate backend command", () => {
    expect(backendMethodSchema.safeParse("turn.metrics.reset").success).toBe(true)
    expect(backendPayloadSchemas["turn.metrics.reset"].safeParse({
      taskId: ids.context,
      metricIds: ["model_calls", "wall_time"],
    }).success).toBe(true)
  })

  it("keeps automatic context compression outside user-resettable runtime metrics", () => {
    const metric = {
      metricId: "context_tokens",
      label: "活动上下文",
      scope: "context_window",
      unit: "tokens",
      current: 970_000,
      limit: 970_000,
      cumulative: 970_000,
      state: "exhausted",
      blocking: false,
      resettable: false,
      resetGeneration: 0,
      lastResetAt: null,
      description: "发送前自动机械压缩",
    }
    expect(runtimeMetricSchema.safeParse({ ...metric, resetMode: "provider_fixed" }).success).toBe(true)
    expect(runtimeMetricSchema.safeParse({ ...metric, resetMode: "compact_context" }).success).toBe(false)
  })

  it("captures the active model context in a history manifest", () => {
    expect(historyManifestSchema.safeParse({
      schemaVersion: 1,
      projectId: ids.context,
      entryId: ids.envelope,
      branchId: ids.node,
      createdAtMs: 10,
      committedSequence: 1,
      activeGeneration: 0,
      activeScopeIds: [ids.outlet],
      nodeHeads: [],
      linkHeads: [],
      documentHeads: [],
      canonicalChapters: [],
      modelContext: {
        chainId: ids.envelope,
        messages: [{
          messageId: ids.node,
          chainId: ids.envelope,
          projectId: ids.context,
          sequence: 0,
          role: "system",
          kind: "system_rules",
          content: "rules",
          contentDigest: "digest",
          tokenEstimate: 1,
          createdAtMs: 1,
        }],
      },
      workspace: [],
      baseRulesDigest: "base-digest",
      digest: "manifest-digest",
    }).success).toBe(true)
  })
})
