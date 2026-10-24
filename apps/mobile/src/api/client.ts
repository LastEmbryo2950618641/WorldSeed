import { PROTOCOL_VERSION, type BackendMethod, type ClientResponse } from "@worldseed/contracts"

export type MobileSession = Readonly<{
  apiBaseUrl: string
  apiToken: string
}>

export type RpcError = Readonly<{
  status: number
  message: string
}>

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "")
}

export function toWsEventsUrl(apiBaseUrl: string, apiToken: string): string {
  const base = trimSlash(apiBaseUrl)
  const wsBase = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.startsWith("http://")
      ? `ws://${base.slice("http://".length)}`
      : base
  const url = new URL(`${wsBase}/events`)
  url.searchParams.set("token", apiToken)
  return url.toString()
}

export async function checkHealth(apiBaseUrl: string): Promise<{ ok: boolean; protocolVersion?: string }> {
  const response = await fetch(`${trimSlash(apiBaseUrl)}/health`)
  if (!response.ok) return { ok: false }
  const body = await response.json() as { ok?: boolean; protocolVersion?: string }
  return {
    ok: body.ok === true,
    ...(body.protocolVersion === undefined ? {} : { protocolVersion: body.protocolVersion }),
  }
}

export async function invokeRpc<T>(
  session: MobileSession,
  method: BackendMethod,
  payload: unknown,
  requestId: string = cryptoRandomUuid(),
): Promise<T> {
  const response = await fetch(`${trimSlash(session.apiBaseUrl)}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.apiToken}`,
    },
    body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method,
      payload,
    }),
  })
  if (response.status === 401) {
    throw Object.assign(new Error("Unauthorized: check API token"), { status: 401 } satisfies RpcError)
  }
  const body = await response.json() as ClientResponse
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${String(response.status)}`), { status: response.status } satisfies RpcError)
  }
  if (!body.ok) {
    throw new Error(body.error.message)
  }
  return body.data as T
}

/** Node 18+ / RN modern: crypto.randomUUID; fallback for older. */
export function cryptoRandomUuid(): string {
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === "function") return c.randomUUID()
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (ch) => {
    const n = Math.floor(Math.random() * 16)
    const v = ch === "x" ? n : (n & 0x3) | 0x8
    return v.toString(16)
  })
}

export type ProjectListItem = Readonly<{
  projectId: string
  displayName: string
  workspaceRootRef: string
}>

export type ChapterListItem = Readonly<{
  chapterSequence: number
  title?: string
  path?: string
}>
