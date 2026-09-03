import { join } from "node:path"

import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from "electron"
import type { ClientRequest, ClientResponse } from "@worldseed/contracts"
import { errorDetails, runtimeLog } from "@worldseed/backend"
import type { RuntimeDiagnosticsConfig } from "@worldseed/config"

export type BackendProcessOptions = Readonly<{
  applicationDataRoot: string
  promptPackageRoot: string
  diagnostics: RuntimeDiagnosticsConfig
}>

export type BackendWaitTimeoutInfo = Readonly<{
  requestId: string
  method: string
  waitTimeoutMs: number
  elapsedMs: number
}>

export type BackendInvokeOptions = Readonly<{
  /** Soft wait interval before prompting; does not auto-reject. Default 10 minutes. */
  waitTimeoutMs?: number
  onWaitTimeout?: (info: BackendWaitTimeoutInfo) => void
}>

export class BackendRequestAbandonedError extends Error {
  public readonly requestId: string
  public readonly method: string

  public constructor(requestId: string, method: string) {
    super(`Backend request abandoned: ${method}`)
    this.name = "BackendRequestAbandonedError"
    this.requestId = requestId
    this.method = method
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 600_000

type PendingRequest = {
  resolve: (response: ClientResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
  waitTimeoutMs: number
  method: string
  startedAtMs: number
  onWaitTimeout?: (info: BackendWaitTimeoutInfo) => void
}

export class BackendProcess {
  private child: UtilityProcess | undefined
  private port: MessagePortMain | undefined
  private readonly pending = new Map<string, PendingRequest>()

  public start(options: BackendProcessOptions): void {
    if (this.child !== undefined) return
    runtimeLog("debug", "backend-process", "utility.starting", {
      applicationDataRoot: options.applicationDataRoot,
      promptPackageRoot: options.promptPackageRoot,
    })
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
      runtimeLog(code === 0 ? "info" : "error", "backend-process", "utility.exited", { code })
      this.rejectAll(new Error(`Backend Utility Process exited with code ${String(code)}`))
      this.child = undefined
      this.port = undefined
    })
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk))
    this.child = child
    this.port = port1
  }

  public invoke(request: ClientRequest, options: BackendInvokeOptions = {}): Promise<ClientResponse> {
    if (this.port === undefined) return Promise.reject(new Error("Backend Utility Process is not running"))
    const startedAtMs = Date.now()
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    runtimeLog("debug", "backend-process", "request.sent", {
      requestId: request.requestId,
      method: request.method,
      waitTimeoutMs,
    })
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: undefined,
        waitTimeoutMs,
        method: request.method,
        startedAtMs,
        ...(options.onWaitTimeout === undefined ? {} : { onWaitTimeout: options.onWaitTimeout }),
      }
      this.pending.set(request.requestId, pending)
      this.armSoftWaitTimer(request.requestId, pending)
      this.port?.postMessage(request)
    })
  }

  /** Extend soft wait by another configured interval after the user chooses to continue. */
  public continueWait(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    runtimeLog("info", "backend-process", "request.wait_continued", {
      requestId,
      method: pending.method,
      waitTimeoutMs: pending.waitTimeoutMs,
      elapsedMs: Date.now() - pending.startedAtMs,
    })
    this.armSoftWaitTimer(requestId, pending)
    return true
  }

  /** Stop waiting for a response; late backend replies are ignored. */
  public abandon(requestId: string): boolean {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(requestId)
    runtimeLog("info", "backend-process", "request.abandoned", {
      requestId,
      method: pending.method,
      elapsedMs: Date.now() - pending.startedAtMs,
    })
    pending.reject(new BackendRequestAbandonedError(requestId, pending.method))
    return true
  }

  public close(): void {
    this.rejectAll(new Error("Backend Utility Process is shutting down"))
    this.port?.close()
    this.child?.kill()
    this.port = undefined
    this.child = undefined
  }

  private armSoftWaitTimer(requestId: string, pending: PendingRequest): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      const current = this.pending.get(requestId)
      if (current === undefined) return
      current.timer = undefined
      const info: BackendWaitTimeoutInfo = {
        requestId,
        method: current.method,
        waitTimeoutMs: current.waitTimeoutMs,
        elapsedMs: Date.now() - current.startedAtMs,
      }
      runtimeLog("warn", "backend-process", "request.wait_timeout", info)
      // Soft timeout: keep the pending request alive until continueWait or abandon.
      current.onWaitTimeout?.(info)
    }, pending.waitTimeoutMs)
  }

  private receive(response: ClientResponse): void {
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    runtimeLog(response.ok ? "debug" : "error", "backend-process", "response.received", {
      requestId: response.requestId,
      ok: response.ok,
      ...(response.ok ? {} : { error: response.error }),
    })
    pending.resolve(response)
  }

  private rejectAll(error: Error): void {
    runtimeLog("error", "backend-process", "pending_requests.rejected", {
      count: this.pending.size,
      error: errorDetails(error),
    })
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
