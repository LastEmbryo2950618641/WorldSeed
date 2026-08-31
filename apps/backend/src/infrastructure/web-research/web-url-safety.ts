import { isIP } from "node:net"
import { lookup } from "node:dns/promises"

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
  "kubernetes.default",
  "kubernetes.default.svc",
])

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid web URL: ${rawUrl}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed: ${rawUrl}`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`Web URLs must not include credentials: ${url.origin}`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase()
  if (hostname.length === 0 || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked web hostname: ${hostname || "(empty)"}`)
  }
  if (isIP(hostname) !== 0 && isPrivateOrSpecialIp(hostname)) {
    throw new Error(`Blocked private or special-use IP: ${hostname}`)
  }
  return url
}

export async function assertPublicHttpUrlResolved(rawUrl: string): Promise<URL> {
  const url = assertPublicHttpUrl(rawUrl)
  const hostname = url.hostname.replace(/^\[|\]$/gu, "")
  if (isIP(hostname) !== 0) return url
  const records = await lookup(hostname, { all: true, verbatim: true })
  if (records.length === 0) throw new Error(`Unable to resolve web hostname: ${hostname}`)
  for (const record of records) {
    if (isPrivateOrSpecialIp(record.address)) {
      throw new Error(`Blocked resolved address for ${hostname}: ${record.address}`)
    }
  }
  return url
}

export function isPrivateOrSpecialIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === "::" || normalized === "::1" || normalized === "0.0.0.0") return true
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  if (normalized.includes(".")) {
    const parts = normalized.split(".").map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
    const [a = 0, b = 0] = parts
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast / reserved
    return false
  }
  // IPv4-mapped IPv6
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mapped?.[1] !== undefined) return isPrivateOrSpecialIp(mapped[1])
  return false
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim()
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&nbsp;/giu, " ")
}
