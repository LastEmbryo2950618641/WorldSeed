/** Bearer token auth for HTTP/WS server entry (env-configured, not OS passwords). */

export type ApiTokenAuthConfig = Readonly<{
  /** Accepted raw tokens (already trimmed, non-empty). Empty = auth disabled (dev only). */
  tokens: readonly string[]
  /** When true and tokens empty, reject all authenticated routes. */
  requireToken: boolean
}>

export function loadApiTokenAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApiTokenAuthConfig {
  const multi = env.WORLDSEED_API_TOKENS?.split(/[,\s]+/u).map((t) => t.trim()).filter((t) => t.length > 0) ?? []
  const single = env.WORLDSEED_API_TOKEN?.trim()
  const tokens = [...new Set([
    ...multi,
    ...(single !== undefined && single.length > 0 ? [single] : []),
  ])]
  const requireToken = env.WORLDSEED_HTTP_AUTH_OPTIONAL !== "true"
  return { tokens, requireToken }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) return undefined
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(authorizationHeader.trim())
  return match?.[1]
}

export function isAuthorized(
  config: ApiTokenAuthConfig,
  presentedToken: string | undefined,
): boolean {
  if (config.tokens.length === 0) {
    return !config.requireToken
  }
  if (presentedToken === undefined || presentedToken.length === 0) return false
  return config.tokens.includes(presentedToken)
}
