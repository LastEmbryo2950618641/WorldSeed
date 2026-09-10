export const SYNOPSIS_MARKDOWN_SUFFIX = "[剧情梗概]" as const
export const SYNOPSIS_MARKDOWN_FILENAME_SUFFIX = ` ${SYNOPSIS_MARKDOWN_SUFFIX}` as const
export const OUTLINE_MARKDOWN_SUFFIX = "[剧情细纲]" as const
export const OUTLINE_MARKDOWN_FILENAME_SUFFIX = ` ${OUTLINE_MARKDOWN_SUFFIX}` as const

export type ChapterMarkdownKind = "chapter_body" | "plot_synopsis" | "plot_outline"

export type ChapterArtifactRelations = Readonly<{
  kind: ChapterMarkdownKind
  currentPath: string
  synopsisPath: string
  outlinePath: string
  bodyPath: string
}>

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

/** Resolve the three sibling paths for a chapter family file. */
export function resolveChapterArtifactRelations(path: string): ChapterArtifactRelations | undefined {
  const kind = resolveChapterMarkdownKind(path)
  if (kind === undefined) return undefined
  const normalized = path.replaceAll("\\", "/")
  const slash = normalized.lastIndexOf("/")
  const dir = slash >= 0 ? normalized.slice(0, slash) : "章节正文"
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const stem = stripPlanningFilenameSuffix(filename.replace(/\.md$/u, ""))
  return {
    kind,
    currentPath: normalized,
    synopsisPath: `${dir}/${stem}${SYNOPSIS_MARKDOWN_FILENAME_SUFFIX}.md`,
    outlinePath: `${dir}/${stem}${OUTLINE_MARKDOWN_FILENAME_SUFFIX}.md`,
    bodyPath: `${dir}/${stem}.md`,
  }
}

/**
 * Like resolveChapterArtifactRelations, but when stem-based siblings are missing,
 * fall back to same-directory files that share the same「第N章」sequence token.
 */
export function resolveChapterArtifactRelationsWithInventory(
  path: string,
  inventoryPaths: readonly string[],
): ChapterArtifactRelations | undefined {
  const base = resolveChapterArtifactRelations(path)
  if (base === undefined) return undefined
  const sequenceKey = chapterSequenceGroupKey(base.currentPath)
  if (sequenceKey === undefined) return base

  const siblings = inventoryPaths
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => {
      if (!item.startsWith("章节正文/") || !item.endsWith(".md")) return false
      const dir = item.includes("/") ? item.slice(0, item.lastIndexOf("/")) : "章节正文"
      const baseDir = base.currentPath.includes("/")
        ? base.currentPath.slice(0, base.currentPath.lastIndexOf("/"))
        : "章节正文"
      return dir === baseDir && chapterSequenceGroupKey(item) === sequenceKey
    })

  const synopsis = siblings.find((item) => isSynopsisMarkdownPath(item)) ?? base.synopsisPath
  const outline = siblings.find((item) => isOutlineMarkdownPath(item)) ?? base.outlinePath
  const body = siblings.find((item) => isChapterBodyMarkdownPath(item)) ?? base.bodyPath
  return {
    ...base,
    synopsisPath: synopsis,
    outlinePath: outline,
    bodyPath: body,
  }
}

export function chapterArtifactStageLabel(kind: ChapterMarkdownKind): string {
  if (kind === "plot_synopsis") return "梗概"
  if (kind === "plot_outline") return "细纲"
  return "正文"
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

function chapterSequenceGroupKey(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  const stem = stripPlanningFilenameSuffix(name.replace(/\.md$/u, ""))
  const match = stem.match(/^第(\d+|[零一二三四五六七八九十百]+)章(?:\s|$)/u)
  return match?.[1]
}

export function parseChapterSequenceFromPath(path: string): number | undefined {
  const normalized = path.replaceAll("\\", "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  const stem = stripPlanningFilenameSuffix(name.replace(/\.md$/u, ""))
  return parseChapterSequenceFromLabel(stem)
}

export function parseChapterSequenceFromLabel(label: string): number | undefined {
  const trimmed = label.trim()
  const match = trimmed.match(/^第(\d+)章/u) ?? trimmed.match(/^第([零一二三四五六七八九十百]+)章/u)
  if (match === null) return undefined
  const token = match[1]
  if (token === undefined) return undefined
  if (/^\d+$/u.test(token)) return Number(token)
  return parseChineseChapterNumeral(token)
}

function parseChineseChapterNumeral(value: string): number | undefined {
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

export type DiscussFocusChapterOption = Readonly<{
  sequence: number
  label: string
  synopsisPath?: string
  outlinePath?: string
  bodyPath?: string
}>

export function listDiscussFocusChapters(inventoryPaths: readonly string[]): DiscussFocusChapterOption[] {
  const bySequence = new Map<number, {
    sequence: number
    label: string
    synopsisPath?: string
    outlinePath?: string
    bodyPath?: string
  }>()
  for (const raw of inventoryPaths) {
    const path = raw.replaceAll("\\", "/")
    if (!path.startsWith("章节正文/") || !path.endsWith(".md")) continue
    const sequence = parseChapterSequenceFromPath(path)
    if (sequence === undefined) continue
    const kind = resolveChapterMarkdownKind(path)
    if (kind === undefined) continue
    const name = path.slice(path.lastIndexOf("/") + 1)
    const stem = stripPlanningFilenameSuffix(name.replace(/\.md$/u, ""))
    const current = bySequence.get(sequence) ?? { sequence, label: stem }
    if (kind === "plot_synopsis") current.synopsisPath = path
    if (kind === "plot_outline") current.outlinePath = path
    if (kind === "chapter_body") {
      current.bodyPath = path
      current.label = stem
    } else if (current.bodyPath === undefined && (current.outlinePath === undefined || kind === "plot_outline")) {
      current.label = stem
    }
    bySequence.set(sequence, current)
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
}

export function discussFocusOpenLabel(kind: "plot_synopsis" | "plot_outline" | "chapter_body"): string {
  if (kind === "plot_outline") return "打开细纲文件"
  if (kind === "chapter_body") return "打开正文文件"
  return "打开梗概文件"
}

export function resolveDiscussFocusOpenPath(
  option: DiscussFocusChapterOption | undefined,
  kind: "plot_synopsis" | "plot_outline" | "chapter_body",
): string | undefined {
  if (option === undefined) return undefined
  if (kind === "plot_outline") return option.outlinePath ?? option.synopsisPath ?? option.bodyPath
  if (kind === "chapter_body") return option.bodyPath ?? option.outlinePath ?? option.synopsisPath
  return option.synopsisPath ?? option.outlinePath ?? option.bodyPath
}

export function resolveDiscussFocusKindForChapter(
  option: DiscussFocusChapterOption | undefined,
  preferred: "plot_synopsis" | "plot_outline" | "chapter_body",
): "plot_synopsis" | "plot_outline" | "chapter_body" {
  if (option === undefined) return preferred
  if (preferred === "chapter_body" && option.bodyPath !== undefined) return "chapter_body"
  if (preferred === "plot_outline" && option.outlinePath !== undefined) return "plot_outline"
  if (preferred === "plot_synopsis" && option.synopsisPath !== undefined) return "plot_synopsis"
  if (option.bodyPath !== undefined) return "chapter_body"
  if (option.outlinePath !== undefined) return "plot_outline"
  return "plot_synopsis"
}
