import { describe, expect, it } from "vitest"
import type { PhaseRequestEnvelope, VisibleModelContextMessage } from "@worldseed/contracts"

import { ModelContextAppender } from "../src/index.js"

describe("ModelContextAppender", () => {
  it("appends only new turn data, evidence, and unrepresented artifacts", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const firstModelRequest = createModelRequest([evidence("evidence_1")], {
      interpret: { intent: "observe" },
    })
    const firstDelta = appender.createDelta(request, firstModelRequest, [systemMessage()])
    const firstSerialized = JSON.stringify(firstDelta)
    const firstDeltaMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000011",
      sequence: 1,
      kind: "phase_request",
      phase: "interpret",
      content: appender.formatDelta(firstDelta),
    })
    const interpretResponse = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000012",
      sequence: 2,
      role: "assistant",
      kind: "phase_response",
      phase: "interpret",
      content: "{\"phase\":\"interpret\",\"artifact\":{\"intent\":\"observe\"}}",
    })
    const secondModelRequest = createModelRequest([
      evidence("evidence_1"),
      evidence("evidence_2"),
    ], {
      interpret: { intent: "observe" },
      rule_assembly: { selectedWorkspacePaths: [] },
    })

    const secondDelta = appender.createDelta(
      { ...request, phase: "rule_assembly" },
      secondModelRequest,
      [systemMessage(), firstDeltaMessage, interpretResponse],
    ) as Record<string, unknown>
    const secondInput = secondDelta.input as Record<string, unknown>

    expect(firstSerialized.indexOf('"workspaceCatalog"')).toBeLessThan(firstSerialized.indexOf('"readEvidence"'))
    expect(firstSerialized.indexOf('"readEvidence"')).toBeLessThan(firstSerialized.indexOf('"userInput"'))
    expect(firstSerialized.indexOf('"userInput"')).toBeLessThan(firstSerialized.indexOf('"presentation"'))
    expect(secondInput.userInput).toBeUndefined()
    expect(secondInput.workspaceCatalog).toBeUndefined()
    expect(secondInput.readEvidence).toEqual([evidence("evidence_2")])
    expect(secondInput.artifacts).toEqual({ rule_assembly: { selectedWorkspacePaths: [] } })
    expect(secondDelta.committedReadIds).toEqual(["evidence_2"])
  })

  it("appends graph capacity when it first appears and whenever it changes", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const interpretDelta = appender.createDelta(request, createModelRequest([], {}), [systemMessage()])
    const interpretMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000021",
      sequence: 1,
      kind: "phase_request",
      phase: "interpret",
      content: appender.formatDelta(interpretDelta),
    })
    const firstCapacity = {
      nodeCount: 4,
      linkCount: 3,
      maxDirectInDegree: 12,
      maxDirectOutDegree: 12,
      mergeWarningThreshold: 10,
      hotspots: [{ nodeId: "node_1", inDegree: 2, outDegree: 1 }],
    }
    const governanceRequest = createModelRequest([], {})
    governanceRequest.input.graphCapacity = firstCapacity
    const governanceDelta = appender.createDelta(
      { ...request, phase: "graph_governance" },
      governanceRequest,
      [systemMessage(), interpretMessage],
    ) as Record<string, unknown>
    const governanceInput = governanceDelta.input as Record<string, unknown>
    const governanceMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000022",
      sequence: 2,
      kind: "phase_request",
      phase: "graph_governance",
      content: appender.formatDelta(governanceDelta),
    })

    expect((interpretDelta as { input: Record<string, unknown> }).input.graphCapacity).toBeUndefined()
    expect(governanceInput.graphCapacity).toEqual(firstCapacity)

    const unchangedDelta = appender.createDelta(
      { ...request, phase: "semantic_review" },
      governanceRequest,
      [systemMessage(), interpretMessage, governanceMessage],
    ) as { input: Record<string, unknown> }
    expect(unchangedDelta.input.graphCapacity).toBeUndefined()

    const changedRequest = createModelRequest([], {})
    changedRequest.input.graphCapacity = {
      ...firstCapacity,
      linkCount: 4,
      hotspots: [{ nodeId: "node_1", inDegree: 2, outDegree: 2 }],
    }
    const changedDelta = appender.createDelta(
      { ...request, phase: "semantic_review" },
      changedRequest,
      [systemMessage(), interpretMessage, governanceMessage],
    ) as { input: Record<string, unknown> }
    expect(changedDelta.input.graphCapacity).toEqual(changedRequest.input.graphCapacity)
  })
})

function createRequest(): PhaseRequestEnvelope {
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
    input: {},
  }
}

function createModelRequest(readEvidence: readonly unknown[], artifacts: Record<string, unknown>) {
  return {
    phase: "interpret",
    protocolVersion: "1.0.0",
    committedReadIds: readEvidence.map((item) => (item as { readId: string }).readId),
    visiblePendingIds: [],
    remainingBudget: {},
    input: {
      workflow: "turn",
      userInput: "观察周围。",
      chapterSequence: 1,
      allowWorkspaceChapterReads: true,
      presentation: { minimumWordCount: 2000, maximumWordCount: 3000 },
      projectSettings: { execution: {} },
      workspaceCatalog: { entries: [{ relativePath: "设定集/readme.md" }] },
      readEvidence,
      artifacts,
    },
  }
}

function evidence(readId: string) {
  return {
    readId,
    visibility: "committed",
    ownerKind: "workspace:setting",
    ownerId: "设定集/readme.md",
    exactKeys: ["设定索引"],
    semanticText: "设定索引",
    digest: `${readId}-digest`,
  }
}

function systemMessage(): VisibleModelContextMessage {
  return {
    messageId: "00000000-0000-4000-8000-000000000010",
    sequence: 0,
    role: "system",
    kind: "system_rules",
    content: "system rules",
  }
}

function visibleMessage(
  input: Omit<VisibleModelContextMessage, "taskId" | "turnId">,
): VisibleModelContextMessage {
  return {
    ...input,
    taskId: "00000000-0000-4000-8000-000000000003",
    turnId: "00000000-0000-4000-8000-000000000004",
  }
}
