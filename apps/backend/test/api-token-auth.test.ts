import { describe, expect, it } from "vitest"

import {
  extractBearerToken,
  isAuthorized,
  loadApiTokenAuthFromEnv,
} from "../src/transport/http/api-token-auth.js"

describe("api token auth", () => {
  it("loads single and multi tokens from env", () => {
    const config = loadApiTokenAuthFromEnv({
      WORLDSEED_API_TOKEN: " alpha ",
      WORLDSEED_API_TOKENS: "beta, gamma",
    })
    expect(config.tokens).toEqual(["beta", "gamma", "alpha"])
    expect(config.requireToken).toBe(true)
  })

  it("allows optional auth when flagged and no tokens", () => {
    const config = loadApiTokenAuthFromEnv({ WORLDSEED_HTTP_AUTH_OPTIONAL: "true" })
    expect(config.tokens).toEqual([])
    expect(isAuthorized(config, undefined)).toBe(true)
  })

  it("rejects missing token when tokens configured", () => {
    const config = loadApiTokenAuthFromEnv({ WORLDSEED_API_TOKEN: "secret" })
    expect(isAuthorized(config, undefined)).toBe(false)
    expect(isAuthorized(config, "wrong")).toBe(false)
    expect(isAuthorized(config, "secret")).toBe(true)
  })

  it("parses Bearer header", () => {
    expect(extractBearerToken("Bearer tok-1")).toBe("tok-1")
    expect(extractBearerToken("bearer tok-1")).toBe("tok-1")
    expect(extractBearerToken("Basic x")).toBeUndefined()
  })
})
