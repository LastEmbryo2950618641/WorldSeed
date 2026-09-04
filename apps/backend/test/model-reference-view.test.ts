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

  it("aliases synopsisDiscuss goalIds and strips turnMonitor.taskId", () => {
    const goalId = "0b85e5ca-8976-4f22-af48-397d1d2a69cf"
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const request = createRequest({ readId: "evidence_1" })
    const input = request.input as Record<string, unknown>
    input.workflow = "synopsis"
    input.synopsisDiscuss = {
      heading: "第1章",
      chapterSequence: 1,
      synopsisMarkdown: "草稿",
      userEditedSinceAgent: false,
      conversationHistory: [],
      activeGoals: [{
        goalId,
        content: "王旗未立前先稳住欧几里得",
        lifecycle: "active",
        narrativeKind: "climax",
        scale: "short",
      }],
      chapterProgress: [{
        goalId,
        chapterSequence: 1,
        summary: "本章推向对峙",
        status: "planned",
      }],
      turnMonitor: {
        taskId,
        status: "running",
        phases: [{ phase: "interpret", status: "completed", summary: "已理解" }],
      },
    }

    const view = createModelReferenceView(request)
    const modelInput = (view.request as { input: Record<string, unknown> }).input
    const discuss = modelInput.synopsisDiscuss as {
      activeGoals: Array<{ goalId: string }>
      chapterProgress: Array<{ goalId: string }>
      turnMonitor: { status: string; taskId?: string }
    }

    expect(discuss.activeGoals[0]?.goalId).toBe("goal-1")
    expect(discuss.chapterProgress[0]?.goalId).toBe("goal-1")
    expect(discuss.turnMonitor.status).toBe("running")
    expect(discuss.turnMonitor.taskId).toBeUndefined()
    expect(view.restore({ goalId: "goal-1" })).toEqual({ goalId })
  })

  it("aliases deductionGoalBundle goalIds and strips project/progress technical ids", () => {
    const goalId = "0b85e5ca-8976-4f22-af48-397d1d2a69cf"
    const projectId = "11111111-1111-4111-8111-111111111111"
    const progressId = "22222222-2222-4222-8222-222222222222"
    const request = createRequest({ readId: "evidence_1" })
    const input = request.input as Record<string, unknown>
    input.deductionGoalBundle = {
      chapterSequence: 1,
      activeGoals: [{
        goalId,
        projectId,
        content: "稳住欧几里得",
        source: "agent",
        lifecycle: "active",
        narrativeKind: "climax",
        scale: "short",
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
      chapterProgress: [{
        progressId,
        projectId,
        goalId,
        chapterSequence: 1,
        summary: "推向对峙",
        status: "planned",
        source: "synopsis_discuss",
        recordedAtMs: 1,
        lockedAtMs: 10,
      }],
    }

    const view = createModelReferenceView(request)
    const modelInput = (view.request as { input: Record<string, unknown> }).input
    const bundle = modelInput.deductionGoalBundle as {
      activeGoals: Array<Record<string, unknown>>
      chapterProgress: Array<Record<string, unknown>>
    }

    expect(bundle.activeGoals[0]).toEqual({
      goalId: "goal-1",
      content: "稳住欧几里得",
      source: "agent",
      lifecycle: "active",
      narrativeKind: "climax",
      scale: "short",
    })
    expect(bundle.chapterProgress[0]).toEqual({
      goalId: "goal-1",
      chapterSequence: 1,
      summary: "推向对峙",
      status: "planned",
      source: "synopsis_discuss",
      lockedAtMs: 10,
    })
    expect(view.restore({ goalId: "goal-1" })).toEqual({ goalId })
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
