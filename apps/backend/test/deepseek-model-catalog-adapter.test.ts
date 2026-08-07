import { describe, expect, it, vi } from "vitest"

import { DeepSeekModelCatalogAdapter } from "../src/index.js"

describe("DeepSeekModelCatalogAdapter", () => {
  it("loads, deduplicates, and sorts the authenticated DeepSeek model list", async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
        { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
        { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })))
    const adapter = new DeepSeekModelCatalogAdapter(request)

    const result = await adapter.list({ baseUrl: "https://api.deepseek.com", apiKey: "test-key" })

    expect(result.models).toEqual([
      { id: "deepseek-chat", ownedBy: "deepseek" },
      { id: "deepseek-reasoner", ownedBy: "deepseek" },
    ])
    expect(request).toHaveBeenCalledOnce()
    const [endpoint, options] = request.mock.calls[0] ?? []
    expect(endpoint).toBeInstanceOf(URL)
    if (!(endpoint instanceof URL)) throw new Error("DeepSeek model endpoint was not a URL")
    expect(endpoint.href).toBe("https://api.deepseek.com/models")
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-key" })
  })

  it("rejects insecure remote model endpoints before requesting", async () => {
    const request = vi.fn<typeof fetch>()
    const adapter = new DeepSeekModelCatalogAdapter(request)

    await expect(adapter.list({ baseUrl: "http://api.deepseek.com", apiKey: "test-key" }))
      .rejects.toThrow("HTTPS")
    expect(request).not.toHaveBeenCalled()
  })

  it("reports authentication failures without exposing the API key", async () => {
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, {
      status: 401,
      statusText: "Unauthorized",
    })))
    const adapter = new DeepSeekModelCatalogAdapter(request)

    await expect(adapter.list({ baseUrl: "https://api.deepseek.com/v1", apiKey: "secret-value" }))
      .rejects.toThrow("401 Unauthorized")
    await adapter.list({ baseUrl: "https://api.deepseek.com/v1", apiKey: "secret-value" }).catch((error: unknown) => {
      expect(String(error)).not.toContain("secret-value")
    })
  })
})
