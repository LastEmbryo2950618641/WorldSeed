import type { SynopsisConversationStreamRun } from "@worldseed/contracts"

const MAX_ARG_CHARS = 120

/**
 * Claude Code–style call signature for discuss tool/bash activity:
 * `run(command)` or `run(toolName, key=value, …)`.
 */
export function formatSynopsisToolRunCall(run: Readonly<{
  name: string
  action: "describe" | "invoke"
  arguments?: string | undefined
}>): string {
  if (run.action === "describe") return `run(${run.name}, action=describe)`
  const parsed = tryParseArgs(run.arguments)
  if (run.name === "bash") {
    const command = stringField(parsed, "command") ?? (run.arguments?.trim() || "")
    const cwd = stringField(parsed, "cwd")
    if (cwd === undefined || cwd.length === 0) return `run(${quoteArg(command)})`
    return `run(${quoteArg(command)}, cwd=${quoteArg(cwd)})`
  }
  if (parsed === undefined) {
    const raw = run.arguments?.trim()
    return raw === undefined || raw.length === 0
      ? `run(${run.name})`
      : `run(${run.name}, ${truncate(raw)})`
  }
  const parts = Object.entries(parsed).map(([key, value]) => `${key}=${formatValue(value)}`)
  return parts.length === 0 ? `run(${run.name})` : `run(${run.name}, ${parts.join(", ")})`
}

export function formatSynopsisToolRunStatus(run: Pick<SynopsisConversationStreamRun, "status">): string {
  if (run.status === "running") return "执行中"
  if (run.status === "failed") return "失败"
  return "完成"
}

function tryParseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function stringField(parsed: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = parsed?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return quoteArg(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  try {
    return quoteArg(JSON.stringify(value))
  } catch {
    return quoteArg(String(value))
  }
}

function quoteArg(value: string): string {
  const truncated = truncate(value)
  if (/^[\w./:@%+=,-]+$/u.test(truncated) && !truncated.includes(" ")) return truncated
  return JSON.stringify(truncated)
}

function truncate(value: string): string {
  if (value.length <= MAX_ARG_CHARS) return value
  return `${value.slice(0, MAX_ARG_CHARS - 1)}…`
}
