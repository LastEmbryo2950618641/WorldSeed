import type { DiscussAgentMode } from "@worldseed/contracts"

const STORAGE_KEY = "worldseed.creation-desk.discuss-agent-mode"

export const DISCUSS_AGENT_MODE_OPTIONS = [
  { value: "auto", label: "Auto", hint: "自主执行工具与写入（默认）" },
  { value: "plan", label: "Plan", hint: "只规划与讨论，不落盘写入" },
  { value: "accept_edits", label: "Accept edits", hint: "自动接受文件写入，少确认" },
] as const satisfies ReadonlyArray<Readonly<{
  value: DiscussAgentMode
  label: string
  hint: string
}>>

export function isDiscussAgentMode(value: string): value is DiscussAgentMode {
  return value === "auto" || value === "plan" || value === "accept_edits"
}

export function loadDiscussAgentMode(): DiscussAgentMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? ""
    if (isDiscussAgentMode(raw)) return raw
  } catch {
    // ignore storage failures
  }
  return "auto"
}

export function persistDiscussAgentMode(mode: DiscussAgentMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // ignore storage failures
  }
}
