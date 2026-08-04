import { join } from "node:path"

import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from "electron"
import type { ClientRequest, ClientResponse } from "@worldseed/contracts"

export type BackendProcessOptions = Readonly<{
  applicationDataRoot: string
  promptPackageRoot: string
}>

export class BackendProcess {
  private child: UtilityProcess | undefined
  private port: MessagePortMain | undefined
  private readonly pending = new Map<string, {
    resolve: (response: ClientResponse) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()

  public start(options: BackendProcessOptions): void {
    if (this.child !== undefined) return
    const child = utilityProcess.fork(join(import.meta.dirname, "backend-host.js"), [], {
      env: { ...process.env },
      serviceName: "Worldseed Backend",
      stdio: "pipe",
    })
    const { port1, port2 } = new MessageChannelMain()
    port1.on("message", (event) => { this.receive(event.data as ClientResponse); })
    port1.start()
    child.postMessage({ type: "connect", options }, [port2])
    child.on("exit", (code) => {
      this.rejectAll(new Error(`Backend Utility Process exited with code ${String(code)}`))
      this.child = undefined
      this.port = undefined
    })
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk))
    this.child = child
    this.port = port1
  }

  public invoke(request: ClientRequest): Promise<ClientResponse> {
    if (this.port === undefined) return Promise.reject(new Error("Backend Utility Process is not running"))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error(`Backend request timed out: ${request.method}`))
      }, 180_000)
      this.pending.set(request.requestId, { resolve, reject, timeout })
      this.port?.postMessage(request)
    })
  }

  public close(): void {
    this.rejectAll(new Error("Backend Utility Process is shutting down"))
    this.port?.close()
    this.child?.kill()
    this.port = undefined
    this.child = undefined
  }

  private receive(response: ClientResponse): void {
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    pending.resolve(response)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
