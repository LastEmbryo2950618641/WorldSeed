import { describe, expect, it } from "vitest"

import {
  FakeWebResearchAdapter,
  parseDuckDuckGoHits,
  assertPublicHttpUrl,
  isPrivateOrSpecialIp,
  htmlToPlainText,
} from "../src/infrastructure/web-research/index.js"

describe("web url safety", () => {
  it("blocks private and special-use addresses", () => {
    expect(isPrivateOrSpecialIp("127.0.0.1")).toBe(true)
    expect(isPrivateOrSpecialIp("10.0.0.8")).toBe(true)
    expect(isPrivateOrSpecialIp("192.168.1.1")).toBe(true)
    expect(isPrivateOrSpecialIp("169.254.169.254")).toBe(true)
    expect(isPrivateOrSpecialIp("::1")).toBe(true)
    expect(isPrivateOrSpecialIp("8.8.8.8")).toBe(false)
  })

  it("rejects non-http URLs and localhost hosts", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(/http/)
    expect(() => assertPublicHttpUrl("http://localhost/admin")).toThrow(/Blocked/)
    expect(() => assertPublicHttpUrl("https://example.com/path")).not.toThrow()
  })

  it("strips scripts when converting HTML to text", () => {
    expect(htmlToPlainText("<p>hello</p><script>alert(1)</script><p>world</p>")).toBe("hello\n world")
  })
})

describe("duckduckgo hit parsing", () => {
  it("extracts titles, urls, and snippets from HTML results", () => {
    const html = `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha Title</a>
      <a class="result__snippet" href="#">Alpha snippet about research.</a>
      <a rel="nofollow" class="result__a" href="https://example.com/beta">Beta Title</a>
      <a class="result__snippet" href="#">Beta snippet.</a>
    `
    expect(parseDuckDuckGoHits(html, 2)).toEqual([
      {
        title: "Alpha Title",
        url: "https://example.com/alpha",
        snippet: "Alpha snippet about research.",
      },
      {
        title: "Beta Title",
        url: "https://example.com/beta",
        snippet: "Beta snippet.",
      },
    ])
  })
})

describe("FakeWebResearchAdapter", () => {
  it("returns configured search hits and pages", async () => {
    const adapter = new FakeWebResearchAdapter(
      {
        tea: [{ title: "Tea", url: "https://example.com/tea", snippet: "Camellia sinensis" }],
      },
      {
        "https://example.com/tea": {
          url: "https://example.com/tea",
          title: "Tea",
          text: "Tea is a drink.",
        },
      },
    )
    await expect(adapter.search({ query: "tea", maxResults: 3 })).resolves.toEqual([
      { title: "Tea", url: "https://example.com/tea", snippet: "Camellia sinensis" },
    ])
    await expect(adapter.fetchPage({ url: "https://example.com/tea" })).resolves.toMatchObject({
      text: "Tea is a drink.",
    })
  })
})
