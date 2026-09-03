import { describe, expect, it } from "vitest"

import {
  FakeWebResearchAdapter,
  parseDuckDuckGoHits,
  parseBingChinaHits,
  mergeWebSearchHits,
  CompositeWebResearchAdapter,
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

describe("bing china hit parsing", () => {
  it("extracts organic b_algo results", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://zh.wikipedia.org/wiki/Romano-British">Romano-British</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">不列颠罗马时期居民概述。</p></div>
        </li>
        <li class="b_algo">
          <h2><a href="https://example.com/names">Early British names</a></h2>
          <p>Name lists and etymology.</p>
        </li>
      </ol>
    `
    expect(parseBingChinaHits(html, 5)).toEqual([
      {
        title: "Romano-British",
        url: "https://zh.wikipedia.org/wiki/Romano-British",
        snippet: "不列颠罗马时期居民概述。",
      },
      {
        title: "Early British names",
        url: "https://example.com/names",
        snippet: "Name lists and etymology.",
      },
    ])
  })
})

describe("composite web research", () => {
  it("merges concurrent provider hits with preference order and URL dedupe", async () => {
    const bing = new FakeWebResearchAdapter({
      names: [
        { title: "Bing Hit", url: "https://example.com/a", snippet: "from bing" },
        { title: "Shared", url: "https://example.com/shared/", snippet: "bing shared" },
      ],
    })
    const duck = new FakeWebResearchAdapter({
      names: [
        { title: "Duck Hit", url: "https://example.com/b", snippet: "from duck" },
        { title: "Shared Dup", url: "https://example.com/shared", snippet: "duck shared" },
      ],
    })
    const composite = new CompositeWebResearchAdapter({ providers: [bing, duck] })
    await expect(composite.search({ query: "names", maxResults: 5 })).resolves.toEqual([
      { title: "Bing Hit", url: "https://example.com/a", snippet: "from bing" },
      { title: "Shared", url: "https://example.com/shared/", snippet: "bing shared" },
      { title: "Duck Hit", url: "https://example.com/b", snippet: "from duck" },
    ])
  })

  it("survives a failing provider and still returns other hits", async () => {
    const ok = new FakeWebResearchAdapter({
      q: [{ title: "Ok", url: "https://example.com/ok", snippet: "ok" }],
    })
    const failing: typeof ok = {
      search: async () => { throw new Error("blocked") },
      fetchPage: async () => undefined,
    }
    const composite = new CompositeWebResearchAdapter({ providers: [failing, ok] })
    await expect(composite.search({ query: "q", maxResults: 3 })).resolves.toEqual([
      { title: "Ok", url: "https://example.com/ok", snippet: "ok" },
    ])
  })

  it("exports merge helper used by adapters", () => {
    expect(mergeWebSearchHits([
      [{ title: "A", url: "https://a.example/", snippet: "" }],
      [{ title: "A2", url: "https://a.example", snippet: "" }, { title: "B", url: "https://b.example", snippet: "" }],
    ], 2)).toEqual([
      { title: "A", url: "https://a.example/", snippet: "" },
      { title: "B", url: "https://b.example", snippet: "" },
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
