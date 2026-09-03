export type WebSearchHit = Readonly<{
  title: string
  url: string
  snippet: string
}>

export type WebPageContent = Readonly<{
  url: string
  title: string
  text: string
}>

export type WebResearchSearchInput = Readonly<{
  query: string
  maxResults: number
  signal?: AbortSignal
}>

export type WebResearchFetchInput = Readonly<{
  url: string
  signal?: AbortSignal
}>

export type WebResearchProviderAttempt = Readonly<{
  provider: string
  status: "ok" | "empty" | "error"
  hitCount?: number
  message?: string
}>

/** Search outcome with per-provider diagnostics for model-visible failure reporting. */
export type WebResearchSearchDetail = Readonly<{
  hits: readonly WebSearchHit[]
  attempts: readonly WebResearchProviderAttempt[]
}>

/**
 * Sandboxed public-internet research used by `sourceKinds: ["web"]` reads.
 * Implementations must enforce SSRF limits and size/time caps.
 */
export interface WebResearchPort {
  search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]>
  fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined>
  /** Optional detailed search; defaults to `{ hits, attempts: [] }` when absent. */
  searchDetailed?(input: WebResearchSearchInput): Promise<WebResearchSearchDetail>
}
