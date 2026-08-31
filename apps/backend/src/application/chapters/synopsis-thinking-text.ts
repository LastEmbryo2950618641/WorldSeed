/**
 * Turn provider "reasoning" into human-readable thinking text for the creation desk.
 * DeepSeek + json_object often echoes the phase envelope into reasoning_content;
 * surface reason / selfReview instead of raw JSON.
 */
export function normalizeThinkingDisplayText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith("{")) return raw

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const parts = collectThinkingParts(parsed)
    return parts.length === 0 ? undefined : parts.join("\n\n")
  } catch {
    return extractThinkingFieldsFromPartialJson(trimmed)
  }
}

function collectThinkingParts(parsed: Record<string, unknown>): string[] {
  const reason = readNonEmptyString(parsed.reason)
  const selfReview = readNonEmptyString(parsed.selfReview)
  const artifact = asRecord(parsed.artifact)
  const finalSelfReview = artifact === undefined ? undefined : readNonEmptyString(artifact.finalSelfReview)
  return [reason, selfReview, finalSelfReview].filter((part): part is string => part !== undefined)
}

function extractThinkingFieldsFromPartialJson(raw: string): string | undefined {
  const reason = extractJsonStringField(raw, "reason")
  const selfReview = extractJsonStringField(raw, "selfReview")
  const finalSelfReview = extractJsonStringField(raw, "finalSelfReview")
  const parts = [reason, selfReview, finalSelfReview].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

function extractJsonStringField(raw: string, field: string): string | undefined {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"))
  if (match?.[1] === undefined) return undefined
  try {
    const value = JSON.parse(`"${match[1]}"`) as string
    return value.trim().length === 0 ? undefined : value
  } catch {
    const value = match[1]
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
      .trim()
    return value.length === 0 ? undefined : value
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
