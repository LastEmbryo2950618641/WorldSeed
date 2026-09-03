export const SYNOPSIS_MARKDOWN_SUFFIX = "[剧情梗概]" as const
export const SYNOPSIS_MARKDOWN_FILENAME_SUFFIX = ` ${SYNOPSIS_MARKDOWN_SUFFIX}` as const
export const OUTLINE_MARKDOWN_SUFFIX = "[剧情细纲]" as const
export const OUTLINE_MARKDOWN_FILENAME_SUFFIX = ` ${OUTLINE_MARKDOWN_SUFFIX}` as const

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

export function isChapterPlanningMarkdownPath(path: string): boolean {
  return isSynopsisMarkdownPath(path) || isOutlineMarkdownPath(path)
}

/** Prefer body > outline > synopsis as the tree surface path among siblings. */
export function resolveChapterSurfacePath(paths: readonly string[]): string | undefined {
  const bodies = paths.filter((path) => isChapterBodyMarkdownPath(path))
  if (bodies[0] !== undefined) return bodies[0]
  const outlines = paths.filter((path) => isOutlineMarkdownPath(path))
  if (outlines[0] !== undefined) return outlines[0]
  const synopses = paths.filter((path) => isSynopsisMarkdownPath(path))
  return synopses[0]
}
