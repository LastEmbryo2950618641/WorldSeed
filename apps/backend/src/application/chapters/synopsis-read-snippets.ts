export type GrepSnippet = Readonly<{
  lineStart: number
  lineEnd: number
  hitLines: readonly number[]
  text: string
}>

export function grepMarkdownContent(input: Readonly<{
  content: string
  keywords: readonly string[]
  contextLines: number
  maxMatches: number
}>): readonly GrepSnippet[] {
  const keywords = input.keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
  if (keywords.length === 0) return []
  const lines = input.content.split(/\r?\n/u)
  const loweredKeywords = keywords.map((keyword) => keyword.toLocaleLowerCase())
  const matchIndexes: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const lowered = line.toLocaleLowerCase()
    if (loweredKeywords.some((keyword) => lowered.includes(keyword))) {
      matchIndexes.push(index)
      if (matchIndexes.length >= input.maxMatches) break
    }
  }
  if (matchIndexes.length === 0) return []
  const windows: Array<{ start: number; end: number; hitLines: number[] }> = []
  for (const matchIndex of matchIndexes) {
    const start = Math.max(0, matchIndex - input.contextLines)
    const end = Math.min(lines.length - 1, matchIndex + input.contextLines)
    const previous = windows.at(-1)
    if (previous !== undefined && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end)
      previous.hitLines.push(matchIndex + 1)
      continue
    }
    windows.push({ start, end, hitLines: [matchIndex + 1] })
  }
  return windows.map((window) => ({
    lineStart: window.start + 1,
    lineEnd: window.end + 1,
    hitLines: window.hitLines,
    text: lines.slice(window.start, window.end + 1).join("\n"),
  }))
}

export function sliceMarkdownLines(
  content: string,
  lineStart: number | undefined,
  lineEnd: number | undefined,
): Readonly<{ text: string; ranged: boolean; lineStart: number; lineEnd: number; totalLines: number }> {
  const lines = content.split(/\r?\n/u)
  const totalLines = lines.length
  if (lineStart === undefined && lineEnd === undefined) {
    return { text: content, ranged: false, lineStart: 1, lineEnd: totalLines, totalLines }
  }
  const start = Math.max(1, lineStart ?? 1)
  const end = Math.min(totalLines, lineEnd ?? totalLines)
  const safeStart = Math.min(start, end)
  const safeEnd = Math.max(start, end)
  return {
    text: lines.slice(safeStart - 1, safeEnd).join("\n"),
    ranged: true,
    lineStart: safeStart,
    lineEnd: safeEnd,
    totalLines,
  }
}

/** Prefer semanticTexts as keywords; bare exactKeys (no path slash) can act as keywords. */
export function grepKeywordsFromRequest(input: Readonly<{
  exactKeys: readonly string[]
  semanticTexts: readonly string[]
}>): string[] {
  const semantic = input.semanticTexts.map((term) => term.trim()).filter((term) => term.length > 0)
  if (semantic.length > 0) return semantic
  return input.exactKeys
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !term.includes("/") && !term.includes("\\"))
}
