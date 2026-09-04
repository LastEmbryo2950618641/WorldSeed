export type SearchReplaceOp = Readonly<{
  oldText: string
  newText: string
}>

export type SearchReplaceSuccess = Readonly<{
  ok: true
  content: string
  appliedCount: number
}>

export type SearchReplaceFailure = Readonly<{
  ok: false
  reason: string
  failedOpIndex: number
}>

export type SearchReplaceResult = SearchReplaceSuccess | SearchReplaceFailure

/** Apply sequential exact unique replacements. All-or-nothing. */
export function applySearchReplace(
  source: string,
  ops: readonly SearchReplaceOp[],
): SearchReplaceResult {
  if (ops.length === 0) {
    return { ok: false, reason: "bodyEdits.ops 不能为空", failedOpIndex: -1 }
  }
  let content = normalizeNewlines(source)
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!
    const oldText = normalizeNewlines(op.oldText)
    if (oldText.length === 0) {
      return {
        ok: false,
        reason: `第 ${index + 1} 条 oldText 为空`,
        failedOpIndex: index,
      }
    }
    const occurrences = countOccurrences(content, oldText)
    if (occurrences === 0) {
      return {
        ok: false,
        reason: `找不到要替换的原文（第 ${index + 1} 条 oldText 未命中）`,
        failedOpIndex: index,
      }
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `要替换的原文不唯一（第 ${index + 1} 条 oldText 出现 ${occurrences} 次）`,
        failedOpIndex: index,
      }
    }
    const at = content.indexOf(oldText)
    content = content.slice(0, at) + normalizeNewlines(op.newText) + content.slice(at + oldText.length)
  }
  return { ok: true, content, appliedCount: ops.length }
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n")
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}
