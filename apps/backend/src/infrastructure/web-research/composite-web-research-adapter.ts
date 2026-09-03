import type {
  WebPageContent,
  WebResearchFetchInput,
  WebResearchPort,
  WebResearchProviderAttempt,
  WebResearchSearchDetail,
  WebResearchSearchInput,
  WebSearchHit,
} from "../../application/retrieval/ports/web-research-port.js"
import { BingChinaWebResearchAdapter } from "./bing-china-web-research-adapter.js"
import { DuckDuckGoWebResearchAdapter } from "./duckduckgo-web-research-adapter.js"
import { WebResearchHttpClient } from "./web-research-http.js"

export type CompositeWebResearchProvider = Readonly<{
  name: string
  port: WebResearchPort
}>

export type CompositeWebResearchAdapterOptions = Readonly<{
  providers: readonly (WebResearchPort | CompositeWebResearchProvider)[]
  /** Extra page fetcher when providers' fetchPage are unavailable; defaults to shared HTTP client. */
  pageFetcher?: WebResearchPort
}>

/**
 * Fan-out search across multiple providers concurrently, merge/dedupe by URL.
 * Provider order is preference order when ranking ties (Bing China first by default).
 */
export class CompositeWebResearchAdapter implements WebResearchPort {
  private readonly providers: readonly CompositeWebResearchProvider[]
  private readonly pageFetcher: WebResearchPort

  public constructor(options: CompositeWebResearchAdapterOptions) {
    if (options.providers.length === 0) {
      throw new Error("CompositeWebResearchAdapter requires at least one provider")
    }
    this.providers = options.providers.map((entry, index) => (
      "port" in entry ? entry : { name: `provider-${String(index)}`, port: entry }
    ))
    this.pageFetcher = options.pageFetcher ?? this.providers[0]!.port
  }

  public async search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]> {
    const detail = await this.searchDetailed(input)
    return detail.hits
  }

  public async searchDetailed(input: WebResearchSearchInput): Promise<WebResearchSearchDetail> {
    const query = input.query.trim()
    if (query.length === 0 || input.maxResults <= 0) {
      return { hits: [], attempts: [] }
    }
    const perProvider = Math.max(input.maxResults, Math.min(10, input.maxResults * 2))
    const settled = await Promise.allSettled(
      this.providers.map(({ name, port }) => port.search({
        query,
        maxResults: perProvider,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }).then((hits) => ({ name, hits }))),
    )
    const attempts: WebResearchProviderAttempt[] = []
    const ranked: WebSearchHit[] = []
    const seen = new Set<string>()
    for (const result of settled) {
      if (result.status === "rejected") {
        attempts.push({
          provider: providerNameFromRejection(result.reason),
          status: "error",
          message: errorMessage(result.reason),
        })
        continue
      }
      const { name, hits } = result.value
      attempts.push(hits.length === 0
        ? { provider: name, status: "empty" }
        : { provider: name, status: "ok", hitCount: hits.length })
      for (const hit of hits) {
        const key = normalizeHitUrl(hit.url)
        if (seen.has(key)) continue
        seen.add(key)
        ranked.push(hit)
        if (ranked.length >= input.maxResults) {
          return { hits: ranked, attempts }
        }
      }
    }
    return { hits: ranked, attempts }
  }

  public async fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined> {
    for (const provider of [this.pageFetcher, ...this.providers.map((entry) => entry.port)]) {
      try {
        const page = await provider.fetchPage(input)
        if (page !== undefined) return page
      } catch {
        // try next
      }
    }
    return undefined
  }
}

function providerNameFromRejection(reason: unknown): string {
  if (typeof reason === "object" && reason !== null && "name" in reason) {
    const name = (reason as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return "unknown"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Default stack: Bing China (domestic) + DuckDuckGo (fallback), concurrent merge. */
export function createDefaultWebResearchPort(): WebResearchPort {
  const http = new WebResearchHttpClient()
  const bing = new BingChinaWebResearchAdapter()
  const duck = new DuckDuckGoWebResearchAdapter()
  return new CompositeWebResearchAdapter({
    providers: [
      { name: "Bing China", port: bing },
      { name: "DuckDuckGo", port: duck },
    ],
    pageFetcher: {
      search: async () => [],
      fetchPage: (input) => http.fetchPage(input),
    },
  })
}

export function mergeWebSearchHits(
  providerHitLists: readonly (readonly WebSearchHit[])[],
  maxResults: number,
): readonly WebSearchHit[] {
  const ranked: WebSearchHit[] = []
  const seen = new Set<string>()
  for (const hits of providerHitLists) {
    for (const hit of hits) {
      const key = normalizeHitUrl(hit.url)
      if (seen.has(key)) continue
      seen.add(key)
      ranked.push(hit)
      if (ranked.length >= maxResults) return ranked
    }
  }
  return ranked
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
