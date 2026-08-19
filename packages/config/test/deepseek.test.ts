import { describe, expect, it } from "vitest"

import {
  deepSeekRuntimeConfigFromEnvironment,
  defaultDeepSeekRuntimeConfig,
} from "../src/index.js"

describe("DeepSeek environment configuration", () => {
  it("keeps the offline Fake model when no API key is configured", () => {
    expect(deepSeekRuntimeConfigFromEnvironment({})).toBeUndefined()
  })

  it("loads model, thinking, JSON, proxy, timeout, retry, and repair settings", () => {
    expect(deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_BASE_URL: "http://localhost:8787/v1",
      WORLDSEED_DEEPSEEK_MODEL: "deepseek-reasoner",
      WORLDSEED_DEEPSEEK_PROXY_URL: "http://127.0.0.1:7890",
      WORLDSEED_DEEPSEEK_TIMEOUT_MS: "30000",
      WORLDSEED_DEEPSEEK_MAX_ATTEMPTS: "1",
      WORLDSEED_DEEPSEEK_MAX_SCHEMA_REPAIR_ATTEMPTS: "0",
      WORLDSEED_DEEPSEEK_JSON_MODE_ENABLED: "true",
      WORLDSEED_DEEPSEEK_THINKING_MODE_ENABLED: "false",
      WORLDSEED_DEEPSEEK_REASONING_EFFORT: "max",
    })).toEqual({
      ...defaultDeepSeekRuntimeConfig,
      baseUrl: "http://localhost:8787/v1",
      model: "deepseek-reasoner",
      proxyUrl: "http://127.0.0.1:7890",
      timeoutMs: 30000,
      maxAttempts: 1,
      maxSchemaRepairAttempts: 0,
      jsonModeEnabled: true,
      thinkingModeEnabled: false,
      reasoningEffort: "max",
    })
  })

  it("rejects malformed numeric settings instead of silently changing them", () => {
    expect(() => deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_TIMEOUT_MS: "slow",
    })).toThrow("must be an integer")
  })

  it("rejects malformed JSON Mode settings", () => {
    expect(() => deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_JSON_MODE_ENABLED: "enabled",
    })).toThrow("must be true or false")
  })

  it("accepts medium reasoning effort settings", () => {
    expect(deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_REASONING_EFFORT: "medium",
    })).toMatchObject({ reasoningEffort: "medium" })
  })
})
