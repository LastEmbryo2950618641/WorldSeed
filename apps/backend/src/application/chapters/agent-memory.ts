/** Codex-style progressive agent memory under the project workspace. */

export const AGENT_MEMORY_ROOT = "世界推演规则/Agent记忆" as const
export const AGENT_MEMORY_INDEX_PATH = `${AGENT_MEMORY_ROOT}/MEMORY.md` as const

/** Match Codex MEMORY.md startup budget: first 200 lines or 25KB. */
export const AGENT_MEMORY_INDEX_MAX_LINES = 200
export const AGENT_MEMORY_INDEX_MAX_BYTES = 25_000

export const AGENT_MEMORY_INDEX_DEFAULT = [
  "# Agent 记忆索引",
  "",
  "跨讨论回合保留的工作记忆（偏好、纠错、开放约定）。",
  "本文件启动时注入前 200 行 / 25KB；详情写到同目录主题文件，按需 `request_read`。",
  "",
  "## 条目",
  "",
  "（尚无条目。用户说「记住…」或确认纠错后，用 memory_write 更新。）",
  "",
].join("\n")

export function isAgentMemoryPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/")
  return normalized === AGENT_MEMORY_ROOT
    || normalized.startsWith(`${AGENT_MEMORY_ROOT}/`)
}

export function isAgentMemoryIndexPath(relativePath: string): boolean {
  return relativePath.replaceAll("\\", "/") === AGENT_MEMORY_INDEX_PATH
}

/** Validate topic filename (basename only or under Agent记忆/). */
export function resolveAgentMemoryTopicPath(filename: string): string {
  const raw = filename.trim().replaceAll("\\", "/")
  if (raw.length === 0) throw new Error("filename 不能为空")
  if (raw.includes("..") || raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) {
    throw new Error("filename 必须为相对路径")
  }
  const underRoot = raw.startsWith(`${AGENT_MEMORY_ROOT}/`)
    ? raw
    : `${AGENT_MEMORY_ROOT}/${raw.replace(/^\.\//u, "")}`
  if (!underRoot.endsWith(".md")) throw new Error("主题文件必须为 .md")
  if (underRoot === AGENT_MEMORY_INDEX_PATH) {
    throw new Error("主题文件不能覆盖 MEMORY.md；索引请用 target=index")
  }
  if (!underRoot.startsWith(`${AGENT_MEMORY_ROOT}/`)) {
    throw new Error(`主题文件必须位于 ${AGENT_MEMORY_ROOT}/`)
  }
  const rest = underRoot.slice(AGENT_MEMORY_ROOT.length + 1)
  if (rest.includes("/")) throw new Error("主题文件只能放在 Agent记忆/ 根下（单层文件名）")
  if (!/^[A-Za-z0-9_./\u4e00-\u9fff-]+\.md$/u.test(rest)) {
    throw new Error("主题文件名含非法字符")
  }
  return underRoot
}

export function truncateAgentMemoryIndex(markdown: string): Readonly<{
  text: string
  truncated: boolean
}> {
  const normalized = markdown.replaceAll("\r\n", "\n")
  const lines = normalized.split("\n")
  let text = lines.length > AGENT_MEMORY_INDEX_MAX_LINES
    ? lines.slice(0, AGENT_MEMORY_INDEX_MAX_LINES).join("\n")
    : normalized
  let truncated = lines.length > AGENT_MEMORY_INDEX_MAX_LINES
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength > AGENT_MEMORY_INDEX_MAX_BYTES) {
    truncated = true
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2)
      if (encoder.encode(text.slice(0, mid)).byteLength <= AGENT_MEMORY_INDEX_MAX_BYTES) lo = mid
      else hi = mid - 1
    }
    const cut = text.slice(0, lo)
    const lastNl = cut.lastIndexOf("\n")
    text = lastNl > 0 ? cut.slice(0, lastNl) : cut
  }
  if (!truncated) return { text, truncated: false }
  return {
    text: `${text}\n\n…（索引已截断至 ${String(AGENT_MEMORY_INDEX_MAX_LINES)} 行 / ${String(AGENT_MEMORY_INDEX_MAX_BYTES)} 字节；详情见主题文件）\n`,
    truncated: true,
  }
}
