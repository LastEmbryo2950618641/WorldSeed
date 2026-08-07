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
    })

    expect(adapter.info).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", available: true })
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

    const finalMessage = input?.messages.at(-1)?.content ?? ""
    expect(finalMessage).not.toContain(readId)
    expect(finalMessage).not.toContain(graphOwnerId)
    expect(finalMessage).not.toContain(graphRevisionId)
    expect(finalMessage).not.toContain(sourceId)
    expect(finalMessage).not.toContain('"revisionId"')
    expect(finalMessage).not.toContain('"sourceRefs"')
    expect(finalMessage).not.toContain(request.projectId)
    expect(finalMessage).not.toContain(request.taskId)
    expect(finalMessage).not.toContain('"format":"uuid"')
    expect(finalMessage).toContain("read-1")
    expect(finalMessage).toContain("node-1")
    expect(execution.result.citedReadIds).toEqual([readId])
    expect(execution.result.requestedReads[0]?.query.anchorIds).toEqual([graphOwnerId])
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
    expect(finalMessage).toContain("only graph_governance declares local:* handles")
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
    expect(completionInput?.maxTokens).toBe(384_000)
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
      complete: async () => {
        calls += 1
        if (calls === 1) throw new APIConnectionError({ message: "Connection error." })
        return {
          content: JSON.stringify(toModelResult(fake.result)),
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
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

  it("passes the turn deadline signal through the SDK request options", async () => {
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
        deadlineAtMs: Date.now() + 80,
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
    expect(repairInput?.messages.some((message) => message.role === "assistant" && message.content === truncated)).toBe(true)
    expect(repairInput?.messages.at(-1)?.content).toContain("Regenerate the complete object")
    expect(repairInput?.messages.at(-1)?.content).toContain("provider's configured output limit")
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
    expect(completionInputs[1]?.messages.at(-2)).toEqual({ role: "assistant", content: "" })
    expect(completionInputs[1]?.messages.at(-1)?.content).toContain("without final content")
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
    expect(finalMessage).toContain("Never put read-* in a graph reference field")
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
              verificationProbes: [],
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
              verificationProbes: [],
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
