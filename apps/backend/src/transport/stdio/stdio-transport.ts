import { createInterface } from "node:readline"

import type { ClientResponse } from "@worldseed/contracts"

import type { BackendFacade } from "../../bootstrap/backend-facade.js"

export class StdioTransport {
  private readonly input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  private pending: Promise<void> = Promise.resolve()

  public constructor(private readonly facade: BackendFacade) {}

  public attach(): void {
    this.input.on("line", (line) => {
      if (line.trim().length === 0) return
      this.pending = this.pending.then(() => this.handle(line))
    })
    this.input.on("close", () => {
      void this.pending.then(() => this.facade.close())
    })
  }

  public async handle(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch {
      message = line
    }
    const response: ClientResponse = await this.facade.handle(message)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }

  public async close(): Promise<void> {
    this.input.close()
    await this.facade.close()
  }
}
