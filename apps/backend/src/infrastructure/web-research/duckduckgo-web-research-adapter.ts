import { fetch } from "undici"

import type {
  WebPageContent,
  WebResearchFetchInput,
  WebResearchPort,
  WebResearchSearchInput,
  WebSearchHit,
} from "../../application/retrieval/ports/web-research-port.js"
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  decodeHtmlEntities,
  htmlToPlainText,
  isHttpUrl,
} from "./web-url-safety.js"

const DEFAULT_USER_AGENT = "WorldseedDesktop/1.0 (+local research; respectful)"
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 512_000
const MAX_REDIRECTS = 3

export type DuckDuckGoWebResearchAdapterOptions = Readonly<{
  searchEndpoint?: string
  userAgent?: string
  timeoutMs?: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
}>

/**
 * Public web research via DuckDuckGo HTML results + bounded page fetch.
 * Search HTML scraping is best-effort; failures return empty hits rather than aborting the turn.
 */
export class DuckDuckGoWebResearchAdapter implements WebResearchPort {
  private readonly searchEndpoint: string
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImpl: typeof fetch

  public constructor(options: DuckDuckGoWebResearchAdapterOptions = {}) {
    this.searchEndpoint = options.searchEndpoint ?? "https://html.duckduckgo.com/html/"
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  public async search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]> {
    const query = input.query.trim()
    if (query.length === 0 || input.maxResults <= 0) return []
    try {
      const endpoint = new URL(this.searchEndpoint)
      endpoint.searchParams.set("q", query)
      const html = await this.readText(endpoint.toString(), input.signal)
      return parseDuckDuckGoHits(html, input.maxResults)
    } catch {
      return []
    }
  }

  public async fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined> {
    const raw = input.url.trim()
    if (!isHttpUrl(raw)) return undefined
    try {
      await assertPublicHttpUrlResolved(raw)
      const html = await this.readText(raw, input.signal, { followRedirects: true })
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
      const title = titleMatch?.[1] === undefined
        ? raw
        : decodeHtmlEntities(htmlToPlainText(titleMatch[1])).slice(0, 200) || raw
      const text = htmlToPlainText(html).slice(0, 24_000)
      if (text.length === 0) return undefined
      return { url: raw, title, text }
    } catch {
      return undefined
    }
  }

  private async readText(
    rawUrl: string,
    outerSignal: AbortSignal | undefined,
    options: Readonly<{ followRedirects?: boolean }> = {},
  ): Promise<string> {
    let current = assertPublicHttpUrl(rawUrl).toString()
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpUrlResolved(current)
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
      const onAbort = (): void => { controller.abort() }
      outerSignal?.addEventListener("abort", onAbort, { once: true })
      try {
        const response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            "user-agent": this.userAgent,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          },
          signal: controller.signal,
        })
        if (response.status >= 300 && response.status < 400) {
          if (!options.followRedirects) {
            throw new Error(`Unexpected redirect from ${current}`)
          }
          const location = response.headers.get("location")
          if (location === null || location.length === 0) {
            throw new Error(`Redirect without location from ${current}`)
          }
          current = new URL(location, current).toString()
          continue
        }
        if (!response.ok) {
          throw new Error(`Web fetch failed (${String(response.status)}) for ${current}`)
        }
        const contentType = response.headers.get("content-type") ?? ""
        if (contentType.length > 0
          && !contentType.includes("text/")
          && !contentType.includes("json")
          && !contentType.includes("xml")
          && !contentType.includes("html")) {
          throw new Error(`Unsupported content type for web research: ${contentType}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength > this.maxResponseBytes) {
          return buffer.subarray(0, this.maxResponseBytes).toString("utf8")
        }
        return buffer.toString("utf8")
      } finally {
        clearTimeout(timer)
        outerSignal?.removeEventListener("abort", onAbort)
      }
    }
    throw new Error(`Too many redirects fetching ${rawUrl}`)
  }
}

export function parseDuckDuckGoHits(html: string, maxResults: number): readonly WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const resultPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu
  let match: RegExpExecArray | null
  while ((match = resultPattern.exec(html)) !== null && hits.length < maxResults) {
    const href = decodeHtmlEntities(match[1] ?? "").trim()
    const title = decodeHtmlEntities(htmlToPlainText(match[2] ?? "")).trim()
    const url = unwrapDuckDuckGoUrl(href)
    if (!isHttpUrl(url) || title.length === 0) continue
    const snippetWindow = html.slice(match.index, match.index + 1_200)
    const snippetMatch = snippetWindow.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/iu)
      ?? snippetWindow.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//iu)
    const snippet = snippetMatch?.[1] === undefined
      ? ""
      : decodeHtmlEntities(htmlToPlainText(snippetMatch[1])).trim()
    hits.push({
      title: title.slice(0, 200),
      url,
      snippet: snippet.slice(0, 500),
    })
  }
  return hits
}

function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com")
    const uddg = url.searchParams.get("uddg")
    if (uddg !== null && uddg.length > 0) return decodeURIComponent(uddg)
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    return href
  } catch {
    return href
  }
}

export class FakeWebResearchAdapter implements WebResearchPort {
  public constructor(
    private readonly hitsByQuery: Readonly<Record<string, readonly WebSearchHit[]>> = {},
    private readonly pagesByUrl: Readonly<Record<string, WebPageContent>> = {},
  ) {}

  public search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]> {
    const hits = this.hitsByQuery[input.query.trim()] ?? []
    return Promise.resolve(hits.slice(0, input.maxResults))
  }

  public fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined> {
    return Promise.resolve(this.pagesByUrl[input.url.trim()])
  }
}
