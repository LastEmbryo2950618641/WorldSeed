import { formatChapterSequenceLabel, normalizeChapterHeading } from "./chapter-document.js"

/** Placeholder volume until the author or AI names the arc. */
export const VOLUME_PLACEHOLDER_TITLE = "待命名" as const
export const DEFAULT_VOLUME_FOLDER_NAME = `第一卷 ${VOLUME_PLACEHOLDER_TITLE}` as const

const VOLUME_LABEL_PREFIX = /^第(?:\d+|[零一二三四五六七八九十百]+)卷(?:\s|$)/u
const VOLUME_FOLDER_PATTERN = /^第(?:\d+|[零一二三四五六七八九十百]+)卷\s+\S.*$/u

export type VolumeFolderValidationResult = Readonly<
  | { ok: true; folderName: string; sequence: number; title: string }
  | { ok: false; folderName: string; reason: string }
>

export type ChapterUnderVolumeValidationResult = Readonly<
  | {
    ok: true
    path: string
    volumeFolderName: string
    filename: string
  }
  | {
    ok: false
    path: string
    reason: string
  }
>

/** Sanitize a volume folder segment (no path separators). */
export function normalizeVolumeFolderName(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error("卷名不能为空")
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error("卷名不能包含路径分隔符")
  }
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("卷名必须是单行")
  }
  const sanitized = normalized
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
  if (sanitized.length === 0) {
    throw new Error("卷名不包含可用字符")
  }
  return sanitized
}

export function formatVolumeSequenceLabel(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error("Volume sequence must be a positive integer")
  }
  // Reuse chapter numeral formatting by temporarily mapping through 第N章 → 第N卷.
  return formatChapterSequenceLabel(sequence).replace(/章$/u, "卷")
}

export function parseVolumeSequenceFromLabel(label: string): number | undefined {
  const trimmed = label.trim()
  const match = trimmed.match(/^第(\d+)卷/u) ?? trimmed.match(/^第([零一二三四五六七八九十百]+)卷/u)
  if (match === null) return undefined
  const token = match[1]
  if (token === undefined) return undefined
  if (/^\d+$/u.test(token)) return Number(token)
  return parseChineseVolumeNumeral(token)
}

function parseChineseVolumeNumeral(value: string): number | undefined {
  // Same numeral grammar as chapter labels.
  if (value.length === 0) return undefined
  const digits: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (value === "十") return 10
  if (value.startsWith("十")) {
    const rest = value.slice(1)
    if (rest.length === 0) return 10
    return digits[rest] === undefined ? undefined : 10 + digits[rest]
  }
  if (value.endsWith("十") && value.length === 2) {
    const tens = digits[value[0] ?? ""]
    return tens === undefined ? undefined : tens * 10
  }
  if (value.includes("十")) {
    const parts = value.split("十")
    const tensPart = parts[0] ?? ""
    const onesPart = parts[1] ?? ""
    const tens = tensPart.length === 0 ? 1 : digits[tensPart]
    if (tens === undefined) return undefined
    if (onesPart.length === 0) return tens * 10
    const ones = digits[onesPart]
    return ones === undefined ? undefined : tens * 10 + ones
  }
  return digits[value]
}

/**
 * Canonical volume folder name: `第N卷 {标题}` (space required before title).
 * Example: `第一卷 潮水退去时`
 */
export function validateVolumeFolderName(folderName: string): VolumeFolderValidationResult {
  let normalized: string
  try {
    normalized = normalizeVolumeFolderName(folderName)
  } catch (error) {
    return {
      ok: false,
      folderName,
      reason: error instanceof Error ? error.message : "卷名无效",
    }
  }
  if (!VOLUME_FOLDER_PATTERN.test(normalized)) {
    return {
      ok: false,
      folderName: normalized,
      reason: `卷文件夹必须命名为「第N卷 标题」（例如「第一卷 潮水退去时」），当前为「${normalized}」`,
    }
  }
  if (!VOLUME_LABEL_PREFIX.test(normalized)) {
    return {
      ok: false,
      folderName: normalized,
      reason: `卷文件夹必须以「第N卷」开头，当前为「${normalized}」`,
    }
  }
  const sequence = parseVolumeSequenceFromLabel(normalized)
  if (sequence === undefined) {
    return {
      ok: false,
      folderName: normalized,
      reason: `无法解析卷序号：「${normalized}」`,
    }
  }
  const title = parseVolumeTitleFromLabel(normalized)
  if (title === undefined || title.length === 0) {
    return {
      ok: false,
      folderName: normalized,
      reason: `卷名在「第N卷」之后必须有标题（例如「第一卷 潮水退去时」）`,
    }
  }
  return { ok: true, folderName: normalized, sequence, title }
}

export function parseVolumeTitleFromLabel(folderName: string): string | undefined {
  const trimmed = folderName.trim()
  const match = trimmed.match(/^第(?:\d+|[零一二三四五六七八九十百]+)卷(?:\s+(.*))?$/u)
  if (match === null) return undefined
  const rest = match[1]?.trim()
  if (rest === undefined || rest.length === 0) return undefined
  return rest
}

export function deriveVolumeDirectoryPath(volumeFolderName: string): string {
  const validated = validateVolumeFolderName(volumeFolderName)
  if (!validated.ok) throw new Error(validated.reason)
  return `章节正文/${validated.folderName}`
}

export function isVolumeDirectoryPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (!normalized.startsWith("章节正文/")) return false
  const rest = normalized.slice("章节正文/".length)
  if (rest.includes("/")) return false
  return validateVolumeFolderName(rest).ok
}

/**
 * Any immediate child directory of「章节正文/」(valid volume or legacy/invalid name).
 * Used for unlock + delete cleanup so users can remove duplicate/broken volume folders.
 */
export function isChapterVolumeContainerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (!normalized.startsWith("章节正文/")) return false
  const rest = normalized.slice("章节正文/".length)
  return rest.length > 0 && !rest.includes("/")
}

/** True when a markdown file sits directly under `章节正文/` (forbidden for new writes). */
export function isLooseChapterRootMarkdownPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  if (!normalized.startsWith("章节正文/") || !normalized.endsWith(".md")) return false
  const rest = normalized.slice("章节正文/".length, -".md".length)
  return !rest.includes("/")
}

/**
 * Chapter/synopsis markdown must live at `章节正文/{第N卷 标题}/{filename}.md`.
 */
export function validateChapterFileUnderVolume(path: string): ChapterUnderVolumeValidationResult {
  const normalized = path.replaceAll("\\", "/")
  if (!normalized.startsWith("章节正文/") || !normalized.endsWith(".md")) {
    return {
      ok: false,
      path: normalized,
      reason: "章节文件必须位于「章节正文/」下的卷文件夹中，且为 .md",
    }
  }
  const rest = normalized.slice("章节正文/".length, -".md".length)
  const slash = rest.indexOf("/")
  if (slash < 0) {
    return {
      ok: false,
      path: normalized,
      reason: "章节不能直接放在「章节正文/」根下，必须先属于某个卷文件夹（例如「章节正文/第一卷 潮水退去时/第一章 ….md」）",
    }
  }
  if (rest.indexOf("/", slash + 1) >= 0) {
    return {
      ok: false,
      path: normalized,
      reason: "章节路径层级过深：只允许「章节正文/{卷名}/{章节文件}.md」",
    }
  }
  const volumeFolderName = rest.slice(0, slash)
  const filename = rest.slice(slash + 1)
  const volume = validateVolumeFolderName(volumeFolderName)
  if (!volume.ok) {
    return { ok: false, path: normalized, reason: volume.reason }
  }
  if (filename.trim().length === 0) {
    return { ok: false, path: normalized, reason: "章节文件名不能为空" }
  }
  return {
    ok: true,
    path: normalized,
    volumeFolderName: volume.folderName,
    filename,
  }
}

export function deriveChapterPublishPath(heading: string, volumeFolderName: string): string {
  const volume = validateVolumeFolderName(volumeFolderName)
  if (!volume.ok) throw new Error(volume.reason)
  const filename = normalizeChapterHeading(heading)
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
  if (filename.length === 0) throw new Error("Chapter heading does not contain a valid filename")
  return `章节正文/${volume.folderName}/${filename}.md`
}

export function extractVolumeFolderNameFromPath(path: string): string | undefined {
  const under = validateChapterFileUnderVolume(path)
  if (under.ok) return under.volumeFolderName
  if (isVolumeDirectoryPath(path)) {
    return path.replaceAll("\\", "/").slice("章节正文/".length)
  }
  return undefined
}

export type VolumeFolderInventoryEntry = Readonly<{
  path: string
  folderName: string
  sequence: number
  title: string
}>

/** Collect valid volume directories from a workspace inventory. */
export function listVolumeFoldersFromInventory(
  entries: readonly Readonly<{ path: string; kind: "directory" | "file" }>[],
): readonly VolumeFolderInventoryEntry[] {
  const volumes: VolumeFolderInventoryEntry[] = []
  for (const entry of entries) {
    if (entry.kind !== "directory") continue
    const normalized = entry.path.replaceAll("\\", "/")
    if (!isVolumeDirectoryPath(normalized)) continue
    const folderName = normalized.slice("章节正文/".length)
    const validated = validateVolumeFolderName(folderName)
    if (!validated.ok) continue
    volumes.push({
      path: normalized,
      folderName: validated.folderName,
      sequence: validated.sequence,
      title: validated.title,
    })
  }
  return volumes
}

/**
 * Prefer an existing volume folder when creating the next chapter's planning files.
 * Highest volume sequence wins; within the same sequence prefer a non-placeholder title.
 */
export function pickPreferredVolumeFolderName(
  existingFolderNames: readonly string[],
): string | undefined {
  const validated = existingFolderNames.flatMap((name) => {
    const result = validateVolumeFolderName(name)
    return result.ok ? [result] : []
  })
  if (validated.length === 0) return undefined
  validated.sort((left, right) => {
    if (left.sequence !== right.sequence) return right.sequence - left.sequence
    const leftPlaceholder = left.title === VOLUME_PLACEHOLDER_TITLE ? 1 : 0
    const rightPlaceholder = right.title === VOLUME_PLACEHOLDER_TITLE ? 1 : 0
    if (leftPlaceholder !== rightPlaceholder) return leftPlaceholder - rightPlaceholder
    return left.folderName.localeCompare(right.folderName, "zh-CN")
  })
  return validated[0]?.folderName
}

export type VolumeSequenceConflictResult = Readonly<
  | { ok: true }
  | {
    ok: false
    sequence: number
    conflictFolderName: string
    reason: string
  }
>

/**
 * Enforce one folder per volume sequence (第一卷 / 第二卷 / …).
 * `excludeFolderName` allows renaming the same volume’s title in place.
 */
export function assertUniqueVolumeSequence(
  folderName: string,
  existingFolderNames: readonly string[],
  options?: Readonly<{ excludeFolderName?: string }>,
): VolumeSequenceConflictResult {
  const validated = validateVolumeFolderName(folderName)
  if (!validated.ok) {
    return {
      ok: false,
      sequence: 0,
      conflictFolderName: folderName,
      reason: validated.reason,
    }
  }
  const exclude = options?.excludeFolderName === undefined
    ? undefined
    : normalizeVolumeFolderName(options.excludeFolderName)
  for (const existing of existingFolderNames) {
    let existingNormalized: string
    try {
      existingNormalized = normalizeVolumeFolderName(existing)
    } catch {
      continue
    }
    if (exclude !== undefined && existingNormalized === exclude) continue
    if (existingNormalized === validated.folderName) continue
    const other = validateVolumeFolderName(existingNormalized)
    if (!other.ok) continue
    if (other.sequence === validated.sequence) {
      return {
        ok: false,
        sequence: validated.sequence,
        conflictFolderName: other.folderName,
        reason: `${formatVolumeSequenceLabel(validated.sequence)}已存在为「${other.folderName}」，不能再创建「${validated.folderName}」。同一序号只能有一个卷文件夹；若要改卷名请重命名现有卷。`,
      }
    }
  }
  return { ok: true }
}

/** Rewrite `章节正文/{from}/…` → `章节正文/{to}/…` (and the bare volume dir). */
export function remapPathVolumeFolder(
  path: string,
  fromFolderName: string,
  toFolderName: string,
): string {
  const normalized = path.replaceAll("\\", "/")
  const from = normalizeVolumeFolderName(fromFolderName)
  const to = normalizeVolumeFolderName(toFolderName)
  const fromDir = `章节正文/${from}`
  if (normalized === fromDir) return `章节正文/${to}`
  const fromPrefix = `${fromDir}/`
  if (normalized.startsWith(fromPrefix)) {
    return `章节正文/${to}/${normalized.slice(fromPrefix.length)}`
  }
  return normalized
}
