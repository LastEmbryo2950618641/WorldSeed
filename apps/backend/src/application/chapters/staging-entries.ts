export type StagingEntryStatus = "open" | "pending_promote" | "settled"

export type StagingEntry = Readonly<{
  entryId: string
  title: string
  body: string
  status: StagingEntryStatus
  updatedAtMs: number
  settledAtMs?: number
  promoteTargetPath?: string
  sourceMessageId?: string
}>

export type StagingEntryPatch = Readonly<{
  entryId?: string
  title: string
  body: string
  promoteTargetPath?: string
  status?: StagingEntryStatus
}>

const ENTRY_HEADER = /^## entry:([^\s]+)\s*$/u
const META = /^<!--\s*(\w+):\s*(.*?)\s*-->\s*$/u

export function parseStagingEntries(markdown: string): StagingEntry[] {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n")
  const entries: StagingEntry[] = []
  let current: {
    entryId: string
    title: string
    bodyLines: string[]
    status: StagingEntryStatus
    updatedAtMs: number
    settledAtMs?: number
    promoteTargetPath?: string
    sourceMessageId?: string
  } | undefined

  const flush = (): void => {
    if (current === undefined) return
    const body = current.bodyLines.join("\n").trim()
    entries.push({
      entryId: current.entryId,
      title: current.title.trim().length > 0 ? current.title.trim() : current.entryId,
      body,
      status: current.status,
      updatedAtMs: current.updatedAtMs,
      ...(current.settledAtMs === undefined ? {} : { settledAtMs: current.settledAtMs }),
      ...(current.promoteTargetPath === undefined ? {} : { promoteTargetPath: current.promoteTargetPath }),
      ...(current.sourceMessageId === undefined ? {} : { sourceMessageId: current.sourceMessageId }),
    })
    current = undefined
  }

  for (const line of lines) {
    const header = line.match(ENTRY_HEADER)
    if (header?.[1] !== undefined) {
      flush()
      current = {
        entryId: header[1].trim(),
        title: header[1].trim(),
        bodyLines: [],
        status: "open",
        updatedAtMs: 0,
      }
      continue
    }
    if (current === undefined) continue
    const meta = line.match(META)
    if (meta?.[1] !== undefined && meta[2] !== undefined) {
      const key = meta[1]
      const value = meta[2]
      if (key === "status" && (value === "open" || value === "pending_promote" || value === "settled")) {
        current.status = value
      } else if (key === "updatedAtMs") {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) current.updatedAtMs = parsed
      } else if (key === "settledAtMs") {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) current.settledAtMs = parsed
      } else if (key === "promoteTargetPath" && value.length > 0) {
        current.promoteTargetPath = value
      } else if (key === "sourceMessageId" && value.length > 0) {
        current.sourceMessageId = value
      } else if (key === "title" && value.length > 0) {
        current.title = value
      }
      continue
    }
    if (current.bodyLines.length === 0 && line.startsWith("### ")) {
      current.title = line.slice(4).trim()
      continue
    }
    current.bodyLines.push(line)
  }
  flush()
  return entries
}

export function serializeStagingEntries(title: string, entries: readonly StagingEntry[]): string {
  const blocks = entries.map((entry) => {
    const lines = [
      `## entry:${entry.entryId}`,
      `<!-- status: ${entry.status} -->`,
      `<!-- updatedAtMs: ${String(entry.updatedAtMs)} -->`,
      `<!-- title: ${entry.title} -->`,
    ]
    if (entry.settledAtMs !== undefined) lines.push(`<!-- settledAtMs: ${String(entry.settledAtMs)} -->`)
    if (entry.promoteTargetPath !== undefined) lines.push(`<!-- promoteTargetPath: ${entry.promoteTargetPath} -->`)
    if (entry.sourceMessageId !== undefined) lines.push(`<!-- sourceMessageId: ${entry.sourceMessageId} -->`)
    lines.push("", `### ${entry.title}`, "", entry.body.trim(), "")
    return lines.join("\n")
  })
  return [`# ${title}`, "", ...(blocks.length === 0 ? ["（尚无条目）", ""] : blocks)].join("\n")
}

export function mergeStagingPatches(
  existing: readonly StagingEntry[],
  patches: readonly StagingEntryPatch[],
  nowMs: number,
  createId: () => string,
): StagingEntry[] {
  const byId = new Map(existing.map((entry) => [entry.entryId, entry]))
  for (const patch of patches) {
    const entryId = patch.entryId?.trim() || createId()
    const previous = byId.get(entryId)
    if (previous?.status === "settled" && patch.status !== "settled") {
      // Never downgrade settled in v1.
      byId.set(entryId, {
        ...previous,
        title: patch.title.trim() || previous.title,
        body: patch.body,
        updatedAtMs: nowMs,
        ...(patch.promoteTargetPath === undefined
          ? {}
          : { promoteTargetPath: patch.promoteTargetPath }),
      })
      continue
    }
    const nextStatus = patch.status ?? previous?.status ?? "open"
    byId.set(entryId, {
      entryId,
      title: patch.title.trim() || previous?.title || entryId,
      body: patch.body,
      status: nextStatus,
      updatedAtMs: nowMs,
      ...(nextStatus === "settled"
        ? { settledAtMs: previous?.settledAtMs ?? nowMs }
        : previous?.settledAtMs === undefined
          ? {}
          : { settledAtMs: previous.settledAtMs }),
      ...(patch.promoteTargetPath === undefined
        ? (previous?.promoteTargetPath === undefined ? {} : { promoteTargetPath: previous.promoteTargetPath })
        : { promoteTargetPath: patch.promoteTargetPath }),
      ...(previous?.sourceMessageId === undefined ? {} : { sourceMessageId: previous.sourceMessageId }),
    })
  }
  return [...byId.values()].sort((left, right) => left.updatedAtMs - right.updatedAtMs
    || left.entryId.localeCompare(right.entryId, "zh-CN"))
}

export function countStagingChars(files: Readonly<Record<string, string>>): number {
  return Object.entries(files)
    .filter(([path]) => !path.endsWith("/readme.md") && path !== "readme.md")
    .reduce((total, [, content]) => total + content.length, 0)
}

/**
 * Evict oldest settled, then oldest open; preserve pending_promote as long as possible.
 */
export function evictStagingEntries(
  files: Readonly<Record<string, StagingEntry[]>>,
  maxChars: number,
  serialize: (fileKey: string, entries: readonly StagingEntry[]) => string,
): Readonly<{ files: Record<string, StagingEntry[]>; removedTitles: string[] }> {
  const next: Record<string, StagingEntry[]> = Object.fromEntries(
    Object.entries(files).map(([key, entries]) => [key, [...entries]]),
  )
  const removedTitles: string[] = []
  const serialized = (): Record<string, string> => Object.fromEntries(
    Object.entries(next).map(([key, entries]) => [key, serialize(key, entries)]),
  )

  const removeOne = (status: StagingEntryStatus): boolean => {
    let oldest: { fileKey: string; index: number; sortKey: number } | undefined
    for (const [fileKey, entries] of Object.entries(next)) {
      entries.forEach((entry, index) => {
        if (entry.status !== status) return
        const sortKey = status === "settled"
          ? (entry.settledAtMs ?? entry.updatedAtMs)
          : entry.updatedAtMs
        if (oldest === undefined || sortKey < oldest.sortKey
          || (sortKey === oldest.sortKey && entry.entryId < (next[oldest.fileKey]?.[oldest.index]?.entryId ?? ""))) {
          oldest = { fileKey, index, sortKey }
        }
      })
    }
    if (oldest === undefined) return false
    const list = next[oldest.fileKey]
    if (list === undefined) return false
    const [removed] = list.splice(oldest.index, 1)
    if (removed !== undefined) removedTitles.push(removed.title)
    return true
  }

  while (countStagingChars(serialized()) > maxChars) {
    if (removeOne("settled")) continue
    if (removeOne("open")) continue
    if (removeOne("pending_promote")) continue
    break
  }
  return { files: next, removedTitles }
}

export const STAGING_FILE_KEYS = {
  notes: "暂存区/本章讨论笔记.md",
  characters: "暂存区/人物草稿.md",
  world: "暂存区/世界与规则草稿.md",
  promoteIndex: "暂存区/待落盘清单.md",
} as const

/** Arc outline file — staging-adjacent, not entry-list managed. */
export const ARC_PLAN_STAGING_PATH = "暂存区/弧线规划.md" as const

export function stagingFileTitle(relativePath: string): string {
  switch (relativePath) {
    case STAGING_FILE_KEYS.notes: return "本章讨论笔记"
    case STAGING_FILE_KEYS.characters: return "人物草稿"
    case STAGING_FILE_KEYS.world: return "世界与规则草稿"
    case STAGING_FILE_KEYS.promoteIndex: return "待落盘清单"
    default: return relativePath.split("/").at(-1)?.replace(/\.md$/u, "") ?? relativePath
  }
}
