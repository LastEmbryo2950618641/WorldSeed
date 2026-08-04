import type { ClientResponse } from "@worldseed/contracts"

import type { BackendFacade } from "../../bootstrap/backend-facade.js"

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
    this.port.postMessage(response)
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
