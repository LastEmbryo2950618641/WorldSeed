import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { defaultDeepSeekRuntimeConfig } from "@worldseed/config"
import { PROTOCOL_VERSION, type PhaseRequestEnvelope } from "@worldseed/contracts"
import { describe, expect, it } from "vitest"

import {
  DeepSeekAiModelAdapter,
  FakeAiModelAdapter,
  NodePromptResourceAdapter,
  UnavailableAiModelAdapter,
  createModelFromEnvironment,
  type DeepSeekCompletionClient,
} from "../src/index.js"

const promptRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))

describe("DeepSeekAiModelAdapter", () => {
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

  it("validates JSON Mode output and maps prompt cache usage", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    const client: DeepSeekCompletionClient = {
      complete: () => Promise.resolve({
        content: JSON.stringify(fake.result),
        usage: {
          prompt_tokens: 120,
          completion_tokens: 40,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
        },
      }),
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
    expect(adapter.info).toMatchObject({ provider: "deepseek", model: "deepseek-chat", available: true })
  })

  it("repairs a schema-invalid response within the configured limit", async () => {
    const request = createRequest()
    const fake = await new FakeAiModelAdapter(randomUUID).execute(request)
    let calls = 0
    const client: DeepSeekCompletionClient = {
      complete: () => {
        calls += 1
        return Promise.resolve({
          content: calls === 1 ? "{\"invalid\":true}" : JSON.stringify(fake.result),
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
})

function createRequest(): PhaseRequestEnvelope {
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
      artifacts: {},
    },
  }
}
