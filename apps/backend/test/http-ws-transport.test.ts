import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@worldseed/contracts"

import { BackendContainer } from "../src/bootstrap/container.js"
import { BackendFacade } from "../src/bootstrap/backend-facade.js"
import { HttpWsTransport } from "../src/transport/http/http-ws-transport.js"

describe("http ws transport", () => {
  let dataRoot: string | undefined
  let transport: HttpWsTransport | undefined

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true })
      dataRoot = undefined
    }
  })

  it("serves health without auth and rpc with bearer", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "ws-http-"))
    const promptRoot = join(process.cwd(), "packages", "prompt-contracts")
    const container = await BackendContainer.open({
      applicationDataRoot: dataRoot,
      promptPackageRoot: promptRoot,
    })
    const facade = new BackendFacade(container, { automaticEvolutionEnabled: false })
    const port = 18787 + Math.floor(Math.random() * 1000)
    transport = new HttpWsTransport(facade, {
      host: "127.0.0.1",
      port,
      auth: { tokens: ["test-token"], requireToken: true },
      corsOrigin: "*",
    })
    await transport.listen()

    const health = await fetch(`http://127.0.0.1:${String(port)}/health`)
    expect(health.status).toBe(200)
    const healthBody = await health.json() as { ok: boolean; protocolVersion: string }
    expect(healthBody.ok).toBe(true)
    expect(healthBody.protocolVersion).toBe(PROTOCOL_VERSION)

    const denied = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "project.list",
        payload: {},
      }),
    })
    expect(denied.status).toBe(401)

    const ok = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "project.list",
        payload: {},
      }),
    })
    expect(ok.status).toBe(200)
    const rpcBody = await ok.json() as { ok: boolean; data?: { projects?: unknown[] } }
    expect(rpcBody.ok).toBe(true)
    expect(Array.isArray(rpcBody.data?.projects)).toBe(true)
  })
})
