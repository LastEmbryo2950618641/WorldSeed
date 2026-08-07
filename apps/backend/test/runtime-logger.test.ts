import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { configureRuntimeDiagnostics, readRuntimeDiagnosticsConfig, runtimeLog } from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  configureRuntimeDiagnostics({ level: "silent", consoleEnabled: false, fileEnabled: false })
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("runtime logger", () => {
  it("writes correlated structured logs and redacts credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "worldseed-log-"))
    temporaryDirectories.push(directory)
    const logFile = join(directory, "runtime", "worldseed.log")
    configureRuntimeDiagnostics({ level: "debug", consoleEnabled: false, fileEnabled: true, filePath: logFile })
    vi.spyOn(console, "info").mockImplementation(() => undefined)

    runtimeLog("debug", "turn-orchestrator", "phase.completed", {
      taskId: "task-1",
      phaseRunId: "phase-1",
      phase: "interpret",
      apiKey: "must-not-leak",
      inputTokens: 123,
    })

    const line = readFileSync(logFile, "utf8").trim()
    const record = JSON.parse(line.replace(/^\[Worldseed\] /u, "")) as Record<string, unknown>
    expect(record).toMatchObject({
      component: "turn-orchestrator",
      event: "phase.completed",
      taskId: "task-1",
      phaseRunId: "phase-1",
      phase: "interpret",
      apiKey: "[redacted]",
      inputTokens: 123,
    })
    expect(line).not.toContain("must-not-leak")
  })

  it("continues writing file logs when the console pipe is closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "worldseed-log-"))
    temporaryDirectories.push(directory)
    const logFile = join(directory, "runtime", "worldseed.log")
    configureRuntimeDiagnostics({ level: "debug", consoleEnabled: true, fileEnabled: true, filePath: logFile })
    vi.spyOn(console, "info").mockImplementation(() => {
      const error = new Error("broken pipe") as NodeJS.ErrnoException
      error.code = "EPIPE"
      throw error
    })

    expect(() => {
      runtimeLog("info", "backend-process", "request.sent", { requestId: "request-1" })
    }).not.toThrow()

    expect(readFileSync(logFile, "utf8")).toContain('"requestId":"request-1"')
  })

  it("disables console logging when stdout emits an asynchronous EPIPE", () => {
    const directory = mkdtempSync(join(tmpdir(), "worldseed-log-"))
    temporaryDirectories.push(directory)
    const logFile = join(directory, "runtime", "worldseed.log")
    configureRuntimeDiagnostics({ level: "debug", consoleEnabled: true, fileEnabled: true, filePath: logFile })
    const error = new Error("broken pipe") as NodeJS.ErrnoException
    error.code = "EPIPE"

    expect(() => process.stdout.emit("error", error)).not.toThrow()
    expect(readRuntimeDiagnosticsConfig().consoleEnabled).toBe(false)

    runtimeLog("info", "backend-process", "request.sent", { requestId: "request-2" })
    expect(readFileSync(logFile, "utf8")).toContain('"requestId":"request-2"')
  })
})
