import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"

import { PROTOCOL_VERSION, type ClientResponse } from "@worldseed/contracts"
import { WebSocketServer, type WebSocket } from "ws"

import type { BackendFacade } from "../../bootstrap/backend-facade.js"
import { errorDetails, runtimeLog } from "../../infrastructure/diagnostics/index.js"
import {
  extractBearerToken,
  isAuthorized,
  type ApiTokenAuthConfig,
} from "./api-token-auth.js"

export type HttpWsTransportOptions = Readonly<{
  host: string
  port: number
  auth: ApiTokenAuthConfig
  /** Allowed CORS origin; use * for mobile Expo Go debugging. */
  corsOrigin: string
}>

type WsClient = Readonly<{
  socket: WebSocket
  id: string
}>

/**
 * HTTP JSON-RPC + WebSocket fan-out for remote clients (Android / LAN).
 * Desktop continues to use MessagePort; this is an additional entry.
 */
export class HttpWsTransport {
  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private readonly clients = new Map<string, WsClient>()

  public constructor(
    private readonly facade: BackendFacade,
    private readonly options: HttpWsTransportOptions,
  ) {}

  public async listen(): Promise<{ host: string; port: number }> {
    if (this.server !== undefined) {
      return { host: this.options.host, port: this.options.port }
    }
    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    const wss = new WebSocketServer({ server, path: "/events" })
    wss.on("connection", (socket, req) => {
      this.handleWsConnection(socket, req)
    })
    this.server = server
    this.wss = wss
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.options.port, this.options.host, () => resolve())
    })
    runtimeLog("info", "http-ws-transport", "listening", {
      host: this.options.host,
      port: this.options.port,
      authRequired: this.options.auth.requireToken || this.options.auth.tokens.length > 0,
    })
    return { host: this.options.host, port: this.options.port }
  }

  /** Broadcast a JSON event to all authenticated WS clients (optional push). */
  public broadcast(event: unknown): void {
    const payload = JSON.stringify(event)
    for (const client of this.clients.values()) {
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload)
      }
    }
  }

  public async close(): Promise<void> {
    for (const client of this.clients.values()) {
      client.socket.close()
    }
    this.clients.clear()
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve())
      if (this.wss === undefined) resolve()
    })
    await new Promise<void>((resolve, reject) => {
      if (this.server === undefined) {
        resolve()
        return
      }
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.server = undefined
    this.wss = undefined
    await this.facade.close()
  }

  private handleWsConnection(socket: WebSocket, req: IncomingMessage): void {
    const token = extractBearerToken(headerValue(req.headers.authorization))
      ?? queryToken(req.url)
    if (!isAuthorized(this.options.auth, token)) {
      socket.close(4401, "unauthorized")
      return
    }
    const id = randomUUID()
    this.clients.set(id, { socket, id })
    runtimeLog("debug", "http-ws-transport", "ws.connected", { clientId: id, clients: this.clients.size })
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: id,
    }))
    socket.on("message", (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data)) as unknown
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid_json" }))
        return
      }
      if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", atMs: Date.now() }))
        return
      }
      if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "subscribe") {
        socket.send(JSON.stringify({ type: "subscribed", atMs: Date.now() }))
        return
      }
      socket.send(JSON.stringify({ type: "ack", atMs: Date.now() }))
    })
    socket.on("close", () => {
      this.clients.delete(id)
      runtimeLog("debug", "http-ws-transport", "ws.disconnected", { clientId: id, clients: this.clients.size })
    })
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(res)
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        this.json(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          service: "worldseed-backend-http",
        })
        return
      }
      if (req.method === "POST" && url.pathname === "/rpc") {
        if (!isAuthorized(this.options.auth, extractBearerToken(headerValue(req.headers.authorization)))) {
          this.json(res, 401, { ok: false, error: { code: "unauthorized", message: "Missing or invalid Bearer token" } })
          return
        }
        const body = await readJsonBody(req)
        const response: ClientResponse = await this.facade.handle(body)
        this.json(res, 200, response)
        return
      }
      this.json(res, 404, { ok: false, error: { code: "not_found", message: `No route ${req.method ?? "?"} ${url.pathname}` } })
    } catch (error) {
      runtimeLog("error", "http-ws-transport", "http.failed", { error: errorDetails(error) })
      this.json(res, 500, {
        ok: false,
        error: {
          code: "storage_failure",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", this.options.corsOrigin)
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type")
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    })
    res.end(payload)
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

function queryToken(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url, "http://localhost")
    const token = parsed.searchParams.get("token")
    return token !== null && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (raw.length === 0) return {}
  return JSON.parse(raw) as unknown
}
