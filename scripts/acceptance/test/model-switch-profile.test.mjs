import { describe, expect, it } from "vitest"

import { planModelSwitch } from "../lib/model-switch-profile.mjs"

describe("model switch acceptance profile plan", () => {
  it("temporarily reuses the active credential reference without exposing the key", () => {
    const profiles = [
      profile("flash", "deepseek-v4-flash", "credential:flash", true),
      profile("pro", "deepseek-v4-pro", "credential:pro", false),
    ]

    const plan = planModelSwitch(profiles, "flash")

    expect(plan?.target.id).toBe("pro")
    expect(plan?.switchProfiles.find((item) => item.id === "pro")).toMatchObject({
      credentialRef: "credential:flash",
      apiKey: "",
      hasApiKey: true,
    })
    expect(profiles[1]).toMatchObject({ credentialRef: "credential:pro", hasApiKey: false })
  })

  it("returns no plan when no different model exists", () => {
    const profiles = [
      profile("flash-a", "deepseek-v4-flash", "credential:a", true),
      profile("flash-b", "deepseek-v4-flash", "credential:b", false),
    ]

    expect(planModelSwitch(profiles, "flash-a")).toBeUndefined()
  })
})

function profile(id, model, credentialRef, hasApiKey) {
  return {
    id,
    name: id,
    baseUrl: "https://api.deepseek.com",
    model,
    credentialRef,
    contextWindowTokens: 1_000_000,
    apiKey: "",
    hasApiKey,
    thinkingModeEnabled: true,
    reasoningEffort: "high",
    jsonModeEnabled: false,
  }
}
