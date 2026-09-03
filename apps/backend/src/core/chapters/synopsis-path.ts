import {
  formatChapterSequenceLabel,
  normalizeChapterHeading,
  parseChapterSequenceFromLabel,
} from "./chapter-document.js"
import {
  DEFAULT_VOLUME_FOLDER_NAME,
  deriveVolumeDirectoryPath,
  validateChapterFileUnderVolume,
  validateVolumeFolderName,
} from "./chapter-volume.js"

export const SYNOPSIS_MARKDOWN_SUFFIX = "[剧情梗概]" as const
export const SYNOPSIS_MARKDOWN_FILENAME_SUFFIX = ` ${SYNOPSIS_MARKDOWN_SUFFIX}` as const
export const OUTLINE_MARKDOWN_SUFFIX = "[剧情细纲]" as const
export const OUTLINE_MARKDOWN_FILENAME_SUFFIX = ` ${OUTLINE_MARKDOWN_SUFFIX}` as const
export const SYNOPSIS_PLACEHOLDER_TITLE = "待命名" as const

export type ChapterMarkdownKind = "chapter_body" | "plot_synopsis" | "plot_outline"

export function resolveChapterMarkdownKind(path: string): ChapterMarkdownKind | undefined {
  if (!path.startsWith("章节正文/") || !path.endsWith(".md")) return undefined
  if (isSynopsisMarkdownPath(path)) return "plot_synopsis"
  if (isOutlineMarkdownPath(path)) return "plot_outline"
  return "chapter_body"
}

export function isChapterBodyMarkdownPath(path: string): boolean {
  return resolveChapterMarkdownKind(path) === "chapter_body"
}

export function isSynopsisMarkdownPath(path: string): boolean {
  if (!path.startsWith("章节正文/")) return false
  return path.endsWith(`${SYNOPSIS_MARKDOWN_FILENAME_SUFFIX}.md`)
    || path.endsWith(`${SYNOPSIS_MARKDOWN_SUFFIX}.md`)
}

export function isOutlineMarkdownPath(path: string): boolean {
  if (!path.startsWith("章节正文/")) return false
  return path.endsWith(`${OUTLINE_MARKDOWN_FILENAME_SUFFIX}.md`)
    || path.endsWith(`${OUTLINE_MARKDOWN_SUFFIX}.md`)
}

/** Synopsis or outline — user/platform writable planning docs under 章节正文. */
export function isChapterPlanningMarkdownPath(path: string): boolean {
  return isSynopsisMarkdownPath(path) || isOutlineMarkdownPath(path)
}

const CHAPTER_LABEL_PREFIX = /^第(?:\d+|[零一二三四五六七八九十百]+)章(?:\s|$)/u

export function deriveSynopsisHeading(chapterSequence: number, title: string): string {
  const trimmedTitle = title.trim()
  // Only treat the title as a full heading when it already contains「第N章」.
  // Titles like「第一桶金」start with「第」but are NOT chapter labels.
  if (CHAPTER_LABEL_PREFIX.test(trimmedTitle)) {
    return normalizeChapterHeading(trimmedTitle)
  }
  const chapterLabel = formatChapterSequenceLabel(chapterSequence)
  if (trimmedTitle.length === 0 || trimmedTitle === SYNOPSIS_PLACEHOLDER_TITLE) {
    return `${chapterLabel} ${SYNOPSIS_PLACEHOLDER_TITLE}`
  }
  return `${chapterLabel} ${trimmedTitle}`
}

export function deriveSynopsisMarkdownPath(
  chapterSequence: number,
  title: string,
  volumeFolderName: string = DEFAULT_VOLUME_FOLDER_NAME,
): string {
  return derivePlanningMarkdownPath(chapterSequence, title, volumeFolderName, "synopsis")
}

export function deriveOutlineMarkdownPath(
  chapterSequence: number,
  title: string,
  volumeFolderName: string = DEFAULT_VOLUME_FOLDER_NAME,
): string {
  return derivePlanningMarkdownPath(chapterSequence, title, volumeFolderName, "outline")
}

function derivePlanningMarkdownPath(
  chapterSequence: number,
  title: string,
  volumeFolderName: string,
  kind: "synopsis" | "outline",
): string {
  const volume = validateVolumeFolderName(volumeFolderName)
  if (!volume.ok) throw new Error(volume.reason)
  const filename = normalizeChapterHeading(deriveSynopsisHeading(chapterSequence, title))
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
  const suffix = kind === "outline" ? OUTLINE_MARKDOWN_FILENAME_SUFFIX : SYNOPSIS_MARKDOWN_FILENAME_SUFFIX
  return `${deriveVolumeDirectoryPath(volume.folderName)}/${filename}${suffix}.md`
}

/** Swap `[剧情梗概]` ↔ `[剧情细纲]` on a planning path; undefined if not a planning path. */
export function siblingPlanningMarkdownPath(
  path: string,
  target: "synopsis" | "outline",
): string | undefined {
  const normalized = path.replaceAll("\\", "/")
  if (isSynopsisMarkdownPath(normalized)) {
    if (target === "synopsis") return normalized
    const stem = stripPlanningFilenameSuffix(normalized.slice(0, -".md".length))
    return `${stem}${OUTLINE_MARKDOWN_FILENAME_SUFFIX}.md`
  }
  if (isOutlineMarkdownPath(normalized)) {
    if (target === "outline") return normalized
    const stem = stripPlanningFilenameSuffix(normalized.slice(0, -".md".length))
    return `${stem}${SYNOPSIS_MARKDOWN_FILENAME_SUFFIX}.md`
  }
  return undefined
}

export type SynopsisPathValidationResult = Readonly<
  | {
    ok: true
    path: string
    sequence: number
    titleLabel: string
    volumeFolderName: string
    title?: string
  }
  | {
    ok: false
    path: string
    reason: string
  }
>

/**
 * Canonical synopsis path: `章节正文/{第N卷 标题}/第M章 {标题} [剧情梗概].md`
 * Legacy flat paths under `章节正文/` root are rejected (gate: must belong to a volume).
 */
export function validateSynopsisMarkdownPath(path: string): SynopsisPathValidationResult {
  return validatePlanningMarkdownPath(path, "synopsis")
}

export function assertValidSynopsisMarkdownPath(path: string): string {
  const result = validateSynopsisMarkdownPath(path)
  if (!result.ok) throw new Error(result.reason)
  return result.path
}

export function validateOutlineMarkdownPath(path: string): SynopsisPathValidationResult {
  return validatePlanningMarkdownPath(path, "outline")
}

export function assertValidOutlineMarkdownPath(path: string): string {
  const result = validateOutlineMarkdownPath(path)
  if (!result.ok) throw new Error(result.reason)
  return result.path
}

export function isCanonicalSynopsisMarkdownPath(path: string): boolean {
  return validateSynopsisMarkdownPath(path).ok
}

function validatePlanningMarkdownPath(
  path: string,
  kind: "synopsis" | "outline",
): SynopsisPathValidationResult {
  const normalized = path.replaceAll("\\", "/")
  const label = kind === "outline" ? "剧情细纲" : "剧情梗概"
  const isMatch = kind === "outline" ? isOutlineMarkdownPath(normalized) : isSynopsisMarkdownPath(normalized)
  const marker = kind === "outline" ? OUTLINE_MARKDOWN_SUFFIX : SYNOPSIS_MARKDOWN_SUFFIX
  if (!normalized.startsWith("章节正文/") || !normalized.endsWith(".md")) {
    return {
      ok: false,
      path: normalized,
      reason: `${label}文件必须位于「章节正文/{卷名}/」下，且为 .md 文件`,
    }
  }
  if (!isMatch) {
    return {
      ok: false,
      path: normalized,
      reason: `${label}文件名必须以「 ${marker}.md」结尾（例如：第二章 雾港站的末班车 ${marker}.md）`,
    }
  }
  const underVolume = validateChapterFileUnderVolume(normalized)
  if (!underVolume.ok) {
    return { ok: false, path: normalized, reason: underVolume.reason }
  }
  const titleLabel = stripPlanningFilenameSuffix(underVolume.filename)
  if (titleLabel.trim().length === 0) {
    return {
      ok: false,
      path: normalized,
      reason: `${label}文件名在「${marker}」前不能为空，须包含「第N章」与标题`,
    }
  }
  if (!CHAPTER_LABEL_PREFIX.test(titleLabel)) {
    return {
      ok: false,
      path: normalized,
      reason: `${label}文件名必须以「第N章」开头（如「第二章 标题 ${marker}.md」），当前为「${titleLabel}」`,
    }
  }
  const sequence = parseChapterSequenceFromLabel(titleLabel)
  if (sequence === undefined) {
    return {
      ok: false,
      path: normalized,
      reason: `无法解析章序号：文件名「${titleLabel}」中的「第…章」无效`,
    }
  }
  const title = parseSynopsisTitleFromLabel(titleLabel)
  return {
    ok: true,
    path: normalized,
    sequence,
    titleLabel,
    volumeFolderName: underVolume.volumeFolderName,
    ...(title === undefined ? {} : { title }),
  }
}

export function parseSynopsisMarkdownPath(path: string): Readonly<{
  sequence?: number
  title?: string
  titleLabel: string
  volumeFolderName?: string
}> | undefined {
  if (!isSynopsisMarkdownPath(path)) return undefined
  const validated = validateSynopsisMarkdownPath(path)
  if (validated.ok) {
    return {
      titleLabel: validated.titleLabel,
      volumeFolderName: validated.volumeFolderName,
      sequence: validated.sequence,
      ...(validated.title === undefined ? {} : { title: validated.title }),
    }
  }
  // Best-effort parse for legacy flat paths (inventory / cleanup only).
  const rest = path.slice("章节正文/".length, -".md".length)
  const filename = rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest
  const titleLabel = stripPlanningFilenameSuffix(filename)
  const sequence = parseChapterSequenceFromLabel(titleLabel)
  const title = parseSynopsisTitleFromLabel(titleLabel)
  return {
    titleLabel,
    ...(sequence === undefined ? {} : { sequence }),
    ...(title === undefined ? {} : { title }),
  }
}

export function parseOutlineMarkdownPath(path: string): Readonly<{
  sequence?: number
  title?: string
  titleLabel: string
  volumeFolderName?: string
}> | undefined {
  if (!isOutlineMarkdownPath(path)) return undefined
  const validated = validateOutlineMarkdownPath(path)
  if (validated.ok) {
    return {
      titleLabel: validated.titleLabel,
      volumeFolderName: validated.volumeFolderName,
      sequence: validated.sequence,
      ...(validated.title === undefined ? {} : { title: validated.title }),
    }
  }
  const rest = path.slice("章节正文/".length, -".md".length)
  const filename = rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest
  const titleLabel = stripPlanningFilenameSuffix(filename)
  const sequence = parseChapterSequenceFromLabel(titleLabel)
  const title = parseSynopsisTitleFromLabel(titleLabel)
  return {
    titleLabel,
    ...(sequence === undefined ? {} : { sequence }),
    ...(title === undefined ? {} : { title }),
  }
}

export function parseSynopsisTitleFromLabel(titleLabel: string): string | undefined {
  const trimmed = titleLabel.trim()
  const match = trimmed.match(/^第(?:\d+|[零一二三四五六七八九十百]+)章(?:\s+(.*))?$/u)
  if (match === null) return undefined
  const rest = match[1]?.trim()
  if (rest === undefined || rest.length === 0 || rest === SYNOPSIS_PLACEHOLDER_TITLE) return undefined
  return rest
}

export function assembleSynopsisPlaceholderDocument(chapterSequence: number, title: string): string {
  const heading = deriveSynopsisHeading(chapterSequence, title)
  return `# ${normalizeChapterHeading(heading)} 剧情梗概\n\n`
}

export function assembleOutlinePlaceholderDocument(chapterSequence: number, title: string): string {
  const heading = deriveSynopsisHeading(chapterSequence, title)
  return `# ${normalizeChapterHeading(heading)} 剧情细纲\n\n`
}

/** True when markdown is empty or only the standard placeholder heading with no body. */
export function isSynopsisPlaceholderDocument(content: string): boolean {
  const normalized = content.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) return true
  const lines = normalized.split("\n")
  const heading = lines[0]?.trim() ?? ""
  if (!/^#\s+.+\s*剧情梗概\s*$/u.test(heading)) return false
  return lines.slice(1).every((line) => line.trim().length === 0)
}

export function isOutlinePlaceholderDocument(content: string): boolean {
  const normalized = content.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) return true
  const lines = normalized.split("\n")
  const heading = lines[0]?.trim() ?? ""
  if (!/^#\s+.+\s*剧情细纲\s*$/u.test(heading)) return false
  return lines.slice(1).every((line) => line.trim().length === 0)
}

export function extractSynopsisTitleFromDocument(content: string): string | undefined {
  const firstLine = content.replaceAll("\r\n", "\n").split("\n").find((line) => line.trim().length > 0)
  if (firstLine === undefined) return undefined
  const match = firstLine.trim().match(/^#\s+(.+?)(?:\s+剧情梗概|\s+剧情细纲)?\s*$/u)
  if (match === null) return undefined
  const heading = match[1]?.trim()
  if (heading === undefined || heading.length === 0) return undefined
  return parseSynopsisTitleFromLabel(heading)
}

function stripPlanningFilenameSuffix(filename: string): string {
  if (filename.endsWith(SYNOPSIS_MARKDOWN_FILENAME_SUFFIX)) {
    return filename.slice(0, -SYNOPSIS_MARKDOWN_FILENAME_SUFFIX.length)
  }
  if (filename.endsWith(SYNOPSIS_MARKDOWN_SUFFIX)) {
    return filename.slice(0, -SYNOPSIS_MARKDOWN_SUFFIX.length)
  }
  if (filename.endsWith(OUTLINE_MARKDOWN_FILENAME_SUFFIX)) {
    return filename.slice(0, -OUTLINE_MARKDOWN_FILENAME_SUFFIX.length)
  }
  if (filename.endsWith(OUTLINE_MARKDOWN_SUFFIX)) {
    return filename.slice(0, -OUTLINE_MARKDOWN_SUFFIX.length)
  }
  return filename
}
