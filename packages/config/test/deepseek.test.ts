import { describe, expect, it } from "vitest"

import {
  deepSeekRuntimeConfigFromEnvironment,
  defaultDeepSeekRuntimeConfig,
} from "../src/index.js"

describe("DeepSeek environment configuration", () => {
  it("keeps the offline Fake model when no API key is configured", () => {
    expect(deepSeekRuntimeConfigFromEnvironment({})).toBeUndefined()
  })

  it("loads model, proxy, timeout, retry, and repair settings", () => {
    expect(deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_BASE_URL: "http://localhost:8787/v1",
      WORLDSEED_DEEPSEEK_MODEL: "deepseek-reasoner",
      WORLDSEED_DEEPSEEK_PROXY_URL: "http://127.0.0.1:7890",
      WORLDSEED_DEEPSEEK_TIMEOUT_MS: "30000",
      WORLDSEED_DEEPSEEK_MAX_ATTEMPTS: "1",
      WORLDSEED_DEEPSEEK_MAX_SCHEMA_REPAIR_ATTEMPTS: "0",
    })).toEqual({
      ...defaultDeepSeekRuntimeConfig,
      baseUrl: "http://localhost:8787/v1",
      model: "deepseek-reasoner",
      proxyUrl: "http://127.0.0.1:7890",
      timeoutMs: 30000,
      maxAttempts: 1,
      maxSchemaRepairAttempts: 0,
    })
  })

  it("rejects malformed numeric settings instead of silently changing them", () => {
    expect(() => deepSeekRuntimeConfigFromEnvironment({
      DEEPSEEK_API_KEY: "test-key",
      WORLDSEED_DEEPSEEK_TIMEOUT_MS: "slow",
    })).toThrow("must be an integer")
  })
})
