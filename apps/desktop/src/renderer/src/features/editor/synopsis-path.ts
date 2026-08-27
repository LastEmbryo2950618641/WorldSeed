export const SYNOPSIS_MARKDOWN_SUFFIX = "[剧情梗概]" as const
export const SYNOPSIS_MARKDOWN_FILENAME_SUFFIX = ` ${SYNOPSIS_MARKDOWN_SUFFIX}` as const

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
