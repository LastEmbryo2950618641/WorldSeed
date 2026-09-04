import { describe, expect, it } from "vitest"
import type { PhaseRequestEnvelope, VisibleModelContextMessage } from "@worldseed/contracts"

import { ModelContextAppender } from "../src/index.js"

describe("ModelContextAppender", () => {
  it("appends each consumer phase's dependencies once while preserving the stable chain prefix", () => {
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
    expect(secondInput.artifacts).toEqual({
      interpret: { intent: "observe" },
      rule_assembly: { selectedWorkspacePaths: [] },
    })
    expect(secondDelta.committedReadIds).toEqual(["evidence_2"])
  })

  it("omits unchanged artifacts within one phase and reappends changed artifacts", () => {
    const appender = new ModelContextAppender()
    const request = { ...createRequest(), phase: "graph_structure_plan" as const }
    const firstModelRequest = createModelRequest([], {
      draft: { contentMarkdown: "第一版正文" },
      dependency_audit: { sceneContinuity: [] },
    })
    firstModelRequest.phase = "graph_structure_plan"
    const firstDelta = appender.createDelta(request, firstModelRequest, [systemMessage()])
    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000013",
      sequence: 1,
      kind: "phase_request",
      phase: "graph_structure_plan",
      content: appender.formatDelta(firstDelta),
    })

    const unchanged = appender.createDelta(
      request,
      firstModelRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown> }
    expect(unchanged.input.artifacts).toBeUndefined()

    const changedModelRequest = createModelRequest([], {
      draft: { contentMarkdown: "第二版正文" },
      dependency_audit: { sceneContinuity: [] },
    })
    changedModelRequest.phase = "graph_structure_plan"
    const changed = appender.createDelta(
      request,
      changedModelRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown> }
    expect(changed.input.artifacts).toEqual({ draft: { contentMarkdown: "第二版正文" } })
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

  it("does not append a repeated fact version under a different read ID", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const firstEvidence = {
      ...evidence("evidence_1"),
      versionKey: "node:node_1:revision_1",
      ownerKind: "node",
      ownerId: "node_1",
      digest: "projection-a",
    }
    const repeatedEvidence = {
      ...firstEvidence,
      readId: "evidence_2",
      canonicalReadId: "evidence_1",
      readIdAliases: ["evidence_2"],
      digest: "projection-b",
    }
    const firstDelta = appender.createDelta(
      request,
      createModelRequest([firstEvidence], {}),
      [systemMessage()],
    )
    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000031",
      sequence: 1,
      kind: "phase_request",
      phase: "interpret",
      content: appender.formatDelta(firstDelta),
    })
    const secondRequest = createModelRequest([repeatedEvidence], {})
    const secondDelta = appender.createDelta(
      { ...request, phase: "rule_assembly" },
      secondRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown>; committedReadIds: readonly string[] }

    expect(secondDelta.input.readEvidence).toBeUndefined()
    expect(secondDelta.committedReadIds).toEqual([])
  })

  it("does not reappend visible legacy evidence when the current view adds a version key", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const legacyEvidence = {
      ...evidence("evidence_1"),
      ownerKind: "node",
      ownerId: "node_1",
      digest: "projection-a",
    }
    const canonicalEvidence = {
      ...legacyEvidence,
      canonicalReadId: "evidence_1",
      readIdAliases: ["evidence_2"],
      versionKey: "node:node_1:revision_1",
    }
    const firstDelta = appender.createDelta(
      request,
      createModelRequest([legacyEvidence], {}),
      [systemMessage()],
    )
    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000033",
      sequence: 1,
      kind: "phase_request",
      phase: "interpret",
      content: appender.formatDelta(firstDelta),
    })

    const secondDelta = appender.createDelta(
      { ...request, phase: "rule_assembly" },
      createModelRequest([canonicalEvidence], {}),
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown>; committedReadIds: readonly string[] }

    expect(secondDelta.input.readEvidence).toBeUndefined()
    expect(secondDelta.committedReadIds).toEqual([])
  })

  it("repeats only explicitly resurfaced evidence already visible in the chain", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const firstEvidence = {
      ...evidence("evidence_1"),
      canonicalReadId: "evidence_1",
      readIdAliases: ["evidence_2"],
      versionKey: "node:node_1:revision_1",
    }
    const firstDelta = appender.createDelta(
      request,
      createModelRequest([firstEvidence], {}),
      [systemMessage()],
    )
    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000032",
      sequence: 1,
      kind: "phase_request",
      phase: "interpret",
      content: appender.formatDelta(firstDelta),
    })
    const secondRequest = createModelRequest([firstEvidence], {})
    secondRequest.input.resurfacedReadIds = ["evidence_2"]

    const secondDelta = appender.createDelta(
      { ...request, phase: "interpret" },
      secondRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown>; committedReadIds: readonly string[] }

    expect(secondDelta.input.resurfacedReadIds).toEqual(["evidence_2"])
    expect(secondDelta.input.readEvidence).toEqual([firstEvidence])
    expect(secondDelta.committedReadIds).toEqual(["evidence_1"])
  })

  it("appends stage projections only when their canonical digest changes", () => {
    const appender = new ModelContextAppender()
    const request = createRequest()
    const projection = { kind: "graph_governance_review", projectionDigest: "projection-a", proposals: [] }
    const firstRequest = createModelRequest([], {})
    firstRequest.input.stageProjection = projection
    const firstDelta = appender.createDelta(
      { ...request, phase: "graph_governance_review" },
      firstRequest,
      [systemMessage()],
    ) as { input: Record<string, unknown> }
    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000041",
      sequence: 1,
      kind: "phase_request",
      phase: "graph_governance_review",
      content: appender.formatDelta(firstDelta),
    })

    expect(firstDelta.input.stageProjection).toEqual(projection)

    const unchanged = appender.createDelta(
      { ...request, phase: "graph_governance_review" },
      firstRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown> }
    expect(unchanged.input.stageProjection).toBeUndefined()

    const changedRequest = createModelRequest([], {})
    changedRequest.input.stageProjection = { ...projection, projectionDigest: "projection-b" }
    const changed = appender.createDelta(
      { ...request, phase: "graph_governance_review" },
      changedRequest,
      [systemMessage(), firstMessage],
    ) as { input: Record<string, unknown> }
    expect(changed.input.stageProjection).toMatchObject({ projectionDigest: "projection-b" })
  })

  it("includes synopsisDiscuss conversationHistory on the first request of a discuss turn", () => {
    const appender = new ModelContextAppender()
    const request = { ...createRequest(), phase: "synopsis_discuss" as const }
    const history = [
      { role: "user", content: "先把北桥冲突写清楚" },
      { role: "assistant", content: "已补充北桥冲突与来使动机。" },
    ]
    const modelRequest = {
      phase: "synopsis_discuss",
      protocolVersion: "1.0.0",
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: {},
      input: {
        workflow: "synopsis_discuss",
        userInput: "继续推进来使见面",
        synopsisDiscuss: {
          heading: "第二章 北地来的信使",
          chapterSequence: 2,
          synopsisMarkdown: "# 梗概\n来使抵达北桥。",
          conversationHistory: history,
          discussTrigger: "user",
        },
      },
    }

    const firstDelta = appender.createDelta(request, modelRequest, [systemMessage()]) as {
      input: Record<string, unknown>
    }
    expect(firstDelta.input.synopsisDiscuss).toEqual(modelRequest.input.synopsisDiscuss)

    const firstMessage = visibleMessage({
      messageId: "00000000-0000-4000-8000-000000000031",
      sequence: 1,
      kind: "phase_request",
      phase: "synopsis_discuss",
      content: appender.formatDelta(firstDelta),
    })
    const secondDelta = appender.createDelta(request, modelRequest, [systemMessage(), firstMessage]) as {
      input: Record<string, unknown>
    }
    expect(secondDelta.input.synopsisDiscuss).toBeUndefined()
  })

  it("includes revisionAssist conversationHistory on the first request of a revision turn", () => {
    const appender = new ModelContextAppender()
    const request = { ...createRequest(), phase: "revision_assist" as const }
    const revisionAssist = {
      chapterId: "chapter-1",
      heading: "第一章",
      committedBody: "正文定稿",
      workingBody: "正文草稿",
      conversationHistory: [
        { role: "user", content: "加强悬念" },
        { role: "assistant", content: "已在结尾埋伏笔。" },
      ],
    }
    const modelRequest = {
      phase: "revision_assist",
      protocolVersion: "1.0.0",
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: {},
      input: {
        workflow: "revision_assist",
        userInput: "再压缩一点",
        revisionAssist,
      },
    }

    const delta = appender.createDelta(request, modelRequest, [systemMessage()]) as {
      input: Record<string, unknown>
    }
    expect(delta.input.revisionAssist).toEqual(revisionAssist)
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
