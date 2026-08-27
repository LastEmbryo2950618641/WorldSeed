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

export function formatChapterSequenceLabel(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new Error("Chapter sequence must be a positive integer")
  }
  return `第${formatChineseNumeral(sequence)}章`
}

function formatChineseNumeral(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (value <= 10) return ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][value] ?? String(value)
  if (value < 20) return `十${digits[value % 10] ?? ""}`.replace(/十$/u, "十")
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    const tensPart = tens === 1 ? "十" : `${digits[tens] ?? String(tens)}十`
    return ones === 0 ? tensPart : `${tensPart}${digits[ones] ?? String(ones)}`
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100)
    const remainder = value % 100
    const hundredsPart = `${digits[hundreds] ?? String(hundreds)}百`
    if (remainder === 0) return hundredsPart
    if (remainder < 10) return `${hundredsPart}零${formatChineseNumeral(remainder)}`
    return `${hundredsPart}${formatChineseNumeral(remainder)}`
  }
  return String(value)
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
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
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
