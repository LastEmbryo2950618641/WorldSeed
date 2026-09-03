import type {
  WebPageContent,
  WebResearchFetchInput,
  WebResearchPort,
  WebResearchSearchInput,
  WebSearchHit,
} from "../../application/retrieval/ports/web-research-port.js"
import { decodeHtmlEntities, htmlToPlainText, isHttpUrl } from "./web-url-safety.js"
import { WebResearchHttpClient, type WebResearchHttpClientOptions } from "./web-research-http.js"

export type BingChinaWebResearchAdapterOptions = WebResearchHttpClientOptions & Readonly<{
  searchEndpoint?: string
}>

/**
 * Public web research via Bing China HTML results (`cn.bing.com`).
 * Prefer this for mainland networks where DuckDuckGo is often unreachable.
 */
export class BingChinaWebResearchAdapter implements WebResearchPort {
  private readonly searchEndpoint: string
  private readonly http: WebResearchHttpClient

  public constructor(options: BingChinaWebResearchAdapterOptions = {}) {
    this.searchEndpoint = options.searchEndpoint ?? "https://cn.bing.com/search"
    this.http = new WebResearchHttpClient(options)
  }

  public async search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]> {
    const query = input.query.trim()
    if (query.length === 0 || input.maxResults <= 0) return []
    const endpoint = new URL(this.searchEndpoint)
    endpoint.searchParams.set("q", query)
    endpoint.searchParams.set("setlang", "zh-cn")
    endpoint.searchParams.set("ensearch", "0")
    const html = await this.http.readText(endpoint.toString(), input.signal)
    return parseBingChinaHits(html, input.maxResults)
  }

  public async fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined> {
    return this.http.fetchPage(input)
  }
}

export function parseBingChinaHits(html: string, maxResults: number): readonly WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  // Classic Bing organic results: <li class="b_algo"> ... <h2><a href="...">title</a></h2> ... <p> or .b_caption
  const blockPattern = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/giu
  let block: RegExpExecArray | null
  while ((block = blockPattern.exec(html)) !== null && hits.length < maxResults) {
    const body = block[1] ?? ""
    const linkMatch = body.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu)
    if (linkMatch === null) continue
    const url = decodeHtmlEntities(linkMatch[1] ?? "").trim()
    const title = decodeHtmlEntities(htmlToPlainText(linkMatch[2] ?? "")).trim()
    if (!isHttpUrl(url) || title.length === 0) continue
    const normalized = normalizeHitUrl(url)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const snippetMatch = body.match(/class="[^"]*\bb_lineclamp\d*\b[^"]*"[^>]*>([\s\S]*?)<\//iu)
      ?? body.match(/<p[^>]*>([\s\S]*?)<\/p>/iu)
      ?? body.match(/class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\//iu)
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

function normalizeHitUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.toString().replace(/\/$/u, "").toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}
