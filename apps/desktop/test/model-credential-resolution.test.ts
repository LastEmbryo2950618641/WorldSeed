import { describe, expect, it, vi } from "vitest"

import { resolveModelCredential } from "../src/main/model-credential-resolution.js"

describe("resolveModelCredential", () => {
  it("injects the selected model credential from the desktop vault", async () => {
    const get = vi.fn(async (reference: string) => reference === "model-profile:gpt-aiwanwu" ? "gpt-key" : undefined)
    const payload = {
      revisionTaskId: "revision-1",
      model: {
        baseUrl: "https://www.aiwanwu.cc",
        model: "gpt-5.6-sol",
        credentialRef: "model-profile:gpt-aiwanwu",
      },
    }

    await expect(resolveModelCredential(payload, { get })).resolves.toEqual({
      ...payload,
      model: { ...payload.model, apiKey: "gpt-key" },
    })
    expect(get).toHaveBeenCalledWith("model-profile:gpt-aiwanwu")
  })

  it("keeps an explicitly supplied credential without reading the vault", async () => {
    const get = vi.fn(async () => "stored-key")
    const payload = { model: { credentialRef: "model-profile:custom", apiKey: "request-key" } }

    await expect(resolveModelCredential(payload, { get })).resolves.toBe(payload)
    expect(get).not.toHaveBeenCalled()
  })
})
