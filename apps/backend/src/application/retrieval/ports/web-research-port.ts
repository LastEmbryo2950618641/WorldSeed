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

/**
 * Sandboxed public-internet research used by `sourceKinds: ["web"]` reads.
 * Implementations must enforce SSRF limits and size/time caps.
 */
export interface WebResearchPort {
  search(input: WebResearchSearchInput): Promise<readonly WebSearchHit[]>
  fetchPage(input: WebResearchFetchInput): Promise<WebPageContent | undefined>
}
