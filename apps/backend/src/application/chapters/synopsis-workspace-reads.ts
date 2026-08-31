import type {
  PhaseResultEnvelope,
  ReadRequest,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort } from "../workspace/index.js"

const DEFAULT_GREP_CONTEXT_LINES = 2
const DEFAULT_GREP_MAX_MATCHES_PER_FILE = 12
const LIST_EVIDENCE_OWNER = "workspace:catalog"

/**
 * Execute workspace-backed reads for synopsis ReAct (settings / rules / references).
 * Supports full-file load (default), catalog list with sizes, and grep-style snippets.
 */
export async function executeSynopsisWorkspaceReads(input: Readonly<{
  workspace: WorkspacePort
  workspaceRootRef: string
  catalog: WorkspaceCatalogSnapshot
  requests: PhaseResultEnvelope["requestedReads"]
  existingEvidence: readonly TurnReadEvidence[]
  createId: () => string
  maxCandidates?: number
  maxRequestsPerRound?: number
  allowWorkspaceChapterReads?: boolean
}>): Promise<readonly TurnReadEvidence[]> {
  const maxRequests = input.maxRequestsPerRound ?? input.requests.length
  const selected = input.requests.slice(0, maxRequests)
  const seen = new Set(input.existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
  const collected: TurnReadEvidence[] = []
  for (const request of selected) {
    const mode = request.query.readMode ?? "read_full"
    if (mode === "list") {
      const listEvidence = buildCatalogListEvidence({
        catalog: input.catalog,
        request,
        createId: input.createId,
        allowWorkspaceChapterReads: input.allowWorkspaceChapterReads === true,
      })
      if (listEvidence !== undefined) {
        const evidenceKey = `${listEvidence.ownerId}:${listEvidence.digest}`
        if (!seen.has(evidenceKey)) {
          seen.add(evidenceKey)
          collected.push(listEvidence)
        }
      }
      continue
    }

    const limit = Math.min(request.query.maxCandidates, input.maxCandidates ?? request.query.maxCandidates)
    const entries = selectSynopsisWorkspaceEntries(
      input.catalog,
      request,
      limit,
      input.allowWorkspaceChapterReads === true,
    )
    for (const entry of entries) {
      const content = await input.workspace.readMarkdown(input.workspaceRootRef, entry.relativePath)
      if (mode === "grep") {
        const snippets = grepMarkdownContent({
          content,
          keywords: grepKeywords(request),
          contextLines: request.query.grepContextLines ?? DEFAULT_GREP_CONTEXT_LINES,
          maxMatches: request.query.grepMaxMatchesPerFile ?? DEFAULT_GREP_MAX_MATCHES_PER_FILE,
        })
        if (snippets.length === 0) {
          const emptyText = [
            `# grep: ${entry.relativePath}`,
            `sizeBytes: ${String(entry.size)}`,
            "matches: 0",
            `keywords: ${grepKeywords(request).join(" | ") || "(none)"}`,
          ].join("\n")
          const emptyDigest = digest(emptyText)
          const emptyKey = `${entry.relativePath}:grep:empty:${emptyDigest}`
          if (seen.has(emptyKey)) continue
          seen.add(emptyKey)
          collected.push({
            readId: input.createId(),
            visibility: "committed",
            ownerKind: `workspace:${entry.role}:grep`,
            ownerId: `${entry.relativePath}#grep`,
            exactKeys: [entry.relativePath, `${entry.relativePath}#grep`],
            semanticText: emptyText,
            sourceRefs: [{ sourceKind: "workspace", relativePath: entry.relativePath, version: entry.version }],
            digest: emptyDigest,
          })
          continue
        }
        for (const snippet of snippets) {
          const semanticText = formatGrepSnippet(entry, snippet)
          const snippetDigest = digest(semanticText)
          const evidenceKey = `${entry.relativePath}:L${String(snippet.lineStart)}-${String(snippet.lineEnd)}:${snippetDigest}`
          if (seen.has(evidenceKey)) continue
          seen.add(evidenceKey)
          collected.push({
            readId: input.createId(),
            visibility: "committed",
            ownerKind: `workspace:${entry.role}:grep`,
            ownerId: `${entry.relativePath}#L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
            exactKeys: [
              entry.relativePath,
              `${entry.relativePath}:L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
            ],
            semanticText,
            sourceRefs: [{ sourceKind: "workspace", relativePath: entry.relativePath, version: entry.version }],
            digest: snippetDigest,
          })
        }
        continue
      }

      const sliced = sliceMarkdownLines(content, request.query.lineStart, request.query.lineEnd)
      const evidenceDigest = digest(sliced.text)
      const evidenceKey = `${entry.relativePath}:${evidenceDigest}`
      if (seen.has(evidenceKey)) continue
      seen.add(evidenceKey)
      collected.push({
        readId: input.createId(),
        visibility: "committed",
        ownerKind: `workspace:${entry.role}`,
        ownerId: entry.relativePath,
        exactKeys: [
          entry.relativePath,
          entry.relativePath.split("/").at(-1) ?? entry.relativePath,
          ...(sliced.ranged
            ? [`${entry.relativePath}:L${String(sliced.lineStart)}-${String(sliced.lineEnd)}`]
            : []),
        ],
        semanticText: sliced.ranged
          ? [
              `# ${entry.relativePath} (L${String(sliced.lineStart)}-L${String(sliced.lineEnd)} / ${String(sliced.totalLines)} lines, ${String(entry.size)} bytes)`,
              sliced.text,
            ].join("\n\n")
          : sliced.text,
        sourceRefs: [{ sourceKind: "workspace", relativePath: entry.relativePath, version: entry.version }],
        digest: evidenceDigest,
      })
    }
  }
  return collected
}

export function selectSynopsisWorkspaceEntries(
  catalogSnapshot: WorkspaceCatalogSnapshot,
  request: PhaseResultEnvelope["requestedReads"][number],
  limit: number,
  allowWorkspaceChapterReads: boolean,
): WorkspaceCatalogEntry[] {
  const roles = synopsisRolesForRequest(request, allowWorkspaceChapterReads)
  if (roles.size === 0) return []
  const terms = [...request.query.exactKeys, ...request.query.semanticTexts]
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
  return catalogSnapshot.entries
    .filter((entry) => entry.entryKind === "file" && roles.has(entry.role))
    .map((entry) => {
      const path = entry.relativePath.toLocaleLowerCase()
      const filename = path.split("/").at(-1) ?? path
      const score = terms.length === 0 ? 1 : Math.max(0, ...terms.map((term) => (
        path === term ? 100 : filename === term ? 80 : path.includes(term) ? 20 : 0
      )))
      return { entry, score }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.entry.relativePath.localeCompare(right.entry.relativePath, "zh-CN"))
    .slice(0, limit)
    .map((candidate) => candidate.entry)
}

export function formatSynopsisSearchLabel(request: PhaseResultEnvelope["requestedReads"][number]): string {
  const mode = request.query.readMode ?? "read_full"
  const keys = [...request.query.exactKeys, ...request.query.semanticTexts].filter((term) => term.trim().length > 0)
  const kinds = request.query.sourceKinds.join(",")
  const prefix = mode === "read_full" ? `read(${kinds})` : `${mode}(${kinds})`
  if (keys.length === 0) return prefix
  return `${prefix}: ${keys.slice(0, 3).join(" · ")}`
}

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

type GrepSnippet = Readonly<{
  lineStart: number
  lineEnd: number
  hitLines: readonly number[]
  text: string
}>

function buildCatalogListEvidence(input: Readonly<{
  catalog: WorkspaceCatalogSnapshot
  request: ReadRequest
  createId: () => string
  allowWorkspaceChapterReads: boolean
}>): TurnReadEvidence | undefined {
  const roles = synopsisRolesForRequest(input.request, input.allowWorkspaceChapterReads)
  if (roles.size === 0) return undefined
  const prefixes = input.request.query.exactKeys
    .map((key) => key.trim().replace(/\\/gu, "/"))
    .filter((key) => key.length > 0)
  const entries = input.catalog.entries
    .filter((entry) => roles.has(entry.role))
    .filter((entry) => {
      if (prefixes.length === 0) return true
      const path = entry.relativePath
      return prefixes.some((prefix) => (
        path === prefix
        || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
        || path.startsWith(prefix)
      ))
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"))
  const limit = Math.min(input.request.query.maxCandidates, 200)
  const limited = entries.slice(0, limit)
  const lines = [
    "# workspace catalog list",
    `scope: ${prefixes.length === 0 ? "(all matched roles)" : prefixes.join(" | ")}`,
    `roles: ${[...roles].join(",")}`,
    `count: ${String(limited.length)}${entries.length > limited.length ? ` (truncated from ${String(entries.length)})` : ""}`,
    "",
    ...limited.map((entry) => (
      entry.entryKind === "directory"
        ? `dir\t${entry.relativePath}/\t0`
        : `file\t${entry.relativePath}\t${String(entry.size)}`
    )),
  ]
  const semanticText = lines.join("\n")
  const ownerId = `list:${prefixes.join("|") || "root"}:${[...roles].sort().join(",")}`
  return {
    readId: input.createId(),
    visibility: "committed",
    ownerKind: LIST_EVIDENCE_OWNER,
    ownerId,
    exactKeys: [ownerId, ...prefixes],
    semanticText,
    sourceRefs: [],
    digest: digest(semanticText),
  }
}

function formatGrepSnippet(
  entry: WorkspaceCatalogEntry,
  snippet: GrepSnippet,
): string {
  return [
    `# grep: ${entry.relativePath}`,
    `sizeBytes: ${String(entry.size)}`,
    `lines: L${String(snippet.lineStart)}-L${String(snippet.lineEnd)}`,
    `hits: ${snippet.hitLines.join(",")}`,
    "",
    snippet.text,
  ].join("\n")
}

function grepKeywords(request: ReadRequest): string[] {
  // Prefer semanticTexts as keywords; exactKeys that look like paths stay as file selectors.
  const semantic = request.query.semanticTexts.map((term) => term.trim()).filter((term) => term.length > 0)
  if (semantic.length > 0) return semantic
  return request.query.exactKeys
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !term.includes("/"))
}

function synopsisRolesForRequest(
  request: PhaseResultEnvelope["requestedReads"][number],
  allowWorkspaceChapterReads: boolean,
): Set<WorkspaceCatalogEntry["role"]> {
  const roles = new Set<WorkspaceCatalogEntry["role"]>()
  if (request.query.sourceKinds.includes("rule")) roles.add("world_rules")
  if (request.query.sourceKinds.includes("reference")) {
    roles.add("settings")
    roles.add("references")
    roles.add("staging")
  }
  if (allowWorkspaceChapterReads && request.query.sourceKinds.includes("source")) roles.add("chapters")
  return roles
}
