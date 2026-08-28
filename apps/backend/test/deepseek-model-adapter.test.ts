import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"

import { defaultDeepSeekRuntimeConfig } from "@worldseed/config"
import { PROTOCOL_VERSION, type PhaseRequestEnvelope, type PhaseResultEnvelope } from "@worldseed/contracts"
import { APIConnectionError } from "openai"
import { describe, expect, it } from "vitest"

import {
  DeepSeekAiModelAdapter,
  FakeAiModelAdapter,
  NodePromptResourceAdapter,
  UnavailableAiModelAdapter,
  createModelFromEnvironment,
  createModelFromSelection,
  type DeepSeekCompletionClient,
} from "../src/index.js"

const promptRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))

describe("DeepSeekAiModelAdapter", () => {
  it("creates a runtime adapter from the model selected in the desktop UI", () => {
    const adapter = createModelFromSelection(promptRoot, {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "ui-selected-key",
      contextWindowTokens: 1_000_000,
    })

    expect(adapter.info).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", available: true })
  })

  it("appends the phase tail to inherited context without rebuilding the stable prefix", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let completionMessages: readonly { role: string; content: string }[] = []
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        completionMessages = input.messages
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const promptReads: string[] = []
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      {
        loadBaseRules: () => {
          promptReads.push("base")
          throw new Error("Inherited context must not reload base rules")
        },
        loadTurnSystemRules: () => {
          promptReads.push("turn-system")
          throw new Error("Inherited context must not reload turn system rules")
        },
        loadPlotSynopsisGuide: () => Promise.reject(new Error("unused")),
        loadSettingsQueryGuide: () => Promise.reject(new Error("unused")),
        loadSettingsRevisionGuide: () => Promise.reject(new Error("unused")),
        loadSynopsisDiscussSystemRules: () => Promise.reject(new Error("unused")),
        loadPhase: () => {
          promptReads.push("phase")
          throw new Error("Prepared phase prompt must not be reloaded")
        },
      },
      client,
    )
    const inheritedMessages = [
      {
        messageId: randomUUID(),
        sequence: 0,
        role: "system" as const,
        kind: "system_rules" as const,
        content: "stable system rules",
      },
      {
        messageId: randomUUID(),
        sequence: 1,
        role: "assistant" as const,
        kind: "canonical_chapter" as const,
        content: "# 第一章 已提交正文",
      },
    ]

    const execution = await adapter.execute(request, {
      contextChainId: randomUUID(),
      contextMessages: inheritedMessages,
      phasePrompt: {
        ref: "phase://interpret",
        version: "test",
        digest: "phase-digest",
        text: "prepared phase instruction",
      },
    })

    expect(promptReads).toEqual([])
    expect(completionMessages.slice(0, 2)).toEqual(inheritedMessages.map(({ role, content }) => ({ role, content })))
    expect(completionMessages).toHaveLength(6)
    expect(completionMessages.slice(2).map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
      "user",
    ])
    const outputReminder = completionMessages.at(-1)?.content ?? ""
    expect(outputReminder.indexOf("FINAL PHASE-SPECIFIC REQUIREMENTS FOR interpret:"))
      .toBeGreaterThan(outputReminder.indexOf("complete model-facing result schema"))
    expect(execution.contextExchange?.requestMessages.map((message) => message.kind)).toEqual([
      "phase_request",
      "phase_instruction",
      "phase_protocol",
      "phase_request",
    ])
    expect(execution.contextExchange?.responseMessage.content).toBe(JSON.stringify(toModelResult(fake.result)))
  })

  it("normalizes legacy system messages after the stable system prefix", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let completionMessages: readonly { role: string; content: string }[] = []
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          completionMessages = input.messages
          return Promise.resolve({
            content: JSON.stringify(toModelResult(fake.result)),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )
    const inheritedMessages = [
      {
        messageId: randomUUID(),
        sequence: 0,
        role: "system" as const,
        kind: "system_rules" as const,
        content: "stable system rules",
      },
      {
        messageId: randomUUID(),
        sequence: 1,
        role: "system" as const,
        kind: "phase_instruction" as const,
        phase: "interpret" as const,
        content: "legacy phase instruction",
      },
      {
        messageId: randomUUID(),
        sequence: 2,
        role: "assistant" as const,
        kind: "phase_response" as const,
        phase: "interpret" as const,
        content: "legacy phase response",
      },
    ]

    await adapter.execute(request, {
      contextChainId: randomUUID(),
      contextMessages: inheritedMessages,
      phasePrompt: { ref: "phase://interpret", version: "test", digest: "interpret", text: "interpret" },
    })

    expect(completionMessages.slice(0, 3)).toEqual([
      { role: "system", content: "stable system rules" },
      { role: "user", content: "legacy phase instruction" },
      { role: "assistant", content: "legacy phase response" },
    ])
    expect(completionMessages.filter((message) => message.role === "system")).toHaveLength(1)
  })

  it("keeps an exact message prefix and appends only newly visible evidence", async () => {
    const turnId = randomUUID()
    const taskId = randomUUID()
    const firstEvidence = modelEvidence("evidence_1", "first evidence")
    const secondEvidence = modelEvidence("evidence_2", "second evidence")
    const firstRequest = createRequest({
      taskId,
      turnId,
      committedReadIds: ["evidence_1"],
      input: {
        workflow: "turn",
        userInput: "只在本轮第一次追加的用户输入",
        chapterSequence: 1,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [firstEvidence],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const fake = new FakeAiModelAdapter(randomUUID)
    const firstResult = await fake.execute(firstRequest)
    const secondRequest = createRequest({
      taskId,
      turnId,
      phase: "rule_assembly",
      committedReadIds: ["evidence_1", "evidence_2"],
      input: {
        ...(firstRequest.input as Record<string, unknown>),
        readEvidence: [firstEvidence, secondEvidence],
        artifacts: { interpret: firstResult.result.artifact },
      },
    })
    const secondResult = await fake.execute(secondRequest)
    const captured: Array<readonly { role: "system" | "user" | "assistant"; content: string }[]> = []
    const responses = [firstResult.result, secondResult.result]
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        captured.push(input.messages)
        const response = responses[captured.length - 1]
        if (response === undefined) throw new Error("Missing model response fixture")
        return Promise.resolve({
          content: JSON.stringify(toModelResult(response)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )
    const system = {
      messageId: randomUUID(),
      sequence: 0,
      role: "system" as const,
      kind: "system_rules" as const,
      content: "stable system rules",
    }
    const firstExecution = await adapter.execute(firstRequest, {
      contextChainId: randomUUID(),
      contextMessages: [system],
      phasePrompt: { ref: "phase://interpret", version: "test", digest: "interpret", text: "interpret" },
    })
    const firstExchange = firstExecution.contextExchange
    if (firstExchange === undefined) throw new Error("Expected a persisted context exchange")
    const inherited = [
      system,
      ...firstExchange.requestMessages.map((message, index) => ({
        messageId: randomUUID(),
        sequence: index + 1,
        role: message.role,
        kind: message.kind,
        taskId: message.taskId,
        turnId: message.turnId,
        phase: message.phase,
        content: message.content as string,
      })),
      {
        messageId: randomUUID(),
        sequence: firstExchange.requestMessages.length + 1,
        role: firstExchange.responseMessage.role,
        kind: firstExchange.responseMessage.kind,
        taskId: firstExchange.responseMessage.taskId,
        turnId: firstExchange.responseMessage.turnId,
        phase: firstExchange.responseMessage.phase,
        content: firstExchange.responseMessage.content as string,
      },
    ]
    const secondExecution = await adapter.execute(secondRequest, {
      contextChainId: randomUUID(),
      contextMessages: inherited,
      phasePrompt: { ref: "phase://rule", version: "test", digest: "rule", text: "rule assembly" },
    })
    const secondDelta = secondExecution.contextExchange?.requestMessages[0]?.content ?? ""

    expect(captured[1]?.slice(0, inherited.length)).toEqual(
      inherited.map(({ role, content }) => ({ role, content })),
    )
    expect(secondDelta).toContain("evidence_2")
    expect(secondDelta).not.toContain("evidence_1")
    const secondDeltaInput = JSON.parse(
      secondDelta.slice("Worldseed context delta JSON:\n".length),
    ) as { input?: { userInput?: unknown; artifacts?: Record<string, unknown> } }
    expect(secondDeltaInput.input?.userInput).toBeUndefined()
    expect(secondDeltaInput.input?.artifacts?.interpret).toEqual(firstResult.result.artifact)
  })

  it("sends model aliases instead of technical UUIDs and restores returned aliases", async () => {
    const readId = randomUUID()
    const graphOwnerId = randomUUID()
    const graphRevisionId = randomUUID()
    const sourceId = randomUUID()
    const request = createRequest({
      committedReadIds: [readId],
      input: {
        userInput: "继续观察。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "node",
          ownerId: graphOwnerId,
          revisionId: graphRevisionId,
          exactKeys: ["旧钟楼"],
          semanticText: "旧钟楼节点",
          sourceRefs: [{ sourceId }],
          digest: "graph-digest",
          stateRole: "current",
          committedSequence: 7,
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let input: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (completionInput) => {
        input = completionInput
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "request_read",
            artifact: {
              workflow: "turn",
              userIntent: "继续观察",
              worldIntent: "延续当前场景",
              presentationIntent: "plain",
              userClaims: [],
              requiredTimeAnchor: true,
              requiredLocationAnchor: true,
              initialReadHypotheses: [],
            },
            requestedReads: [{
              reason: "读取钟楼图节点",
              expectedEvidence: "旧钟楼节点",
              query: { anchorIds: ["node-1"] },
            }],
            citedReadIds: ["read-1"],
            unresolvedDependencies: [],
            reason: "已读取当前证据",
            selfReview: "只使用模型可见别名",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    const sentMessages = input?.messages.map((message) => message.content).join("\n") ?? ""
    expect(sentMessages).not.toContain(readId)
    expect(sentMessages).not.toContain(graphOwnerId)
    expect(sentMessages).not.toContain(graphRevisionId)
    expect(sentMessages).not.toContain(sourceId)
    expect(sentMessages).not.toContain('"revisionId"')
    expect(sentMessages).not.toContain('"sourceRefs"')
    expect(sentMessages).not.toContain(request.projectId)
    expect(sentMessages).not.toContain(request.taskId)
    expect(sentMessages).not.toContain('"format":"uuid"')
    expect(sentMessages).toContain("read-1")
    expect(sentMessages).toContain("node-1")
    expect(sentMessages).toContain('"committedSequence":7')
    expect(sentMessages).toContain("larger committedSequence means a later committed world state")
    expect(execution.result.citedReadIds).toEqual([readId])
    expect(execution.result.requestedReads[0]?.query.anchorIds).toEqual([graphOwnerId])
  })

  it("exposes source positions and restores source-boundary read aliases", async () => {
    const readId = randomUUID()
    const sourceId = randomUUID()
    const sourceUnitId = randomUUID()
    const request = createRequest({
      phase: "source_retrieval",
      promptRef: "v1:source_retrieval",
      committedReadIds: [readId],
      input: {
        userInput: "从既有剧情末端继续。",
        chapterSequence: 2,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "source",
          ownerId: sourceUnitId,
          revisionId: sourceUnitId,
          exactKeys: ["开篇"],
          semanticText: "这是来源开篇，不是末端。",
          sourceRefs: [{ sourceId, sourceUnitId, sequence: 0 }],
          sourcePosition: {
            sourceRef: sourceId,
            sequence: 0,
            firstSequence: 0,
            lastSequence: 9,
            unitCount: 10,
            isStart: true,
            isEnd: false,
          },
          digest: "source-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let input: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (completionInput) => {
        input = completionInput
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "request_read",
            artifact: { missingEvidence: ["来源末端"], nextExpansionHints: ["读取同一来源末端"] },
            requestedReads: [{
              reason: "当前命中是开篇，需要同一不可变来源的末端窗口",
              expectedEvidence: "该来源最后的连续原文",
              query: { sourceIds: ["source-1"], sourceBoundary: "end", sourceKinds: ["source"] },
            }],
            citedReadIds: ["read-1"],
            unresolvedDependencies: [],
            reason: "开篇不能代表结尾",
            selfReview: "按机械来源顺序继续读取",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    const sentMessages = input?.messages.map((message) => message.content).join("\n") ?? ""
    expect(sentMessages).toContain('"sourcePosition"')
    expect(sentMessages).toContain('"sourceRef":"source-1"')
    expect(sentMessages).toContain('"isEnd":false')
    expect(sentMessages).toContain("sourceBoundary=end")
    expect(execution.result.requestedReads[0]?.query.sourceIds).toEqual([sourceId])
    expect(execution.result.requestedReads[0]?.query.sourceBoundary).toBe("end")
  })

  it("passes permanent evidence and graph IDs through without request-local aliases", async () => {
    const request = createRequest({
      committedReadIds: ["evidence_9"],
      input: {
        userInput: "继续观察。",
        chapterSequence: 2,
        sourceId: "source_3",
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId: "evidence_9",
          visibility: "committed",
          ownerKind: "node",
          ownerId: "node_12",
          revisionId: "revision_7",
          exactKeys: ["旧钟楼"],
          semanticText: "旧钟楼当前状态",
          sourceRefs: [{ sourceId: "source_3" }],
          digest: "graph-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.map((message) => message.content).join("\n")
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "request_read",
            artifact: {
              workflow: "turn",
              userIntent: "继续观察",
              worldIntent: "延续当前场景",
              presentationIntent: "plain",
              userClaims: [],
              requiredTimeAnchor: true,
              requiredLocationAnchor: true,
              initialReadHypotheses: [],
            },
            requestedReads: [{
              reason: "读取钟楼图节点",
              expectedEvidence: "旧钟楼节点",
              query: { anchorIds: ["node_12"] },
            }],
            citedReadIds: ["evidence_9"],
            unresolvedDependencies: [],
            reason: "复用持久身份",
            selfReview: "没有生成临时别名",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(finalMessage).toContain("evidence_9")
    expect(finalMessage).toContain("node_12")
    expect(finalMessage).not.toContain("read-1")
    expect(finalMessage).not.toContain("node-1")
    expect(execution.result.citedReadIds).toEqual(["evidence_9"])
    expect(execution.result.requestedReads[0]?.query.anchorIds).toEqual(["node_12"])
  })

  it("keeps source-unit return paths internal while exposing source evidence by read alias", async () => {
    const readId = randomUUID()
    const sourceId = randomUUID()
    const sourceUnitId = randomUUID()
    const relatedNodeId = randomUUID()
    const request = createRequest({
      committedReadIds: [readId],
      input: {
        userInput: "回忆纸库里发生过什么。",
        chapterSequence: 18,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "source",
          ownerId: sourceUnitId,
          revisionId: sourceUnitId,
          exactKeys: ["纸库的灯亮着"],
          semanticText: "纸库的灯亮着，蓝工装人从库里抱出旧簿册。",
          sourceRefs: [{ sourceId, sourceUnitId, sequence: 18 }],
          relatedOwnerRefs: [{
            ownerKind: "node",
            ownerId: relatedNodeId,
            exactKeys: ["纸库"],
            semanticText: "纸库门口的封条与旧簿册入口",
          }],
          digest: "source-unit-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.map((message) => message.content).join("\n")
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              workflow: "query",
              userIntent: "回忆纸库历史",
              worldIntent: "只回答已发生事实",
              presentationIntent: "plain",
              userClaims: [],
              requiredTimeAnchor: false,
              requiredLocationAnchor: false,
              initialReadHypotheses: [],
            },
            requestedReads: [],
            citedReadIds: ["read-1"],
            unresolvedDependencies: [],
            reason: "原文单元证据已足够",
            selfReview: "仅通过证据别名引用原文单元",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(finalMessage).toContain("read-1")
    expect(finalMessage).toContain("纸库的灯亮着")
    expect(finalMessage).toContain("relatedOwnerRefs")
    expect(finalMessage).toContain("node-1")
    expect(finalMessage).toContain("纸库门口的封条与旧簿册入口")
    expect(finalMessage).not.toContain(sourceId)
    expect(finalMessage).not.toContain(sourceUnitId)
    expect(finalMessage).not.toContain(relatedNodeId)
    expect(finalMessage).not.toContain('"sourceRefs"')
    expect(finalMessage).not.toContain('"revisionId"')
    expect(execution.result.citedReadIds).toEqual([readId])
  })

  it("does not instruct planning phases to invent local graph handles", async () => {
    const request = createRequest({ phase: "emergence_planning" })
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(finalMessage).toContain("Do not use local:* references in this phase")
    expect(finalMessage).toContain("New graph identities may be declared only by graph_structure_plan or graph_capacity_rewrite")
  })

  it("normalizes one-based dependency scene indexes before cross-phase validation", async () => {
    const request = createRequest({
      phase: "dependency_audit",
      input: {
        userInput: "继续观察当前场景。",
        chapterSequence: 3,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "continue",
          artifact: {
            missingDependencies: [],
            unplannedContent: [],
            sceneContinuity: [{
              sceneIndex: 1,
              sceneDescription: "当前场景",
              predecessorSceneIndexes: [0],
              predecessorSceneRefs: ["node-1"],
              predecessorRequired: true,
              predecessorReason: "承接上一场景",
              correspondenceRequired: false,
              correspondenceReason: "同一地点连续观察",
              timeContinuity: "pass",
              locationContinuity: "pass",
              crossReferenceContinuity: "pass",
              reason: "当前场景与前文连续",
            }],
            informationBoundary: "pass",
          },
          requestedReads: [],
          citedReadIds: [],
          unresolvedDependencies: [],
          reason: "审计完成",
          selfReview: "场景索引采用一基编号",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.artifact).toMatchObject({
      sceneContinuity: [{ sceneIndex: 0, predecessorSceneIndexes: [0] }],
    })
  })

  it("requires dependency audit scenes when a turn already has narrative source units", async () => {
    let finalMessage = ""
    const request = createRequest({
      phase: "dependency_audit",
      input: {
        workflow: "turn",
        userInput: "继续推演当前章节。",
        chapterSequence: 11,
        sourceId: randomUUID(),
        sourceUnitIds: Array.from({ length: 3 }, () => randomUUID()),
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          finalMessage = input.messages.at(-1)?.content ?? ""
          return Promise.resolve({ content: "{}", usage: { prompt_tokens: 10, completion_tokens: 5 } })
        },
      },
    )

    await expect(adapter.execute(request)).rejects.toThrow("could not satisfy the phase contract")

    expect(finalMessage).toContain("workflow=turn")
    expect(finalMessage).toContain("currently has 3 persisted narrative source unit(s)")
    expect(finalMessage).toContain("sceneContinuity must not be empty")
    expect(finalMessage).toContain("indexes exactly: 0, 1, 2")
    expect(finalMessage).toContain("same subject, action or state, and result")
    expect(finalMessage).not.toContain("This background evolution has no narrative source units")
  })

  it("repairs incomplete staged spacetime transitions before accepting the phase", async () => {
    const fake = new FakeAiModelAdapter(randomUUID)
    const sourceUnitIds = [randomUUID()]
    const baseInput = {
      workflow: "turn" as const,
      userInput: "从上一场景继续前往老渡口。",
      chapterSequence: 21,
      sourceId: randomUUID(),
      sourceUnitIds,
      phaseRunIds: [],
      readEvidence: [],
      retrievalGaps: [],
      artifacts: {},
    }
    const dependencyRequest = createRequest({ phase: "dependency_audit", input: baseInput })
    const dependencyExecution = await fake.execute(dependencyRequest)
    const dependency = {
      ...dependencyExecution.result.artifact as Record<string, unknown>,
      sceneContinuity: [{
        ...(dependencyExecution.result.artifact as { sceneContinuity: readonly Record<string, unknown>[] }).sceneContinuity[0],
        predecessorRequired: true,
        predecessorSceneIndexes: [],
        predecessorSceneRefs: ["local:occurrence"],
      }],
    }
    const structureRequest = createRequest({
      phase: "graph_structure_plan",
      input: { ...baseInput, artifacts: { dependency_audit: dependency } },
    })
    const structureExecution = await fake.execute(structureRequest)
    const request = createRequest({
      phase: "graph_spacetime_settlement",
      input: {
        ...baseInput,
        artifacts: {
          dependency_audit: dependency,
          graph_structure_plan: structureExecution.result.artifact,
        },
      },
    })
    const validExecution = await fake.execute(request)
    const validArtifact = validExecution.result.artifact as {
      sceneSpacetimeBindings: readonly Record<string, unknown>[]
    }
    let calls = 0
    let firstRequestTail = ""
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          calls += 1
          if (calls === 1) firstRequestTail = input.messages.at(-1)?.content ?? ""
          const artifact = {
            ...validArtifact,
            sceneSpacetimeBindings: validArtifact.sceneSpacetimeBindings.map((binding) => ({
              ...binding,
              predecessorSceneAnchorRefs: ["local:occurrence"],
              transitionPathRefs: calls === 1 ? [] : ["local:occurrence"],
            })),
          }
          return Promise.resolve({
            content: JSON.stringify({ ...toModelResult(validExecution.result), artifact }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(firstRequestTail).toContain("Scene 0: predecessorSceneIndexes must equal []")
    expect(firstRequestTail).toContain("predecessorSceneAnchorRefs must be non-empty")
    expect(firstRequestTail).toContain("transitionPathRefs must be non-empty")
    expect(firstRequestTail).toContain("When a predecessorSceneRef is evidence")
    expect(firstRequestTail).not.toContain("predecessorSceneRefs are evidence references")
    expect(execution.result.artifact).toMatchObject({
      sceneSpacetimeBindings: [{ transitionPathRefs: ["local:occurrence"] }],
    })
  })

  it("repairs staged world effects that have no effective scene", async () => {
    const fake = new FakeAiModelAdapter(randomUUID)
    const sourceUnitIds = [randomUUID()]
    const baseInput = {
      workflow: "turn" as const,
      userInput: "让渡口外的风暴改变沿岸局势。",
      chapterSequence: 21,
      sourceId: randomUUID(),
      sourceUnitIds,
      phaseRunIds: [],
      readEvidence: [],
      retrievalGaps: [],
      artifacts: {},
    }
    const dependencyExecution = await fake.execute(createRequest({ phase: "dependency_audit", input: baseInput }))
    const structureExecution = await fake.execute(createRequest({
      phase: "graph_structure_plan",
      input: {
        ...baseInput,
        artifacts: { dependency_audit: dependencyExecution.result.artifact },
      },
    }))
    const request = createRequest({
      phase: "graph_spacetime_settlement",
      input: {
        ...baseInput,
        artifacts: {
          dependency_audit: dependencyExecution.result.artifact,
          graph_structure_plan: structureExecution.result.artifact,
        },
      },
    })
    const validExecution = await fake.execute(request)
    const validArtifact = validExecution.result.artifact as {
      proposalSettlements: readonly Record<string, unknown>[]
    }
    let calls = 0
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: () => {
          calls += 1
          const artifact = calls === 1
            ? {
                ...validArtifact,
                proposalSettlements: validArtifact.proposalSettlements.map((settlement) => ({
                  ...settlement,
                  effectDisposition: "world_effect",
                  effectiveSceneBindingIndexes: [],
                  effectiveExistingSceneAnchorRefs: [],
                })),
              }
            : validArtifact
          return Promise.resolve({
            content: JSON.stringify({ ...toModelResult(validExecution.result), artifact }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.artifact).toEqual(validArtifact)
  })

  it("repairs an undeclared local handle in staged graph retrieval design", async () => {
    const fake = new FakeAiModelAdapter(randomUUID)
    const sourceUnitIds = [randomUUID()]
    const baseInput = {
      workflow: "turn" as const,
      userInput: "继续当前场景。",
      chapterSequence: 21,
      sourceId: randomUUID(),
      sourceUnitIds,
      phaseRunIds: [],
      readEvidence: [],
      retrievalGaps: [],
      artifacts: {},
    }
    const dependencyExecution = await fake.execute(createRequest({ phase: "dependency_audit", input: baseInput }))
    const structureExecution = await fake.execute(createRequest({
      phase: "graph_structure_plan",
      input: { ...baseInput, artifacts: { dependency_audit: dependencyExecution.result.artifact } },
    }))
    const spacetimeExecution = await fake.execute(createRequest({
      phase: "graph_spacetime_settlement",
      input: {
        ...baseInput,
        artifacts: {
          dependency_audit: dependencyExecution.result.artifact,
          graph_structure_plan: structureExecution.result.artifact,
        },
      },
    }))
    const request = createRequest({
      phase: "graph_retrieval_design",
      input: {
        ...baseInput,
        artifacts: {
          graph_structure_plan: structureExecution.result.artifact,
          graph_spacetime_settlement: spacetimeExecution.result.artifact,
        },
      },
    })
    const validExecution = await fake.execute(request)
    let calls = 0
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: () => {
          calls += 1
          const validArtifact = validExecution.result.artifact as {
            sourceSettlements: readonly Readonly<{
              graphRefs: readonly Readonly<{ targetKind: "node" | "link"; targetRef: string; proposalRef?: string }>[]
            }>[]
          }
          const artifact = calls === 1
            ? {
                ...validArtifact,
                sourceSettlements: validArtifact.sourceSettlements.map((settlement, index) => index === 0
                  ? { ...settlement, graphRefs: [{ targetKind: "node", targetRef: "local:stale_handle" }] }
                  : settlement),
              }
            : validArtifact
          return Promise.resolve({
            content: JSON.stringify({ ...toModelResult(validExecution.result), artifact }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(JSON.stringify(execution.result.artifact)).not.toContain("local:stale_handle")
  })

  it("repairs a read-evidence ID used as a staged graph spacetime reference", async () => {
    const fake = new FakeAiModelAdapter(randomUUID)
    const sourceUnitIds = [randomUUID()]
    const baseInput = {
      workflow: "turn" as const,
      userInput: "继续当前场景。",
      chapterSequence: 21,
      sourceId: randomUUID(),
      sourceUnitIds,
      phaseRunIds: [],
      readEvidence: [{
        readId: "evidence_1",
        visibility: "committed" as const,
        ownerKind: "node",
        ownerId: "node_1",
        exactKeys: ["当前时间锚"],
        semanticText: "当前时间锚",
        sourceRefs: [],
        digest: "evidence-digest",
      }],
      retrievalGaps: [],
      artifacts: {},
    }
    const dependencyExecution = await fake.execute(createRequest({ phase: "dependency_audit", input: baseInput }))
    const structureExecution = await fake.execute(createRequest({
      phase: "graph_structure_plan",
      input: { ...baseInput, artifacts: { dependency_audit: dependencyExecution.result.artifact } },
    }))
    const request = createRequest({
      phase: "graph_spacetime_settlement",
      committedReadIds: ["evidence_1"],
      input: {
        ...baseInput,
        artifacts: {
          dependency_audit: dependencyExecution.result.artifact,
          graph_structure_plan: structureExecution.result.artifact,
        },
      },
    })
    const validExecution = await fake.execute(request)
    const validArtifact = validExecution.result.artifact as {
      sceneSpacetimeBindings: readonly Record<string, unknown>[]
    }
    let calls = 0
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: () => {
          calls += 1
          const artifact = {
            ...validArtifact,
            sceneSpacetimeBindings: validArtifact.sceneSpacetimeBindings.map((binding) => ({
              ...binding,
              temporalReferenceRefs: [calls === 1 ? "evidence_1" : "node_1"],
            })),
          }
          return Promise.resolve({
            content: JSON.stringify({ ...toModelResult(validExecution.result), artifact }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.artifact).toMatchObject({
      sceneSpacetimeBindings: [{ temporalReferenceRefs: ["node_1"] }],
    })
  })

  it("allows an empty dependency scene list only for background evolution without narrative sources", async () => {
    let finalMessage = ""
    const request = createRequest({
      phase: "dependency_audit",
      input: {
        workflow: "evolution",
        userInput: "推进已到期的世界前沿。",
        chapterSequence: 11,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          finalMessage = input.messages.at(-1)?.content ?? ""
          return Promise.resolve({ content: "{}", usage: { prompt_tokens: 10, completion_tokens: 5 } })
        },
      },
    )

    await expect(adapter.execute(request)).rejects.toThrow("could not satisfy the phase contract")

    expect(finalMessage).toContain("workflow=evolution")
    expect(finalMessage).toContain("currently has 0 persisted narrative source unit(s)")
    expect(finalMessage).toContain("sceneContinuity may be empty")
    expect(finalMessage).not.toContain("sceneContinuity must not be empty")
  })

  it("explains external predecessors for the first current-turn scene", async () => {
    const readId = randomUUID()
    const request = createRequest({
      phase: "graph_governance",
      committedReadIds: [readId],
      input: {
        userInput: "延续上一章的清晨场景。",
        chapterSequence: 2,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "node",
          ownerId: randomUUID(),
          exactKeys: ["上一章场景"],
          semanticText: "上一章场景锚点",
          sourceRefs: [],
          digest: "scene-digest",
        }],
        retrievalGaps: [],
        artifacts: {
          dependency_audit: {
            missingDependencies: [],
            unplannedContent: [],
            sceneContinuity: [{
              sceneIndex: 0,
              sceneDescription: "本章第一个场景",
              predecessorSceneIndexes: [],
              predecessorSceneRefs: ["read-1"],
              predecessorRequired: true,
              predecessorReason: "承接上一章",
              correspondenceRequired: false,
              correspondenceReason: "无额外对应要求",
              timeContinuity: "pass",
              locationContinuity: "pass",
              crossReferenceContinuity: "pass",
              reason: "从上一章场景进入本章",
            }],
            informationBoundary: "pass",
          },
        },
      },
    })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              mutations: [],
              retrievalProjections: [],
              settlementRecords: [],
              mutationSpacetimeSettlements: [],
              sceneSpacetimeBindings: [{
                sceneIndex: 0,
                sceneAnchorRef: "read-1",
                sourceUnitIndexes: [],
                temporalReferenceRefs: ["read-1"],
                timeAnchorRefs: ["read-1"],
                spatialReferenceRefs: ["read-1"],
                locationAnchorRefs: ["read-1"],
                predecessorSceneIndexes: [],
                predecessorSceneAnchorRefs: ["read-1"],
                transitionPathRefs: ["read-1"],
                correspondenceRefs: [],
                explanation: "通过上一章图锚点进入本章",
                selfReview: "本轮索引为空，外部前驱由图锚点和过渡路径承接",
              }],
              affectedFrontierRefs: [],
              archiveOutletRefs: [],
              decisionRecords: [],
            },
            citedReadIds: ["read-1"],
            reason: "已按跨轮前驱规则绑定",
            selfReview: "前驱索引与依赖审计一致",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(finalMessage).toContain("copy predecessorSceneIndexes exactly")
    expect(finalMessage).toContain("never invent scene 0")
    expect(finalMessage).toContain("predecessorSceneAnchorRefs")
    expect(finalMessage).toContain("predecessorSceneRefs are evidence references")
  })

  it("never silently falls back to Fake AI when the API key is missing", async () => {
    const unavailable = createModelFromEnvironment(promptRoot, {})
    expect(unavailable).toBeInstanceOf(UnavailableAiModelAdapter)
    expect(unavailable.info?.available).toBe(false)
    await expect(unavailable.execute(createRequest())).rejects.toThrow("DEEPSEEK_API_KEY")

    expect(createModelFromEnvironment(promptRoot, {
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_PROXY_URL: "http://127.0.0.1:7890",
    })).toBeInstanceOf(DeepSeekAiModelAdapter)
  })

  it("validates JSON text without provider JSON Mode and maps prompt cache usage", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let completionInput: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        completionInput = input
        return Promise.resolve({
          content: `${JSON.stringify(toModelResult(fake.result))}\nAdditional provider text`,
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 40,
          },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      defaultDeepSeekRuntimeConfig,
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)
    expect(execution.result.phase).toBe("interpret")
    expect(execution.usage.modelCalls).toBe(1)
    expect(execution.usage.cacheHitInputTokens).toBe(80)
    expect(execution.usage.cacheMissInputTokens).toBe(40)
    expect(execution.usage.provider).toBe("deepseek")
    expect(adapter.info).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", available: true })
    expect(completionInput).not.toHaveProperty("responseFormat")
    expect(completionInput).not.toHaveProperty("maxTokens")
  })

  it("enables provider JSON Mode only through the centralized runtime switch", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let completionInput: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        completionInput = input
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, jsonModeEnabled: true },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(completionInput?.responseFormat).toEqual({ type: "json_object" })
  })

  it("maps centralized thinking mode and reasoning effort into completion input", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const inputs: Parameters<DeepSeekCompletionClient["complete"]>[0][] = []
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        inputs.push(input)
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const enabled = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, reasoningEffort: "low" },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )
    const disabled = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, thinkingModeEnabled: false, reasoningEffort: "max" },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await enabled.execute(request)
    await disabled.execute(request)

    expect(inputs[0]).toMatchObject({ thinking: { type: "enabled" }, reasoningEffort: "low" })
    expect(inputs[1]).toMatchObject({ thinking: { type: "disabled" } })
    expect(inputs[1]).not.toHaveProperty("reasoningEffort")
  })

  it("retries provider connection errors before failing the phase", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new APIConnectionError({ message: "Connection error." }))
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0, maxAttempts: 2 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.phase).toBe("interpret")
  })

  it("retries undici transport termination before failing the phase", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        if (calls === 1) return Promise.reject(new TypeError("terminated"))
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0, maxAttempts: 2 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.phase).toBe("interpret")
  })

  it("honors the shorter per-request deadline before the turn deadline", async () => {
    const server = createServer((request) => { request.resume() })
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve) })
    const address = server.address() as AddressInfo
    const adapter = new DeepSeekAiModelAdapter(
      {
        ...defaultDeepSeekRuntimeConfig,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        timeoutMs: 5_000,
        maxAttempts: 1,
        maxSchemaRepairAttempts: 0,
      },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
    )
    const request = createRequest({
      remainingBudget: {
        maxCalls: 12,
        remainingCalls: 12,
        maxInputTokens: 1000,
        remainingInputTokens: 1000,
        maxOutputTokens: 1000,
        remainingOutputTokens: 1000,
        deadlineAtMs: Date.now() + 5_000,
        modelRequestDeadlineAtMs: Date.now() + 80,
      },
    })
    const startedAt = Date.now()

    try {
      await expect(adapter.execute(request)).rejects.toThrow("DeepSeek request failed")
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it("uses the OpenAI Responses protocol without storing remote response state", async () => {
    const phaseRequest = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(phaseRequest)
    let receivedPath = ""
    let receivedUserAgent = ""
    let receivedBody: Record<string, unknown> = {}
    const server = createServer((request, response) => {
      receivedPath = request.url ?? ""
      receivedUserAgent = request.headers["user-agent"] ?? ""
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          output_text: JSON.stringify(toModelResult(fake.result)),
          output: [
            {
              id: "reasoning_test",
              type: "reasoning",
              status: "completed",
              summary: [{ type: "summary_text", text: "检查了当前阶段契约。" }],
            },
            {
              id: "message_test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{
                type: "output_text",
                text: JSON.stringify(toModelResult(fake.result)),
                annotations: [],
                logprobs: [],
              }],
            },
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 120,
          },
        }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve) })
    const address = server.address() as AddressInfo
    const adapter = new DeepSeekAiModelAdapter(
      {
        ...defaultDeepSeekRuntimeConfig,
        apiProtocol: "openai_responses",
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        disableResponseStorage: true,
        serviceTier: "fast",
        reasoningEffort: "xhigh",
        jsonModeEnabled: true,
        maxAttempts: 1,
        maxSchemaRepairAttempts: 0,
      },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
    )

    try {
      const execution = await adapter.execute(phaseRequest)
      expect(receivedPath).toBe("/responses")
      expect(receivedUserAgent).toBe("Worldseed/0.1")
      expect(receivedBody.store).toBe(false)
      expect(receivedBody.service_tier).toBe("fast")
      expect(receivedBody.reasoning).toEqual({ effort: "xhigh", summary: "detailed" })
      expect(receivedBody.text).toEqual({ format: { type: "json_object" } })
      expect(receivedBody.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user" }),
      ]))
      expect(execution.usage.reasoningContent).toContain("检查了当前阶段契约")
      expect(execution.usage.reasoningKind).toBe("provider_summary")
      expect(execution.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheHitInputTokens: 80,
        cacheMissInputTokens: 20,
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it("omits the Responses service tier when automatic provider selection is configured", async () => {
    const phaseRequest = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(phaseRequest)
    let receivedBody: Record<string, unknown> = {}
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({
          id: "resp_auto_tier",
          object: "response",
          status: "completed",
          output_text: JSON.stringify(toModelResult(fake.result)),
          output: [{
            id: "message_auto_tier",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{
              type: "output_text",
              text: JSON.stringify(toModelResult(fake.result)),
              annotations: [],
              logprobs: [],
            }],
          }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve) })
    const address = server.address() as AddressInfo
    const adapter = new DeepSeekAiModelAdapter(
      {
        ...defaultDeepSeekRuntimeConfig,
        apiProtocol: "openai_responses",
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        serviceTier: "auto",
        thinkingModeEnabled: false,
        jsonModeEnabled: false,
        maxAttempts: 1,
        maxSchemaRepairAttempts: 0,
      },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
    )

    try {
      await adapter.execute(phaseRequest)
      expect(receivedBody).not.toHaveProperty("service_tier")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it("repairs a schema-invalid response within the configured limit", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: calls === 1 ? "{\"invalid\":true}" : JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)
    expect(calls).toBe(2)
    expect(execution.usage.modelCalls).toBe(2)
    expect(execution.usage.inputTokens).toBe(20)
    expect(execution.usage.lastRequestInputTokens).toBe(10)
    expect(execution.contextExchange?.requestMessages).toHaveLength(4)
    expect(execution.contextExchange?.requestMessages.some((message) => message.content?.includes("Regenerate"))).toBe(false)
  })

  it("regenerates truncated JSON without echoing the partial payload", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const truncated = '{"outcome":"continue","artifact":'
    let calls = 0
    let repairInput: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        calls += 1
        if (calls === 2) repairInput = input
        return Promise.resolve({
          content: calls === 1 ? truncated : JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(calls).toBe(2)
    expect(repairInput?.messages).toHaveLength(6)
    expect(repairInput?.messages.filter((message) => message.role === "assistant")).toHaveLength(0)
    expect(repairInput?.messages.at(-1)?.content).toContain("Regenerate the complete object")
    expect(repairInput?.messages.at(-1)?.content).toContain("provider's configured output limit")
  })

  it("repairs a complete-looking response when the provider reports output truncation", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    let repairInput: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        calls += 1
        if (calls === 2) repairInput = input
        return Promise.resolve({
          content: JSON.stringify(toModelResult(fake.result)),
          finishReason: calls === 1 ? "length" : "stop",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(calls).toBe(2)
    expect(repairInput?.messages.at(-1)?.content).toContain("Regenerate the complete object")
    expect(repairInput?.messages.at(-1)?.content).toContain("Use compact JSON")
  })

  it("repairs reasoning-only responses without parsing an empty final content string", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const completionInputs: Parameters<DeepSeekCompletionClient["complete"]>[0][] = []
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        completionInputs.push(input)
        return Promise.resolve(completionInputs.length === 1
          ? { content: "", reasoningContent: "I should now return the final object.", usage: { prompt_tokens: 10, completion_tokens: 5 } }
          : { content: JSON.stringify(toModelResult(fake.result)), usage: { prompt_tokens: 10, completion_tokens: 5 } })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(completionInputs).toHaveLength(2)
    expect(completionInputs[1]?.messages.some((message) => message.role === "assistant")).toBe(false)
    expect(completionInputs[1]?.messages.at(-1)?.content).toContain("without final content")
  })

  it("terminates reasoning fallback scanning when the outer JSON object fails the phase schema", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve(calls === 1
          ? {
              content: "",
              reasoningContent: JSON.stringify({ not: "a phase result" }),
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
          : {
              content: JSON.stringify(toModelResult(fake.result)),
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result).toEqual(fake.result)
  })

  it("accepts a schema-valid phase result emitted at the end of reasoning", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const modelResult = toModelResult(fake.result)
    let calls = 0
    const reasoningContent = [
      "I have completed the internal analysis and will now emit the required object.",
      JSON.stringify(modelResult),
    ].join("\n")
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: "",
          reasoningContent,
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(1)
    expect(execution.result).toEqual(fake.result)
    expect(execution.usage.reasoningContent).toBe(reasoningContent)
    expect(execution.usage.reasoningKind).toBe("provider_reasoning")
  })

  it("repeats the complete phase contract at the end of initial and repair requests", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const completionInputs: Parameters<DeepSeekCompletionClient["complete"]>[0][] = []
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        completionInputs.push(input)
        return Promise.resolve({
          content: completionInputs.length === 1
            ? JSON.stringify({
                ...toModelResult(fake.result),
                requestedReads: [{
                  reason: "locate settings",
                  expectedEvidence: "setting index",
                  query: { sourceKinds: ["setting"] },
                }],
              })
            : JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(completionInputs).toHaveLength(2)
    for (const input of completionInputs) {
      const finalMessage = input.messages.at(-1)?.content ?? ""
      expect(finalMessage).toContain('"sourceKinds"')
      expect(finalMessage).toContain('"graph"')
      expect(finalMessage).toContain('"reference"')
      expect(finalMessage).toContain('"truthStatus"')
      expect(finalMessage).toContain('"not_assumed"')
      expect(finalMessage).toContain('"current_turn_new"')
      expect(finalMessage).not.toContain('"$schema"')
    }
  })

  it("rejects Draft fields at the result top level instead of silently rewriting them", async () => {
    const request = createRequest({ phase: "draft" })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "continue",
          artifact: { contentMarkdown: "第二章正文" },
          adoptedDecisionIndexes: [],
          currentTimeAnchorRefs: [],
          currentLocationAnchorRefs: [],
          detectedUnplannedContent: [],
          requestedReads: [],
          citedReadIds: [],
          unresolvedDependencies: [],
          reason: "草稿已完成",
          selfReview: "已检查嵌套路径",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await expect(adapter.execute(request)).rejects.toThrow("could not satisfy the phase contract")
  })

  it("uses the phase schema as the only Draft shape contract", async () => {
    const request = createRequest({ phase: "draft" })
    let input: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (completionInput) => {
        input = completionInput
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              contentMarkdown: "草稿",
              adoptedDecisionIndexes: [],
              currentTimeAnchorRefs: [],
              currentLocationAnchorRefs: [],
              detectedUnplannedContent: [],
            },
            requestedReads: [],
            citedReadIds: [],
            unresolvedDependencies: [],
            reason: "完成",
            selfReview: "检查完成",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    const finalMessage = input?.messages.at(-1)?.content ?? ""
    expect(input).not.toHaveProperty("maxTokens")
    expect(finalMessage).toContain('"contentMarkdown"')
    expect(finalMessage).toContain('"adoptedDecisionIndexes"')
    expect(finalMessage).not.toContain("Draft path rule")
  })

  it("sends one combined result schema with phase fields nested in artifact", async () => {
    const request = createRequest({ phase: "interpret" })
    let input: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (completionInput) => {
        input = completionInput
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              workflow: "turn",
              userIntent: "test",
              worldIntent: "test",
              presentationIntent: "plain",
              userClaims: [],
              requiredTimeAnchor: true,
              requiredLocationAnchor: true,
              initialReadHypotheses: [],
            },
            requestedReads: [],
            citedReadIds: [],
            unresolvedDependencies: [],
            reason: "完成",
            selfReview: "检查完成",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    const finalMessage = input?.messages.at(-1)?.content ?? ""
    const messageLines = finalMessage.split("\n")
    const schemaMarkerIndex = messageLines.indexOf("The response must match this complete model-facing result schema:")
    const schema = JSON.parse(messageLines[schemaMarkerIndex + 1] ?? "") as {
      properties: Record<string, { properties?: Record<string, unknown> }>
    }

    expect(finalMessage).not.toContain("The artifact must match this complete JSON Schema:")
    expect(finalMessage.match(/The response must match this complete model-facing result schema:/gu)).toHaveLength(1)
    expect(schema.properties.artifact?.properties).toHaveProperty("workflow")
    expect(schema.properties).not.toHaveProperty("workflow")
  })

  it("repairs a prematurely closed envelope before schema validation", async () => {
    const request = createRequest()
    const valid = {
      outcome: "continue",
      artifact: {
        workflow: "turn",
        userIntent: "test",
        worldIntent: "test",
        presentationIntent: "plain",
        userClaims: [],
        requiredTimeAnchor: true,
        requiredLocationAnchor: true,
        initialReadHypotheses: [],
      },
      requestedReads: [],
      citedReadIds: [],
      unresolvedDependencies: [],
      reason: "完成",
      selfReview: "检查完成",
    }
    const encoded = JSON.stringify(valid)
    const requestedReadsIndex = encoded.indexOf(',"requestedReads"')
    const malformed = `${encoded.slice(0, requestedReadsIndex)}}${encoded.slice(requestedReadsIndex)}`
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: malformed,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.reason).toBe("完成")
    expect(execution.result.selfReview).toBe("检查完成")
  })

  it("repairs a response that cites a retrieval-gap request as evidence", async () => {
    const gapRequestId = randomUUID()
    const request = createRequest({
      input: {
        workflow: "turn",
        userInput: "test",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [{
          typeId: "system:retrieval-gap",
          requestId: gapRequestId,
          expectedEvidence: "current scene",
          reason: "No matching scene was found",
          query: {
            exactKeys: [],
            semanticTexts: ["current scene"],
            anchorIds: [],
            directions: ["both"],
            maxCandidates: 10,
            maxDepth: 2,
            sourceKinds: ["graph"],
          },
        }],
        artifacts: {},
      },
    })
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: JSON.stringify({
            ...toModelResult(fake.result),
            citedReadIds: calls === 1 ? [gapRequestId] : [],
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.citedReadIds).toEqual([])
  })

  it("assembles protocol fields when JSON mode returns semantic local handles", async () => {
    const request = createRequest()
    const malformed = {
      outcome: "continue",
      artifact: {
        workflow: "turn",
        userIntent: "test",
        worldIntent: "test",
        presentationIntent: "plain",
        userClaims: [],
        requiredTimeAnchor: true,
        requiredLocationAnchor: true,
        initialReadHypotheses: [],
      },
      reason: "semantic result",
      selfReview: "reviewed",
    }
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify(malformed),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.envelopeId).toBe(request.envelopeId)
    expect(execution.result.contextId).toBe(request.contextId)
    expect(execution.result.phase).toBe(request.phase)
    expect(execution.result.requestedReads).toEqual([])
    expect(execution.result.citedReadIds).toEqual([])
  })

  it("turns semantic reads and dependencies into internal IDs", async () => {
    const request = createRequest()
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "request_read",
          requestedReads: [{ reason: "locate the scene", expectedEvidence: "the current scene location" }],
          unresolvedDependencies: [{
            description: "current time is unknown",
            requiredFor: "continuity",
            disposition: "read",
          }],
          reason: "need evidence",
          selfReview: "no facts assumed",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)
    expect(execution.result.requestedReads[0]?.requestId).toMatch(/[0-9a-f-]{36}/u)
    expect(execution.result.unresolvedDependencies[0]?.dependencyId).toMatch(/[0-9a-f-]{36}/u)
    expect(execution.result.requestedReads[0]?.query.maxCandidates).toBe(24)
  })

  it("keeps internal source projections available for exact persistent-world reads", async () => {
    const request = createRequest({ phase: "source_retrieval" })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "request_read",
            artifact: { missingEvidence: [], nextExpansionHints: ["精确查找旧话语"] },
            requestedReads: [{
              reason: "查找已经写入世界的精确原话",
              expectedEvidence: "精确原文及其世界图上下文",
              query: {
                exactKeys: ["接得上，不等于就是真的。"],
                sourceKinds: ["graph", "revision"],
              },
            }],
            reason: "需要精确来源",
            selfReview: "不直接读取工作区章节文件",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.requestedReads[0]?.query.sourceKinds).toEqual(["graph", "revision", "source"])
    expect(finalMessage).toContain("internal committed immutable source-unit projection")
    expect(finalMessage).toContain("workspace chapter-read prohibition does not exclude source projections")
  })

  it("does not add source projections to exact rule and reference reads", async () => {
    const request = createRequest({ phase: "source_retrieval" })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "request_read",
          artifact: { missingEvidence: [], nextExpansionHints: ["读取规则索引"] },
          requestedReads: [{
            reason: "读取指定规则与参考索引",
            expectedEvidence: "README.md",
            query: {
              exactKeys: ["README.md"],
              sourceKinds: ["rule", "reference", "rule"],
            },
          }],
          reason: "需要工作区索引",
          selfReview: "不查询持久世界来源",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.requestedReads[0]?.query.sourceKinds).toEqual(["rule", "reference"])
  })

  it("accepts the semantic source retrieval artifact", async () => {
    const request = createRequest({ phase: "source_retrieval" })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "continue",
          artifact: { missingEvidence: [], nextExpansionHints: [] },
          reason: "No additional evidence was needed for this phase",
          selfReview: "The retrieval step has no pending read requests to execute",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.phase).toBe("source_retrieval")
    expect(execution.result.artifact).toEqual({
      missingEvidence: [],
      nextExpansionHints: [],
    })
  })

  it("normalizes empty optional model fields before phase validation", async () => {
    let calls = 0
    const planningRequest = createRequest({ phase: "emergence_planning" })
    const planningClient: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: { decisions: [], noCreationReason: "" },
            reason: "无需创建",
            selfReview: "无决策",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      planningClient,
    )

    const execution = await adapter.execute(planningRequest)

    expect(calls).toBe(1)
    expect(execution.result.artifact).toEqual({ decisions: [] })
  })

  it("keeps graph governance semantic and leaves technical IDs to the backend", async () => {
    const request = createRequest({
      phase: "graph_governance",
      input: {
        userInput: "test",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [randomUUID()],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "continue",
          artifact: {
            mutations: [],
            retrievalProjections: [],
            settlementRecords: [{
              sourceUnitIndex: 0,
              graphRefs: [],
              reason: "The source unit is accounted for",
              status: "settled",
            }],
            mutationSpacetimeSettlements: [],
            sceneSpacetimeBindings: [],
            affectedFrontierRefs: [],
            archiveOutletRefs: [],
            decisionRecords: [{
              decisionKind: "initial_graph_governance",
              mutationIndexes: [],
              mutationSpacetimeSettlementIndexes: [],
              reason: "Record the graph decision",
              payload: {},
              selfReview: "The record describes only this proposal",
            }],
          },
          reason: "Graph governance completed",
          selfReview: "Technical identifiers are delegated to the backend",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)
    expect(execution.result.artifact).toMatchObject({
      mutations: [],
      settlementRecords: [{ sourceUnitIndex: 0 }],
      archiveOutletRefs: [],
    })
    expect(JSON.stringify(execution.result.artifact)).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/u)
  })

  it("states exact graph-governance scene and source-unit coverage without contradictory empty bindings", async () => {
    let finalMessage = ""
    const request = createRequest({
      phase: "graph_governance",
      input: {
        userInput: "继续推演五个连续场景。",
        chapterSequence: 17,
        sourceId: randomUUID(),
        sourceUnitIds: Array.from({ length: 8 }, () => randomUUID()),
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {
          dependency_audit: {
            missingDependencies: [],
            unplannedContent: [],
            sceneContinuity: Array.from({ length: 5 }, (_, sceneIndex) => ({
              sceneIndex,
              sceneDescription: `场景 ${String(sceneIndex)}`,
              predecessorSceneIndexes: sceneIndex === 0 ? [] : [sceneIndex - 1],
              predecessorSceneRefs: [],
              predecessorRequired: sceneIndex > 0,
              predecessorReason: "连续场景",
              correspondenceRequired: false,
              correspondenceReason: "无需额外对应",
              timeContinuity: "pass",
              locationContinuity: "pass",
              crossReferenceContinuity: "pass",
              reason: "连续",
            })),
            informationBoundary: "pass",
          },
        },
      },
    })
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({ content: "{}", usage: { prompt_tokens: 10, completion_tokens: 5 } })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await expect(adapter.execute(request)).rejects.toThrow("could not satisfy the phase contract")

    expect(finalMessage).toContain("Required dependency-audit scene indexes are exactly: 0, 1, 2, 3, 4")
    expect(finalMessage).toContain("Required narrative source unit indexes are exactly: 0, 1, 2, 3, 4, 5, 6, 7")
    expect(finalMessage).toContain("must bind at least one source unit index")
    expect(finalMessage).not.toContain("still create its binding with empty sourceUnitIndexes")
    expect(finalMessage).not.toContain("mutationSpacetimeSettlements must cover every mutation index exactly once: none")
  })

  it("maps graph evidence read aliases to graph owners deterministically", async () => {
    const readId = randomUUID()
    const graphOwnerId = randomUUID()
    const request = createRequest({
      phase: "graph_governance",
      committedReadIds: [readId],
      input: {
        userInput: "继续治理旧钟楼。",
        chapterSequence: 2,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "node",
          ownerId: graphOwnerId,
          revisionId: randomUUID(),
          exactKeys: ["旧钟楼"],
          semanticText: "旧钟楼节点",
          sourceRefs: [],
          digest: "graph-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              mutations: [],
              retrievalProjections: [{
                ownerKind: "node",
                ownerRef: "read-1",
                exactKeys: ["旧钟楼"],
                semanticText: "旧钟楼节点",
              }],
              settlementRecords: [{
                sourceUnitIndex: 0,
                graphRefs: [{ targetKind: "node", targetRef: "read-1", mutationIndex: null }],
                reason: "结算已读节点",
                status: "settled",
              }],
              mutationSpacetimeSettlements: [],
              sceneSpacetimeBindings: [],
              affectedFrontierRefs: [],
              archiveOutletRefs: [],
              decisionRecords: [],
            },
            citedReadIds: ["read-1"],
            reason: "治理已读图节点",
            selfReview: "引用来自本轮证据",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.artifact).toMatchObject({
      retrievalProjections: [{ ownerRef: graphOwnerId }],
      settlementRecords: [{ graphRefs: [{ targetRef: graphOwnerId }] }],
    })
    expect(execution.result.artifact).not.toHaveProperty("settlementRecords.0.graphRefs.0.mutationIndex")
    expect(finalMessage).toContain("read-1 -> node-1")
    expect(finalMessage).toContain("Never put evidence_*/read-* in a graph reference field")
  })

  it("keeps workspace evidence out of graph historical return references", async () => {
    const readId = randomUUID()
    const request = createRequest({
      phase: "graph_governance",
      committedReadIds: [readId],
      input: {
        userInput: "延续正文。",
        chapterSequence: 2,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "workspace:chapters",
          ownerId: "章节正文/第一章.md",
          exactKeys: ["第一章"],
          semanticText: "第一章正文",
          sourceRefs: [],
          digest: "chapter-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify({
          outcome: "continue",
          artifact: {
            mutations: [{ operation: "create_node", ref: "local:scene", data: { content: "新场景" } }],
            retrievalProjections: [],
            settlementRecords: [],
            mutationSpacetimeSettlements: [{
              mutationIndexes: [0],
              effectDisposition: "world_effect",
              effectiveSceneBindingIndexes: [0],
              effectiveExistingSceneAnchorRefs: [],
              currentEntryRefs: ["local:scene"],
              predecessorRevisionRequired: false,
              predecessorRevisionReadRefs: [],
              historicalReturnRefs: ["read-1"],
              reason: "保留历史返回",
              selfReview: "入口可返回原文",
            }],
            sceneSpacetimeBindings: [],
            affectedFrontierRefs: ["local:scene"],
            archiveOutletRefs: [],
            decisionRecords: [],
          },
          citedReadIds: ["read-1"],
          reason: "完成治理",
          selfReview: "原文与图入口分离",
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.artifact).toMatchObject({
      mutationSpacetimeSettlements: [{ historicalReturnRefs: ["local:scene"] }],
      decisionRecords: [{ decisionKind: "phase_default", mutationIndexes: [0] }],
    })
  })

  it("repairs existing graph references that substitute chapter evidence for graph identity", async () => {
    const readId = randomUUID()
    const request = createRequest({
      phase: "emergence_planning",
      committedReadIds: [readId],
      input: {
        userInput: "继续同一名旅人。",
        chapterSequence: 2,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "workspace:chapters",
          ownerId: "章节正文/第一章.md",
          exactKeys: ["第一章"],
          semanticText: "第一章正文",
          sourceRefs: [],
          digest: "chapter-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let calls = 0
    const repairMessages: string[] = []
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        calls += 1
        repairMessages.push(input.messages.at(-1)?.content ?? "")
        const decision = calls === 1
          ? {
              pressureEvidenceRefs: ["read-1"],
              action: "reuse",
              existingAnchorRefs: ["read-1"],
              timeAnchorRefs: [],
              locationAnchorRefs: [],
              informationBoundaryRefs: [],
              reason: "Reuse the traveler from the chapter",
            }
          : {
              pressureEvidenceRefs: ["read-1"],
              action: "defer",
              existingAnchorRefs: [],
              timeAnchorRefs: [],
              locationAnchorRefs: [],
              informationBoundaryRefs: [],
              reason: "Read the graph identity before reuse",
            }
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: { decisions: [decision] },
            citedReadIds: ["read-1"],
            reason: "Plan identity handling",
            selfReview: "Identity references were checked",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(repairMessages[1]).toContain("read-1")
    expect(repairMessages[1]).not.toContain(readId)
    expect(execution.result.artifact).toMatchObject({ decisions: [{ action: "defer" }] })
  })

  it("keeps evidence and graph aliases distinct before restoring them", async () => {
    const graphReadId = randomUUID()
    const graphOwnerId = randomUUID()
    const request = createRequest({
      phase: "emergence_planning",
      committedReadIds: [graphReadId],
      input: {
        userInput: "继续观察钟楼。",
        chapterSequence: 2,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId: graphReadId,
          visibility: "committed",
          ownerKind: "node",
          ownerId: graphOwnerId,
          exactKeys: ["旧钟楼"],
          semanticText: "旧钟楼节点",
          sourceRefs: [],
          digest: "graph-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let input: Parameters<DeepSeekCompletionClient["complete"]>[0] | undefined
    const client: DeepSeekCompletionClient = {
      complete: (completionInput) => {
        input = completionInput
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              decisions: [{
                pressureEvidenceRefs: ["read-1"],
                action: "reveal",
                existingAnchorRefs: ["node-1"],
                timeAnchorRefs: ["node-1"],
                locationAnchorRefs: ["node-1"],
                informationBoundaryRefs: ["node-1"],
                reason: "复用已读取图身份",
              }],
            },
            citedReadIds: ["read-1"],
            reason: "完成出现规划",
            selfReview: "引用来自本轮读取",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.artifact).toMatchObject({
      decisions: [{
        pressureEvidenceRefs: [graphReadId],
        existingAnchorRefs: [graphOwnerId],
        timeAnchorRefs: [graphOwnerId],
        locationAnchorRefs: [graphOwnerId],
        informationBoundaryRefs: [graphOwnerId],
      }],
    })
    const finalMessage = input?.messages.at(-1)?.content ?? ""
    expect(finalMessage).toContain("read-1")
    expect(finalMessage).toContain("node-1")
    expect(finalMessage).not.toContain(graphReadId)
    expect(finalMessage).not.toContain(graphOwnerId)
  })

  it("repairs rule snapshots that select unread workspace paths", async () => {
    const readId = randomUUID()
    const readPath = "设定集/readme.md"
    const request = createRequest({
      phase: "rule_assembly",
      committedReadIds: [readId],
      input: {
        userInput: "开始。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "workspace:settings",
          ownerId: readPath,
          exactKeys: [readPath],
          semanticText: "设定索引",
          sourceRefs: [],
          digest: "settings-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              selectedWorkspacePaths: calls === 1
                ? ["世界推演规则/基础规则/base-rules.md", readPath]
                : [readPath],
              selectionReasons: { [readPath]: "Required settings index" },
              unresolvedRuleConflicts: [],
            },
            citedReadIds: ["read-1"],
            reason: "Assemble readable rules",
            selfReview: "Only actual evidence was selected",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.artifact).toMatchObject({ selectedWorkspacePaths: [readPath] })
  })

  it("repairs rule snapshots whose reason keys do not exactly match selected paths", async () => {
    const readId = randomUUID()
    const readPath = "设定集/readme.md"
    const request = createRequest({
      phase: "rule_assembly",
      committedReadIds: [readId],
      input: {
        userInput: "开始。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [{
          readId,
          visibility: "committed",
          ownerKind: "workspace:settings",
          ownerId: readPath,
          exactKeys: [readPath],
          semanticText: "设定索引",
          sourceRefs: [],
          digest: "settings-digest",
        }],
        retrievalGaps: [],
        artifacts: {},
      },
    })
    let calls = 0
    let firstMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        calls += 1
        if (calls === 1) firstMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "continue",
            artifact: {
              selectedWorkspacePaths: [readPath],
              selectionReasons: calls === 1 ? {} : { [readPath]: "使用已读设定索引" },
              unresolvedRuleConflicts: [],
            },
            requestedReads: [],
            citedReadIds: ["read-1"],
            unresolvedDependencies: [],
            reason: "组装已读规则",
            selfReview: "未复制目录或文件内容",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    await adapter.execute(request)

    expect(calls).toBe(2)
    expect(firstMessage).toContain("currently has 1 readable workspace path(s)")
    expect(firstMessage).toContain("Return the smallest complete JSON result")
    expect(firstMessage).toContain("Treat the model-facing request as read-only input")
    expect(firstMessage).toContain("Completeness means one valid result for this phase")
    expect(firstMessage).toContain("stop generating immediately")
    expect(firstMessage).toContain("FINAL OUTPUT DISCIPLINE")
    expect(firstMessage).toContain("This phase has no long-text field")
    expect(firstMessage).toContain('"selectedWorkspacePaths":[]')
  })

  it("accepts semantic reviews that report only selected graph mutation advice", async () => {
    const request = createRequest({
      phase: "semantic_review",
      input: {
        userInput: "建立世界起点。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        verificationProbeExecutions: [{
          probeIndex: 0,
          requestId: randomUUID(),
          operationId: randomUUID(),
          descriptor: { purpose: "scene_restore", sceneBindingIndexes: [], mutationSpacetimeSettlementIndexes: [] },
          status: "completed",
          returnedReadRefs: [],
          returnedGraphRefs: [],
          returnedProposalRefs: [],
          resultDigest: "probe-digest",
        }],
        artifacts: {
          graph_governance: {
            mutations: [
              { operation: "create_node", ref: "local:world", data: { content: "世界" } },
              { operation: "create_node", ref: "local:scene", data: { content: "场景" } },
            ],
            retrievalProjections: [],
            settlementRecords: [],
            mutationSpacetimeSettlements: [],
            sceneSpacetimeBindings: [],
            affectedFrontierRefs: [],
            archiveOutletRefs: [],
            decisionRecords: [],
          },
        },
      },
    })
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "approve",
            artifact: {
              approvedMutationIndexes: calls === 1 ? [] : [0, 1],
              rejectedMutationIndexes: [],
              approvedSpacetimeBindingIndexes: [],
              rejectedSpacetimeBindingIndexes: [],
              approvedMutationSpacetimeSettlementIndexes: [],
              rejectedMutationSpacetimeSettlementIndexes: [],
              approvedAffectedFrontierRefs: [],
              rejectedAffectedFrontierRefs: [],
              verificationProbeAssessments: [{
                probeIndex: 0,
                purpose: "scene_restore",
                sceneBindingIndexes: [],
                mutationSpacetimeSettlementIndexes: [],
                verdict: "uncertain",
                reason: "no existing evidence",
              }],
              sceneInventoryComplete: true,
              graphStillDiscoverable: true,
              graphStillConcise: true,
              continuityPreserved: true,
              spacetimeContinuityPreserved: true,
            },
            requestedReads: [],
            citedReadIds: [],
            unresolvedDependencies: [],
            reason: "完成语义审批",
            selfReview: "逐项检查图修改",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(1)
    expect(execution.result.artifact).toMatchObject({ approvedMutationIndexes: [] })
  })

  it("repairs graph governance reviews that omit executed probe assessments", async () => {
    const governance = {
      mutations: [{ operation: "create_node" as const, ref: "local:world", data: { content: "世界" } }],
      retrievalProjections: [{
        ownerKind: "node" as const,
        ownerMutationIndex: 0,
        exactKeys: ["世界"],
        semanticText: "世界入口",
      }],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: ["local:world"],
      archiveOutletRefs: [],
      decisionRecords: [],
    }
    const request = createRequest({
      phase: "graph_governance_review",
      input: {
        userInput: "建立世界起点。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        verificationProbeExecutions: [{
          probeIndex: 0,
          requestId: randomUUID(),
          operationId: randomUUID(),
          descriptor: { purpose: "current_state", sceneBindingIndexes: [], mutationSpacetimeSettlementIndexes: [] },
          status: "completed",
          returnedReadRefs: [],
          returnedGraphRefs: [],
          returnedProposalRefs: ["local:world"],
          resultDigest: "probe-digest",
        }],
        artifacts: { graph_governance: governance },
      },
    })
    let calls = 0
    let firstRequestTail = ""
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          calls += 1
          if (calls === 1) firstRequestTail = input.messages.at(-1)?.content ?? ""
          return Promise.resolve({
            content: JSON.stringify({
              outcome: "continue",
              artifact: {
                recommendation: "pass",
                issues: [],
                graphStillDiscoverable: true,
                graphStillConcise: true,
                continuityPreserved: true,
                spacetimeContinuityPreserved: true,
                sourceReturnComplete: true,
                verificationProbeAssessments: calls === 1 ? [] : [{
                  probeIndex: 0,
                  verdict: "pass",
                  reason: "The staged owner was returned",
                }],
                selfReview: "Reviewed the executed probes",
              },
              requestedReads: [],
              citedReadIds: [],
              unresolvedDependencies: [],
              reason: "Review staged governance",
              selfReview: "Checked the staged graph",
            }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.artifact).toMatchObject({
      verificationProbeAssessments: [{ probeIndex: 0, verdict: "pass" }],
    })
    expect(firstRequestTail).toContain("verificationProbeExecutions contains application-executed results")
    expect(firstRequestTail).toContain("readEvidence, returnedReadRefs, returnedGraphRefs, returnedProposalRefs, and resultDigest")
    expect(firstRequestTail).toContain("Do not claim that probe execution results were not provided when these fields are present")
    expect(firstRequestTail).toContain("probeIndex=0")
    expect(firstRequestTail).toContain("status=completed")
    expect(firstRequestTail).toContain("returnedProposalRefs=[local:world]")
    expect(firstRequestTail).toContain("resultDigest=probe-digest")
  })

  it("repairs graph governance reviews that omit an AI-defined verification probe", async () => {
    const governance = {
      mutations: [{ operation: "create_node" as const, ref: "local:world", data: { content: "世界" } }],
      retrievalProjections: [{
        ownerKind: "node" as const,
        ownerMutationIndex: 0,
        exactKeys: ["世界"],
        semanticText: "世界入口",
      }],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: [],
      archiveOutletRefs: [],
      decisionRecords: [],
    }
    const request = createRequest({
      phase: "graph_governance_review",
      input: {
        userInput: "建立世界起点。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: { graph_governance: governance },
      },
    })
    let calls = 0
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 1 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: () => {
          calls += 1
          return Promise.resolve({
            content: JSON.stringify({
              outcome: calls === 1 ? "continue" : "request_read",
              artifact: {
                recommendation: "pass",
                issues: [],
                graphStillDiscoverable: true,
                graphStillConcise: true,
                continuityPreserved: true,
                spacetimeContinuityPreserved: true,
                sourceReturnComplete: true,
                verificationProbeAssessments: [],
                selfReview: "Reviewed the staged graph",
              },
              requestedReads: calls === 1 ? [] : [{
                reason: "Verify the AI-designed retrieval path",
                expectedEvidence: "The staged world entry",
                query: {
                  exactKeys: ["世界"],
                  semanticTexts: ["世界入口"],
                  anchorIds: ["local:world"],
                  directions: ["both"],
                  maxCandidates: 8,
                  maxDepth: 2,
                  sourceKinds: ["graph", "revision"],
                },
                verificationProbe: {
                  purpose: "current_state",
                  sceneBindingIndexes: [],
                  mutationSpacetimeSettlementIndexes: [],
                },
              }],
              citedReadIds: [],
              unresolvedDependencies: [],
              reason: "Review staged governance",
              selfReview: "Checked whether a probe must be executed",
            }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    const execution = await adapter.execute(request)

    expect(calls).toBe(2)
    expect(execution.result.outcome).toBe("request_read")
    expect(execution.result.requestedReads).toEqual([
      expect.objectContaining({
        verificationProbe: expect.objectContaining({ purpose: "current_state" }),
      }),
    ])
  })

  it("completes omitted frontier approvals when the model explicitly approves the full proposal", async () => {
    const request = createRequest({
      phase: "semantic_review",
      input: {
        userInput: "建立世界起点。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        verificationProbeExecutions: [{
          probeIndex: 0,
          requestId: randomUUID(),
          operationId: randomUUID(),
          descriptor: { purpose: "current_state", sceneBindingIndexes: [], mutationSpacetimeSettlementIndexes: [] },
          status: "completed",
          returnedReadRefs: [],
          returnedGraphRefs: [],
          returnedProposalRefs: [],
          resultDigest: "probe-digest",
        }],
        artifacts: {
          graph_governance: {
            mutations: [{ operation: "create_node", ref: "local:world", data: { content: "世界" } }],
            retrievalProjections: [],
            settlementRecords: [],
            mutationSpacetimeSettlements: [],
            sceneSpacetimeBindings: [],
            affectedFrontierRefs: ["local:world"],
            archiveOutletRefs: [],
            decisionRecords: [],
          },
        },
      },
    })
    let finalMessage = ""
    const client: DeepSeekCompletionClient = {
      complete: (input) => {
        finalMessage = input.messages.at(-1)?.content ?? ""
        return Promise.resolve({
          content: JSON.stringify({
            outcome: "approve",
            artifact: {
              approvedMutationIndexes: [0],
              rejectedMutationIndexes: [],
              approvedSpacetimeBindingIndexes: [],
              rejectedSpacetimeBindingIndexes: [],
              approvedMutationSpacetimeSettlementIndexes: [],
              rejectedMutationSpacetimeSettlementIndexes: [],
              approvedAffectedFrontierRefs: [],
              rejectedAffectedFrontierRefs: [],
              verificationProbeAssessments: [{
                probeIndex: 0,
                purpose: "current_state",
                sceneBindingIndexes: [],
                mutationSpacetimeSettlementIndexes: [],
                verdict: "uncertain",
                reason: "no existing evidence",
              }],
              sceneInventoryComplete: true,
              graphStillDiscoverable: true,
              graphStillConcise: true,
              continuityPreserved: true,
              spacetimeContinuityPreserved: true,
            },
            requestedReads: [],
            citedReadIds: [],
            unresolvedDependencies: [],
            reason: "批准完整提案",
            selfReview: "所有修改均通过",
          }),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      },
    }
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      client,
    )

    const execution = await adapter.execute(request)

    expect(execution.result.artifact).toMatchObject({ approvedAffectedFrontierRefs: ["local:world"] })
    expect(finalMessage).toContain("affected frontiers available for review: local:world")
  })

  it("pins every approved frontier to an exact output array position", async () => {
    const affectedFrontierRefs = ["local:alpha", "local:beta"]
    const governance = {
      mutations: affectedFrontierRefs.map((ref) => ({ operation: "create_node" as const, ref, data: { content: ref } })),
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs,
      archiveOutletRefs: [],
      decisionRecords: [],
    }
    const semanticReview = {
      approvedMutationIndexes: [0, 1],
      rejectedMutationIndexes: [],
      approvedSpacetimeBindingIndexes: [],
      rejectedSpacetimeBindingIndexes: [],
      approvedMutationSpacetimeSettlementIndexes: [],
      rejectedMutationSpacetimeSettlementIndexes: [],
      approvedAffectedFrontierRefs: affectedFrontierRefs,
      rejectedAffectedFrontierRefs: [],
      verificationProbeAssessments: [],
      sceneInventoryComplete: true,
      graphStillDiscoverable: true,
      graphStillConcise: true,
      continuityPreserved: true,
      spacetimeContinuityPreserved: true,
    }
    const request = createRequest({
      phase: "frontier_settlement",
      input: {
        workflow: "turn",
        userInput: "继续推进。",
        chapterSequence: 1,
        sourceId: randomUUID(),
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
        validationArtifacts: { graph_governance: governance, semantic_review: semanticReview },
        stageProjection: {
          kind: "frontier_settlement",
          version: 1,
          sourceArtifactDigests: {
            graph_governance: "digest-governance",
            semantic_review: "digest-review",
            settlement_review: "digest-settlement",
          },
          pendingScope: { scopeId: "scope_1", candidateDigest: "digest-scope" },
          projectionDigest: "digest-projection",
          unresolvedIssues: [],
          affectedFrontierRefs,
          approvedSceneBindings: [],
          archiveOutletRefs: [],
          correspondenceRefs: [],
          priorFrontierStates: [{
            frontierAnchorRef: "local:alpha",
            lastSceneAnchorRefs: ["local:old-scene"],
            lastTimeAnchorRefs: ["local:old-time"],
            lastLocationAnchorRefs: ["local:old-place"],
            correspondenceRefs: ["local:old-correspondence"],
          }],
        },
      },
    })
    let finalMessage = ""
    const adapter = new DeepSeekAiModelAdapter(
      { ...defaultDeepSeekRuntimeConfig, maxSchemaRepairAttempts: 0 },
      { getSecret: () => Promise.resolve("test-key") },
      new NodePromptResourceAdapter(promptRoot),
      {
        complete: (input) => {
          finalMessage = input.messages.at(-1)?.content ?? ""
          return Promise.resolve({
            content: JSON.stringify({
              outcome: "continue",
              artifact: {
                frontiers: affectedFrontierRefs.map((frontierAnchorRef) => ({
                  frontierAnchorRef,
                  disposition: "archived",
                  lastSceneAnchorRefs: [],
                  lastTimeAnchorRefs: [],
                  lastLocationAnchorRefs: [],
                  correspondenceRefs: [],
                  reason: "当前局部已归档。",
                })),
              },
              requestedReads: [],
              citedReadIds: [],
              unresolvedDependencies: [],
              reason: "完成前沿结算。",
              selfReview: "已逐项核对批准引用。",
            }),
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })
        },
      },
    )

    await adapter.execute(request)

    expect(finalMessage).toContain("Approved frontier count: 2")
    expect(finalMessage).toContain("artifact.frontiers length must be exactly 2 and must not be empty")
    expect(finalMessage).toContain('[0].frontierAnchorRef must be exactly "local:alpha"')
    expect(finalMessage).toContain('[1].frontierAnchorRef must be exactly "local:beta"')
    expect(finalMessage).toContain("Prior anchors for frontier local:alpha")
    expect(finalMessage).toContain("lastSceneAnchorRefs=[local:old-scene]")
    expect(finalMessage.indexOf("FINAL PHASE-SPECIFIC REQUIREMENTS FOR frontier_settlement:"))
      .toBeGreaterThan(finalMessage.indexOf("Required top-level shape:"))
  })

})

function createRequest(overrides: Partial<PhaseRequestEnvelope> = {}): PhaseRequestEnvelope {
  const projectId = randomUUID()
  const taskId = randomUUID()
  return {
    schemaVersion: 1,
    envelopeId: randomUUID(),
    projectId,
    taskId,
    turnId: randomUUID(),
    contextId: randomUUID(),
    scopeId: randomUUID(),
    phase: "interpret",
    protocolVersion: PROTOCOL_VERSION,
    promptRef: "v1:interpret",
    promptDigest: "prompt-digest",
    contextViewRef: "context-digest",
    committedReadIds: [],
    visiblePendingIds: [],
    remainingBudget: {
      maxCalls: 12,
      remainingCalls: 12,
      maxInputTokens: 1000,
      remainingInputTokens: 1000,
      maxOutputTokens: 1000,
      remainingOutputTokens: 1000,
      deadlineAtMs: Date.now() + 10_000,
    },
    input: {
      workflow: "turn",
      userInput: "test",
      chapterSequence: 1,
      sourceId: randomUUID(),
      sourceUnitIds: [],
      phaseRunIds: [],
      readEvidence: [],
      retrievalGaps: [],
      artifacts: {},
    },
    ...overrides,
  }
}

function modelEvidence(readId: string, semanticText: string) {
  return {
    readId,
    visibility: "committed" as const,
    ownerKind: "workspace:reference",
    ownerId: "参考文件/readme.md",
    exactKeys: [semanticText],
    semanticText,
    sourceRefs: [],
    digest: `${readId}-digest`,
  }
}

function toModelResult(result: PhaseResultEnvelope): unknown {
  return {
    outcome: result.outcome,
    ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
    requestedReads: result.requestedReads.map((request) => ({
      reason: request.reason,
      expectedEvidence: request.expectedEvidence,
      query: request.query,
    })),
    citedReadIds: result.citedReadIds,
    unresolvedDependencies: result.unresolvedDependencies.map((dependency) => ({
      description: dependency.description,
      requiredFor: dependency.requiredFor,
      disposition: dependency.disposition,
    })),
    reason: result.reason,
    selfReview: result.selfReview,
  }
}
