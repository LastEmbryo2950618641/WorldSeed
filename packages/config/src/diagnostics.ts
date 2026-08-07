import { z } from "zod"

export const runtimeLogLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"])
export type RuntimeLogLevel = z.infer<typeof runtimeLogLevelSchema>

export const runtimeDiagnosticsConfigSchema = z.object({
  level: runtimeLogLevelSchema,
  consoleEnabled: z.boolean(),
  fileEnabled: z.boolean(),
  filePath: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (value.fileEnabled && value.filePath === undefined) {
    context.addIssue({
      code: "custom",
      message: "filePath is required when file logging is enabled",
      path: ["filePath"],
    })
  }
})
export type RuntimeDiagnosticsConfig = z.infer<typeof runtimeDiagnosticsConfigSchema>

export type RuntimeDiagnosticsEnvironment = Readonly<Record<string, string | undefined>>

export function runtimeDiagnosticsConfigFromEnvironment(
  values: RuntimeDiagnosticsEnvironment,
  defaultFilePath: string,
  development: boolean,
): RuntimeDiagnosticsConfig {
  return runtimeDiagnosticsConfigSchema.parse({
    level: values.WORLDSEED_LOG_LEVEL?.trim().toLowerCase() || (development ? "debug" : "info"),
    consoleEnabled: environmentBoolean(values.WORLDSEED_LOG_CONSOLE, development),
    fileEnabled: environmentBoolean(values.WORLDSEED_LOG_FILE_ENABLED, true),
    filePath: values.WORLDSEED_LOG_FILE?.trim() || defaultFilePath,
  })
}

function environmentBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "true" || normalized === "1") return true
  if (normalized === "false" || normalized === "0") return false
  throw new Error(`Runtime diagnostics environment value must be boolean: ${value}`)
}
