import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  runtimeDiagnosticsConfigSchema,
  type RuntimeDiagnosticsConfig,
  type RuntimeLogLevel,
} from "@worldseed/config"

export type RuntimeEventLevel = Exclude<RuntimeLogLevel, "silent">

export type RuntimeLogFields = Readonly<Record<string, unknown>>

const levelPriority: Record<RuntimeEventLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

let runtimeDiagnosticsConfig: RuntimeDiagnosticsConfig = runtimeDiagnosticsConfigSchema.parse({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
  consoleEnabled: process.env.NODE_ENV !== "test",
  fileEnabled: false,
})

installConsoleStreamErrorHandlers()

export function configureRuntimeDiagnostics(config: RuntimeDiagnosticsConfig): void {
  runtimeDiagnosticsConfig = runtimeDiagnosticsConfigSchema.parse(config)
}

export function readRuntimeDiagnosticsConfig(): RuntimeDiagnosticsConfig {
  return runtimeDiagnosticsConfig
}

export function runtimeLog(
  level: RuntimeEventLevel,
  component: string,
  event: string,
  fields: RuntimeLogFields = {},
): void {
  if (!shouldLog(level)) return
  const line = formatRuntimeLog({
    timestamp: new Date().toISOString(),
    level,
    processId: process.pid,
    component,
    event,
    ...sanitizeFields(fields),
  })
  if (runtimeDiagnosticsConfig.consoleEnabled) writeConsoleSafely(level, line)
  const logFile = runtimeDiagnosticsConfig.filePath
  if (!runtimeDiagnosticsConfig.fileEnabled || logFile === undefined) return
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${line}\n`, "utf8")
  } catch (error) {
    if (runtimeDiagnosticsConfig.consoleEnabled) writeConsoleSafely("error", formatRuntimeLog({
      timestamp: new Date().toISOString(),
      level: "error",
      processId: process.pid,
      component: "runtime-logger",
      event: "log_file.write_failed",
      error: errorDetails(error),
    }))
  }
}

export function formatRuntimeLog(record: RuntimeLogFields): string {
  return `[Worldseed] ${JSON.stringify(record)}`
}

export function errorDetails(error: unknown): Readonly<{ name: string; message: string; stack?: string }> {
  if (!(error instanceof Error)) return { name: "UnknownError", message: String(error) }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
}

function shouldLog(level: RuntimeEventLevel): boolean {
  if (runtimeDiagnosticsConfig.level === "silent") return false
  return levelPriority[level] >= levelPriority[runtimeDiagnosticsConfig.level]
}

function sanitizeFields(fields: RuntimeLogFields): RuntimeLogFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sanitizeValue(key, value)]))
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (/api.?key|authorization|credential|secret|token$/iu.test(key)) return "[redacted]"
  if (value instanceof Error) return errorDetails(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item))
  if (typeof value === "object" && value !== null) return sanitizeFields(value as RuntimeLogFields)
  return value
}

function writeConsole(level: RuntimeEventLevel, line: string): void {
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.info(line)
}

function writeConsoleSafely(level: RuntimeEventLevel, line: string): void {
  try {
    writeConsole(level, line)
  } catch {
    disableConsoleLogging()
  }
}

function installConsoleStreamErrorHandlers(): void {
  process.stdout.on("error", handleConsoleStreamError)
  process.stderr.on("error", handleConsoleStreamError)
}

function handleConsoleStreamError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error
  disableConsoleLogging()
}

function disableConsoleLogging(): void {
  runtimeDiagnosticsConfig = { ...runtimeDiagnosticsConfig, consoleEnabled: false }
}
