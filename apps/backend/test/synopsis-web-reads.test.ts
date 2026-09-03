import { describe, expect, it } from "vitest"

import { executeSynopsisWebReads } from "../src/application/chapters/synopsis-web-reads.js"
import type { WebResearchPort, WebResearchSearchDetail } from "../src/application/retrieval/ports/web-research-port.js"
import { FakeWebResearchAdapter } from "../src/infrastructure/web-research/duckduckgo-web-research-adapter.js"
import { CompositeWebResearchAdapter } from "../src/infrastructure/web-research/composite-web-research-adapter.js"

describe("executeSynopsisWebReads", () => {
  it("returns search hit evidence for the model", async () => {
    const port = new FakeWebResearchAdapter({
      "Brythonic names": [{
        title: "Example",
        url: "https://example.com/names",
        snippet: "A list of names.",
      }],
    })
    const evidence = await executeSynopsisWebReads({
      requests: [{
        requestId: "r1",
        reason: "test",
        query: {
          sourceKinds: ["web"],
          exactKeys: [],
          semanticTexts: ["Brythonic names"],
          maxCandidates: 5,
        },
        expectedEvidence: "",
      }],
      existingEvidence: [],
      createId: () => "id-1",
      webResearch: port,
    })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.ownerKind).toBe("web:search")
    expect(evidence[0]?.semanticText).toContain("联网检索结果")
    expect(evidence[0]?.semanticText).toContain("https://example.com/names")
  })

  it("returns diagnostic evidence when all providers fail", async () => {
    const failing: WebResearchPort = {
      search: async () => { throw new Error("network timeout") },
      fetchPage: async () => undefined,
    }
    const port = new CompositeWebResearchAdapter({
      providers: [{ name: "Test", port: failing }],
    })
    const evidence = await executeSynopsisWebReads({
      requests: [{
        requestId: "r1",
        reason: "test",
        query: {
          sourceKinds: ["web"],
          exactKeys: [],
          semanticTexts: ["Roman Britain names"],
          maxCandidates: 3,
        },
        expectedEvidence: "",
      }],
      existingEvidence: [],
      createId: () => "id-1",
      webResearch: port,
    })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.ownerKind).toBe("web:diagnostic")
    expect(evidence[0]?.semanticText).toContain("联网检索未成功")
    expect(evidence[0]?.semanticText).toContain("network timeout")
  })

  it("returns diagnostic evidence when providers return empty hits", async () => {
    const port: WebResearchPort = {
      searchDetailed: async (): Promise<WebResearchSearchDetail> => ({
        hits: [],
        attempts: [
          { provider: "Bing China", status: "empty" },
          { provider: "DuckDuckGo", status: "empty" },
        ],
      }),
      search: async () => [],
      fetchPage: async () => undefined,
    }
    const evidence = await executeSynopsisWebReads({
      requests: [{
        requestId: "r1",
        reason: "test",
        query: {
          sourceKinds: ["web"],
          exactKeys: [],
          semanticTexts: [" obscure query "],
          maxCandidates: 3,
        },
        expectedEvidence: "",
      }],
      existingEvidence: [],
      createId: () => "id-2",
      webResearch: port,
    })
    expect(evidence[0]?.semanticText).toContain("各搜索引擎均无匹配结果")
  })
})
