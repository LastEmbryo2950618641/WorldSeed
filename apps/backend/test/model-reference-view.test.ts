import { describe, expect, it } from "vitest"
import type { PhaseRequestEnvelope } from "@worldseed/contracts"

import { createModelReferenceView } from "../src/infrastructure/models/deepseek/model-reference-view.js"

describe("model reference view", () => {
  it("keeps the canonical read reference and hides application-only aliases", () => {
    const request = createRequest({
      readId: "evidence_1",
      canonicalReadId: "evidence_1",
      readIdAliases: ["evidence_2", "evidence_3"],
      versionKey: "revision:node_1:revision_1",
    })

    const modelRequest = createModelReferenceView(request).request as {
      input: { readEvidence: readonly Record<string, unknown>[] }
    }
    const evidence = modelRequest.input.readEvidence[0]

    expect(evidence).toMatchObject({
      readId: "evidence_1",
      versionKey: "revision:node_1:revision_1",
    })
    expect(evidence).not.toHaveProperty("canonicalReadId")
    expect(evidence).not.toHaveProperty("readIdAliases")
  })

  it("hides validation artifacts and technical scope identity from stage projections", () => {
    const request = createRequest({ readId: "evidence_1", versionKey: "immutable:source_1:digest" })
    const input = request.input as Record<string, unknown>
    input.validationArtifacts = { graph_governance: { mutations: [{ operation: "create_node" }] } }
    input.stageProjection = {
      kind: "commit_review",
      pendingScope: {
        scopeId: "00000000-0000-4000-8000-000000000099",
        candidateDigest: "candidate-digest",
      },
      projectionDigest: "projection-digest",
    }

    const modelInput = (createModelReferenceView(request).request as { input: Record<string, unknown> }).input
    const stageProjection = modelInput.stageProjection as Record<string, unknown>

    expect(modelInput.validationArtifacts).toBeUndefined()
    expect(stageProjection.pendingScope).toEqual({ candidateDigest: "candidate-digest" })
  })
})

function createRequest(evidence: Record<string, unknown>): PhaseRequestEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    turnId: "00000000-0000-4000-8000-000000000004",
    contextId: "00000000-0000-4000-8000-000000000005",
    scopeId: "00000000-0000-4000-8000-000000000006",
    phase: "interpret",
    protocolVersion: "1.0.0",
    promptRef: "prompt://interpret",
    promptDigest: "prompt-digest",
    contextViewRef: "context-view",
    committedReadIds: ["evidence_1"],
    visiblePendingIds: [],
    remainingBudget: {
      remainingCalls: 10,
      remainingInputTokens: 1000,
      remainingOutputTokens: 1000,
      deadlineAtMs: 1000,
    },
    input: {
      workflow: "turn",
      userInput: "观察周围。",
      chapterSequence: 1,
      sourceUnitIds: [],
      phaseRunIds: [],
      readEvidence: [{
        visibility: "committed",
        ownerKind: "node",
        ownerId: "node_1",
        revisionId: "revision_1",
        exactKeys: ["当前状态"],
        semanticText: "节点当前状态",
        sourceRefs: [],
        digest: "projection-digest",
        ...evidence,
      }],
      retrievalGaps: [],
      artifacts: {},
    },
  }
}
