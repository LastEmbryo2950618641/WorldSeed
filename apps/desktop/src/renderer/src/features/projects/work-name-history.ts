const HISTORY_PREFIX = "worldseed.work-name-history:"
const HISTORY_LIMIT = 8

export const DEFAULT_WORK_NAME = "新建作品"

function historyKey(projectId: string): string {
  return `${HISTORY_PREFIX}${projectId}`
}

export function readWorkNameHistory(projectId: string): readonly string[] {
  try {
    const raw = localStorage.getItem(historyKey(projectId))
    if (raw === null || raw.length === 0) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

export function rememberWorkName(projectId: string, displayName: string): readonly string[] {
  const trimmed = displayName.trim()
  if (trimmed.length === 0) return readWorkNameHistory(projectId)
  const next = [trimmed, ...readWorkNameHistory(projectId).filter((entry) => entry !== trimmed)].slice(0, HISTORY_LIMIT)
  try {
    localStorage.setItem(historyKey(projectId), JSON.stringify(next))
  } catch {
    // Ignore quota / private-mode failures; UI still works with the current name.
  }
  return next
}

export function suggestWorkNameFromHeadings(headings: readonly string[]): string {
  for (const heading of headings) {
    const cleaned = heading
      .replace(/^第[零一二三四五六七八九十百千0-9]+章\s*/u, "")
      .replace(/\.md$/iu, "")
      .trim()
    if (cleaned.length > 0) return cleaned.slice(0, 200)
  }
  return DEFAULT_WORK_NAME
}
