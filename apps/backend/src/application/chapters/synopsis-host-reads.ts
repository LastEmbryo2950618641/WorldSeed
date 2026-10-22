import { lstat, readdir, realpath } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"

import type { PhaseResultEnvelope } from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import {
  grepKeywordsFromRequest,
  grepMarkdownContent,
  sliceMarkdownLines,
} from "./synopsis-read-snippets.js"
import { readTextFileUtf8 } from "./text-utf8.js"

const DEFAULT_GREP_CONTEXT_LINES = 2
const DEFAULT_GREP_MAX_MATCHES_PER_FILE = 12
/** Cap full-file host reads so evidence stays model-sized. */
const HOST_MAX_READ_BYTES = 512 * 1024
const HOST_LIST_MAX_ENTRIES = 200

const HOST_TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".svg",
  ".tex",
  ".rst",
  ".adoc",
  ".markdown",
])

/**
 * True when `exactKeys` entry is an absolute host path (POSIX, drive letter, or UNC).
 * Workspace-relative keys stay on the catalog path.
 */
export function isAbsoluteHostPath(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes("\0")) return false
  const normalized = trimmed.replaceAll("\\", "/")
  if (normalized.startsWith("//")) return true
  if (/^[A-Za-z]:\//u.test(normalized)) return true
  if (normalized.startsWith("/")) return true
  return isAbsolute(trimmed)
}

export function extractAbsoluteHostKeys(
  request: PhaseResultEnvelope["requestedReads"][number],
): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const key of request.query.exactKeys) {
    const trimmed = key.trim()
    if (!isAbsoluteHostPath(trimmed)) continue
    const normalized = normalizeHostPathKey(trimmed)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    keys.push(normalized)
  }
  return keys
}

function normalizeHostPathKey(raw: string): string {
  return raw.trim().replaceAll("\\", "/")
}

/**
 * Read-only host filesystem access for synopsis discuss `request_read`.
 * Absolute `exactKeys` only; writes remain on workspace mutation policy.
 */
export async function executeSynopsisHostReads(input: Readonly<{
  requests: PhaseResultEnvelope["requestedReads"]
  existingEvidence: readonly TurnReadEvidence[]
  createId: () => string
  maxCandidates?: number
  maxRequestsPerRound?: number
}>): Promise<readonly TurnReadEvidence[]> {
  const maxRequests = input.maxRequestsPerRound ?? input.requests.length
  const selected = input.requests.slice(0, maxRequests)
  const seen = new Set(input.existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
  const collected: TurnReadEvidence[] = []

  for (const request of selected) {
    const hostKeys = extractAbsoluteHostKeys(request)
    if (hostKeys.length === 0) continue
    const mode = request.query.readMode ?? "read_full"
    const limit = Math.min(
      request.query.maxCandidates,
      input.maxCandidates ?? request.query.maxCandidates,
      hostKeys.length,
    )
    const keywords = grepKeywordsFromRequest(request.query)
    for (const hostKey of hostKeys.slice(0, limit)) {
      try {
        if (mode === "list") {
          const listEvidence = await buildHostListEvidence(hostKey, input.createId)
          const evidenceKey = `${listEvidence.ownerId}:${listEvidence.digest}`
          if (seen.has(evidenceKey)) continue
          seen.add(evidenceKey)
          collected.push(listEvidence)
          continue
        }

        const resolved = await resolveHostFile(hostKey)
        if (resolved.kind === "directory") {
          const listEvidence = await buildHostListEvidence(resolved.path, input.createId)
          const evidenceKey = `${listEvidence.ownerId}:${listEvidence.digest}`
          if (seen.has(evidenceKey)) continue
          seen.add(evidenceKey)
          collected.push(listEvidence)
          continue
        }

        const content = await readHostTextFile(resolved.path, resolved.size)
        if (mode === "grep") {
          const snippets = grepMarkdownContent({
            content,
            keywords,
            contextLines: request.query.grepContextLines ?? DEFAULT_GREP_CONTEXT_LINES,
            maxMatches: request.query.grepMaxMatchesPerFile ?? DEFAULT_GREP_MAX_MATCHES_PER_FILE,
          })
          if (snippets.length === 0) {
            const emptyText = [
              `# grep: ${resolved.path}`,
              `sizeBytes: ${String(resolved.size)}`,
              "matches: 0",
              `keywords: ${keywords.join(" | ") || "(none)"}`,
            ].join("\n")
            const emptyDigest = digest(emptyText)
            const emptyKey = `${resolved.path}:grep:empty:${emptyDigest}`
            if (seen.has(emptyKey)) continue
            seen.add(emptyKey)
            collected.push({
              readId: input.createId(),
              visibility: "committed",
              ownerKind: "host:fs:grep",
              ownerId: `${resolved.path}#grep`,
              exactKeys: [resolved.path, `${resolved.path}#grep`],
              semanticText: emptyText,
              sourceRefs: [{ sourceKind: "workspace", relativePath: resolved.path, version: "host" }],
              digest: emptyDigest,
            })
            continue
          }
          for (const snippet of snippets) {
            const semanticText = [
              `# ${resolved.path} (host grep L${String(snippet.lineStart)}-${String(snippet.lineEnd)})`,
              `hits: ${snippet.hitLines.join(",")}`,
              "",
              snippet.text,
            ].join("\n")
            const snippetDigest = digest(semanticText)
            const evidenceKey = `${resolved.path}:L${String(snippet.lineStart)}-${String(snippet.lineEnd)}:${snippetDigest}`
            if (seen.has(evidenceKey)) continue
            seen.add(evidenceKey)
            collected.push({
              readId: input.createId(),
              visibility: "committed",
              ownerKind: "host:fs:grep",
              ownerId: `${resolved.path}#L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
              exactKeys: [
                resolved.path,
                `${resolved.path}:L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
              ],
              semanticText,
              sourceRefs: [{ sourceKind: "workspace", relativePath: resolved.path, version: "host" }],
              digest: snippetDigest,
            })
          }
          continue
        }

        const sliced = sliceMarkdownLines(content, request.query.lineStart, request.query.lineEnd)
        const evidenceDigest = digest(sliced.text)
        const evidenceKey = `${resolved.path}:${evidenceDigest}`
        if (seen.has(evidenceKey)) continue
        seen.add(evidenceKey)
        collected.push({
          readId: input.createId(),
          visibility: "committed",
          ownerKind: "host:fs",
          ownerId: resolved.path,
          exactKeys: [
            resolved.path,
            ...(sliced.ranged
              ? [`${resolved.path}:L${String(sliced.lineStart)}-${String(sliced.lineEnd)}`]
              : []),
          ],
          semanticText: sliced.ranged
            ? [
                `# ${resolved.path} (host L${String(sliced.lineStart)}-L${String(sliced.lineEnd)} / ${String(sliced.totalLines)} lines, ${String(resolved.size)} bytes)`,
                sliced.text,
              ].join("\n\n")
            : [
                `# ${resolved.path} (host, ${String(resolved.size)} bytes)`,
                sliced.text,
              ].join("\n\n"),
          sourceRefs: [{ sourceKind: "workspace", relativePath: resolved.path, version: "host" }],
          digest: evidenceDigest,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const diagnostic = buildHostDiagnosticEvidence(hostKey, message, input.createId)
        const evidenceKey = `${diagnostic.ownerId}:${diagnostic.digest}`
        if (seen.has(evidenceKey)) continue
        seen.add(evidenceKey)
        collected.push(diagnostic)
      }
    }
  }

  return collected
}

async function resolveHostFile(hostKey: string): Promise<Readonly<{
  kind: "file" | "directory"
  path: string
  size: number
}>> {
  const candidates = await expandHostPathCandidates(hostKey)
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await resolveHostFileExact(candidate)
    } catch (error) {
      lastError = error
      if (!isMissingPathError(error)) throw error
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(`Host path not found: ${hostKey}`)
}

async function resolveHostFileExact(absolutePath: string): Promise<Readonly<{
  kind: "file" | "directory"
  path: string
  size: number
}>> {
  const stats = await lstat(absolutePath)
  if (stats.isSymbolicLink()) {
    throw new Error(`Host path must not be a symbolic link: ${absolutePath}`)
  }
  const resolved = await realpath(absolutePath)
  const resolvedStats = await lstat(resolved)
  if (resolvedStats.isSymbolicLink()) {
    throw new Error(`Host path resolves through a symbolic link: ${absolutePath}`)
  }
  if (resolvedStats.isDirectory()) {
    return { kind: "directory", path: resolved.replaceAll("\\", "/"), size: 0 }
  }
  if (!resolvedStats.isFile()) {
    throw new Error(`Host path is not a regular file or directory: ${absolutePath}`)
  }
  return {
    kind: "file",
    path: resolved.replaceAll("\\", "/"),
    size: resolvedStats.size,
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
}

/**
 * When the model retypes a Windows path, fullwidth punctuation (？／！) often
 * becomes ASCII (?/!). Try the literal path first, then punctuation variants,
 * then a single-level sibling name match under the parent directory.
 */
async function expandHostPathCandidates(hostKey: string): Promise<string[]> {
  const absolute = resolve(hostKey)
  const seen = new Set<string>()
  const ordered: string[] = []
  const push = (value: string): void => {
    const normalized = value.replaceAll("\\", "/")
    if (seen.has(normalized)) return
    seen.add(normalized)
    ordered.push(value)
  }
  push(absolute)
  for (const variant of punctuationPathVariants(absolute)) push(variant)

  const parent = dirname(absolute)
  const leaf = basename(absolute)
  try {
    const siblings = await readdir(parent)
    const leafFold = foldPathPunctuation(leaf)
    for (const sibling of siblings) {
      if (foldPathPunctuation(sibling) !== leafFold) continue
      push(join(parent, sibling))
    }
  } catch {
    // Parent missing or unreadable — keep punctuation variants only.
  }
  return ordered
}

/** Map common fullwidth / ASCII punctuation pairs so path typos still match. */
export function foldPathPunctuation(value: string): string {
  return value
    .replaceAll("？", "?")
    .replaceAll("！", "!")
    .replaceAll("／", "/")
    .replaceAll("＼", "\\")
    .replaceAll("：", ":")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("，", ",")
    .replaceAll("。", ".")
    .replaceAll("　", " ")
}

function punctuationPathVariants(absolutePath: string): string[] {
  const leaf = basename(absolutePath)
  const parent = dirname(absolutePath)
  const variants = new Set<string>()
  const swapPairs: ReadonlyArray<readonly [string, string]> = [
    ["?", "？"],
    ["!", "！"],
    ["？", "?"],
    ["！", "!"],
  ]
  for (const [from, to] of swapPairs) {
    if (!leaf.includes(from)) continue
    variants.add(join(parent, leaf.replaceAll(from, to)))
  }
  // Combined ASCII→fullwidth and fullwidth→ASCII for ? and ! together.
  const toFullwidth = leaf.replaceAll("?", "？").replaceAll("!", "！")
  const toAscii = leaf.replaceAll("？", "?").replaceAll("！", "!")
  if (toFullwidth !== leaf) variants.add(join(parent, toFullwidth))
  if (toAscii !== leaf) variants.add(join(parent, toAscii))
  return [...variants]
}

async function readHostTextFile(absolutePath: string, size: number): Promise<string> {
  const extension = extname(absolutePath).toLowerCase()
  if (extension.length > 0 && !HOST_TEXT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Host file type not allowed for discuss read (${extension || "no extension"}): ${absolutePath}`,
    )
  }
  if (size > HOST_MAX_READ_BYTES) {
    throw new Error(
      `Host file exceeds ${String(HOST_MAX_READ_BYTES)} bytes; use readMode list/grep or lineStart/lineEnd: ${absolutePath}`,
    )
  }
  const content = await readTextFileUtf8(absolutePath)
  if (content.includes("\0")) {
    throw new Error(`Host file looks binary (contains NUL): ${absolutePath}`)
  }
  return content
}

async function buildHostListEvidence(
  hostKey: string,
  createId: () => string,
): Promise<TurnReadEvidence> {
  const resolved = await resolveHostFile(hostKey)
  if (resolved.kind === "file") {
    const text = [
      `# list(host): ${resolved.path}`,
      "kind: file",
      `sizeBytes: ${String(resolved.size)}`,
      `extension: ${extname(resolved.path).toLowerCase() || "(none)"}`,
    ].join("\n")
    return {
      readId: createId(),
      visibility: "committed",
      ownerKind: "host:fs:list",
      ownerId: `${resolved.path}#list`,
      exactKeys: [resolved.path, `${resolved.path}#list`],
      semanticText: text,
      sourceRefs: [{ sourceKind: "workspace", relativePath: resolved.path, version: "host" }],
      digest: digest(text),
    }
  }

  const entries = await readdir(resolved.path, { withFileTypes: true })
  const lines: string[] = [
    `# list(host): ${resolved.path}`,
    `entries: ${String(Math.min(entries.length, HOST_LIST_MAX_ENTRIES))}${entries.length > HOST_LIST_MAX_ENTRIES ? ` (truncated of ${String(entries.length)})` : ""}`,
  ]
  let listed = 0
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (listed >= HOST_LIST_MAX_ENTRIES) break
    if (entry.isSymbolicLink()) {
      lines.push(`- link\t${entry.name}`)
      listed += 1
      continue
    }
    if (entry.isDirectory()) {
      lines.push(`- dir\t${entry.name}/`)
      listed += 1
      continue
    }
    if (entry.isFile()) {
      try {
        const childPath = resolve(resolved.path, entry.name)
        const stats = await lstat(childPath)
        lines.push(`- file\t${entry.name}\t${String(stats.size)}`)
      } catch {
        lines.push(`- file\t${entry.name}\t?`)
      }
      listed += 1
    }
  }
  const text = lines.join("\n")
  return {
    readId: createId(),
    visibility: "committed",
    ownerKind: "host:fs:list",
    ownerId: `${resolved.path}#list`,
    exactKeys: [resolved.path, `${resolved.path}#list`],
    semanticText: text,
    sourceRefs: [{ sourceKind: "workspace", relativePath: resolved.path, version: "host" }],
    digest: digest(text),
  }
}

function buildHostDiagnosticEvidence(
  hostKey: string,
  message: string,
  createId: () => string,
): TurnReadEvidence {
  const text = [
    `# host read failed: ${hostKey}`,
    message,
    "说明：这是本机绝对路径只读尝试失败，不是工作区 catalog 缺失。",
    "Agent 须：在回复中直接向用户说明本机路径读取失败及原因；禁止假装已读到该路径内容；禁止默默改用工作区材料顶替。",
    "可下一步：改 readMode=list；核对路径标点（全角？/！与半角?/! 不同，系统会尝试容错）；优先 request_read 绝对路径，勿先用 bash 硬闯带 ! 的 Windows 路径；或经用户同意后再读工作区材料。",
  ].join("\n")
  return {
    readId: createId(),
    visibility: "committed",
    ownerKind: "host:fs:diagnostic",
    ownerId: `${hostKey}#error`,
    exactKeys: [hostKey],
    semanticText: text,
    sourceRefs: [{ sourceKind: "workspace", relativePath: hostKey, version: "host" }],
    digest: digest(text),
  }
}
