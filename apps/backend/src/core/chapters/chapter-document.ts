export function normalizeChapterHeading(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error("Chapter heading cannot be empty")
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("Chapter heading must be a single line")
  }
  if (/^#+(?:\s|$)/u.test(normalized)) {
    throw new Error("Chapter heading must be plain text without Markdown markers")
  }
  return normalized
}

export function deriveChapterPublishPath(heading: string): string {
  const filename = normalizeChapterHeading(heading)
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
  if (filename.length === 0) throw new Error("Chapter heading does not contain a valid filename")
  return `章节正文/${filename}.md`
}

export function assembleChapterDocument(heading: string, content: string): string {
  const normalizedHeading = normalizeChapterHeading(heading)
  const body = content.replaceAll("\r\n", "\n").trim()
  return body.length === 0 ? `# ${normalizedHeading}` : `# ${normalizedHeading}\n\n${body}`
}

export function readChapterBody(heading: string, content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").trim()
  const prefix = `# ${normalizeChapterHeading(heading)}`
  if (normalized === prefix) return ""
  return normalized.startsWith(`${prefix}\n`) ? normalized.slice(prefix.length).trimStart() : normalized
}
