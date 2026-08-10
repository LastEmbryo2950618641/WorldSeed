export function buildSourceUnitExactKeys(content: string): readonly string[] {
  const keys = new Set<string>()
  const rawContent = content.trim()
  if (rawContent.length > 0) keys.add(rawContent)
  const add = (value: string): void => {
    const normalized = normalizeSourceUnitKey(value)
    if (normalized.length === 0) return
    keys.add(normalized)
    const withoutTerminalPunctuation = normalized.replace(/[。！？!?；;]+$/u, "").trim()
    if (withoutTerminalPunctuation.length > 0) keys.add(withoutTerminalPunctuation)
  }

  add(content)
  for (const line of content.split(/\r?\n/u)) add(line)
  for (const sentence of content.split(/(?<=[。！？!?；;])|\r?\n/u)) add(sentence)
  for (const match of content.matchAll(/[“"]([^”"\r\n]{1,500})[”"]/gu)) {
    const quoted = match[1]
    if (quoted !== undefined) add(quoted)
  }
  return [...keys].slice(0, 128)
}

function normalizeSourceUnitKey(value: string): string {
  return value
    .replace(/^\s*(?:#{1,6}|>|[*+-])\s*/u, "")
    .replace(/^[“"‘']|[”"’']$/gu, "")
    .trim()
}
