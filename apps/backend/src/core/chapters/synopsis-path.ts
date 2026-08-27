import {
  formatChapterSequenceLabel,
  normalizeChapterHeading,
  parseChapterSequenceFromLabel,
} from "./chapter-document.js"

export const SYNOPSIS_MARKDOWN_SUFFIX = "[剧情梗概]" as const
export const SYNOPSIS_MARKDOWN_FILENAME_SUFFIX = ` ${SYNOPSIS_MARKDOWN_SUFFIX}` as const
export const SYNOPSIS_PLACEHOLDER_TITLE = "待命名" as const

export type ChapterMarkdownKind = "chapter_body" | "plot_synopsis"

export function resolveChapterMarkdownKind(path: string): ChapterMarkdownKind | undefined {
  if (!path.startsWith("章节正文/") || !path.endsWith(".md")) return undefined
  return isSynopsisMarkdownPath(path) ? "plot_synopsis" : "chapter_body"
}

export function isChapterBodyMarkdownPath(path: string): boolean {
  return resolveChapterMarkdownKind(path) === "chapter_body"
}

export function isSynopsisMarkdownPath(path: string): boolean {
  if (!path.startsWith("章节正文/")) return false
  return path.endsWith(`${SYNOPSIS_MARKDOWN_FILENAME_SUFFIX}.md`)
    || path.endsWith(`${SYNOPSIS_MARKDOWN_SUFFIX}.md`)
}

export function deriveSynopsisHeading(chapterSequence: number, title: string): string {
  const trimmedTitle = title.trim()
  if (/^第/u.test(trimmedTitle)) return normalizeChapterHeading(trimmedTitle)
  const chapterLabel = formatChapterSequenceLabel(chapterSequence)
  if (trimmedTitle.length === 0 || trimmedTitle === SYNOPSIS_PLACEHOLDER_TITLE) return `${chapterLabel} ${SYNOPSIS_PLACEHOLDER_TITLE}`
  return `${chapterLabel} ${trimmedTitle}`
}

export function deriveSynopsisMarkdownPath(chapterSequence: number, title: string): string {
  const filename = normalizeChapterHeading(deriveSynopsisHeading(chapterSequence, title))
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
  return `章节正文/${filename}${SYNOPSIS_MARKDOWN_FILENAME_SUFFIX}.md`
}

export function parseSynopsisMarkdownPath(path: string): Readonly<{
  sequence?: number
  title?: string
  titleLabel: string
}> | undefined {
  if (!isSynopsisMarkdownPath(path)) return undefined
  const filename = path.slice("章节正文/".length, -".md".length)
  const titleLabel = stripSynopsisFilenameSuffix(filename)
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

export function extractSynopsisTitleFromDocument(content: string): string | undefined {
  const firstLine = content.replaceAll("\r\n", "\n").split("\n").find((line) => line.trim().length > 0)
  if (firstLine === undefined) return undefined
  const match = firstLine.trim().match(/^#\s+(.+?)(?:\s+剧情梗概)?\s*$/u)
  if (match === null) return undefined
  const heading = match[1]?.trim()
  if (heading === undefined || heading.length === 0) return undefined
  return parseSynopsisTitleFromLabel(heading)
}

function stripSynopsisFilenameSuffix(filename: string): string {
  if (filename.endsWith(SYNOPSIS_MARKDOWN_FILENAME_SUFFIX)) {
    return filename.slice(0, -SYNOPSIS_MARKDOWN_FILENAME_SUFFIX.length)
  }
  if (filename.endsWith(SYNOPSIS_MARKDOWN_SUFFIX)) {
    return filename.slice(0, -SYNOPSIS_MARKDOWN_SUFFIX.length)
  }
  return filename
}
