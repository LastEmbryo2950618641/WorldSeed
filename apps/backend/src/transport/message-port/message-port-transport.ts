import type { ClientResponse } from "@worldseed/contracts"
import { randomUUID } from "node:crypto"

import type { BackendFacade } from "../../bootstrap/backend-facade.js"
import { errorDetails, runtimeLog } from "../../infrastructure/diagnostics/index.js"

export type BackendMessagePort = Readonly<{
  postMessage(message: ClientResponse): void
  on(event: "message", listener: (message: unknown) => void): void
  start?: () => void
  close?: () => void
}>

export class MessagePortTransport {
  public constructor(private readonly port: BackendMessagePort, private readonly facade: BackendFacade) {}

  public attach(): void {
    this.port.on("message", (message) => {
      void this.handle(message)
    })
    this.port.start?.()
  }

  public async handle(message: unknown): Promise<void> {
    const response = await this.facade.handle(unwrapMessage(message))
    try {
      const responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8")
      runtimeLog("debug", "message-port-transport", "response.sending", {
        requestId: response.requestId,
        responseBytes,
      })
      this.port.postMessage(response)
      runtimeLog("debug", "message-port-transport", "response.sent", {
        requestId: response.requestId,
        responseBytes,
      })
    } catch (error) {
      runtimeLog("error", "message-port-transport", "response.send_failed", {
        requestId: response.requestId,
        error: errorDetails(error),
      })
      const fallback: ClientResponse = {
        protocolVersion: response.protocolVersion,
        requestId: response.requestId,
        ok: false,
        error: {
          code: "storage_failure",
          message: "后端结果无法通过桌面进程传输，原始结果仍保留在持久化存储中。",
          recoverable: true,
          diagnosticId: randomUUID(),
          details: { cause: errorDetails(error) },
        },
      }
      try {
        this.port.postMessage(fallback)
        runtimeLog("debug", "message-port-transport", "response.fallback_sent", {
          requestId: response.requestId,
        })
      } catch (fallbackError) {
        runtimeLog("error", "message-port-transport", "response.fallback_failed", {
          requestId: response.requestId,
          error: errorDetails(fallbackError),
        })
      }
    }
  }

  public async close(): Promise<void> {
    await this.facade.close()
    this.port.close?.()
  }
}

function unwrapMessage(message: unknown): unknown {
  if (typeof message === "object" && message !== null && "data" in message) {
    return message.data
  }
  return message
}
