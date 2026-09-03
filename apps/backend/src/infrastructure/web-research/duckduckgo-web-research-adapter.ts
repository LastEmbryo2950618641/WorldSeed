import type {
  WebPageContent,
  WebResearchFetchInput,
  WebResearchPort,
  WebResearchSearchInput,
  WebSearchHit,
} from "../../application/retrieval/ports/web-research-port.js"
import { decodeHtmlEntities, htmlToPlainText, isHttpUrl } from "./web-url-safety.js"
import { WebResearchHttpClient, type WebResearchHttpClientOptions } from "./web-research-http.js"

export type DuckDuckGoWebResearchAdapterOptions = WebResearchHttpClientOptions & Readonly<{
  searchEndpoint?: string
}>

/**
 * Public web research via DuckDuckGo HTML results + bounded page fetch.
 * Search HTML scraping is best-effort; failures return empty hits rather than aborting the turn.
 */
export class DuckDuckGoWebResearchAdapter implements WebResearchPort {
  private readonly searchEndpoint: string
  private readonly http: WebResearchHttpClient

  public constructor(options: DuckDuckGoWebResearchAdapterOptions = {}) {
    this.searchEndpoint = options.searchEndpoint ?? "https://html.duckduckgo.com/html/"
    this.http = new WebResearchHttpClient(options)
  }

  public async search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]> {
    const query = input.query.trim()
    if (query.length === 0 || input.maxResults <= 0) return []
    const endpoint = new URL(this.searchEndpoint)
    endpoint.searchParams.set("q", query)
    const html = await this.http.readText(endpoint.toString(), input.signal)
    return parseDuckDuckGoHits(html, input.maxResults)
  }

  public async fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined> {
    return this.http.fetchPage(input)
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
