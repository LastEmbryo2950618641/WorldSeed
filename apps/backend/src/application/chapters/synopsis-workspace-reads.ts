import type {
  PhaseResultEnvelope,
  ReadRequest,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import {
  assertWorkDescriptionCharLimit,
  digest,
  isWorkDescriptionRulePath,
} from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import type { WorkspacePort } from "../workspace/index.js"
import {
  executeSynopsisHostReads,
  extractAbsoluteHostKeys,
  isAbsoluteHostPath,
} from "./synopsis-host-reads.js"
import {
  type GrepSnippet,
  grepKeywordsFromRequest,
  grepMarkdownContent,
  sliceMarkdownLines,
} from "./synopsis-read-snippets.js"

export { grepMarkdownContent, sliceMarkdownLines } from "./synopsis-read-snippets.js"

const DEFAULT_GREP_CONTEXT_LINES = 2
const DEFAULT_GREP_MAX_MATCHES_PER_FILE = 12
const LIST_EVIDENCE_OWNER = "workspace:catalog"

/**
 * Execute workspace-backed reads for synopsis ReAct (settings / rules / references).
 * Supports full-file load (default), catalog list with sizes, and grep-style snippets.
 * Absolute `exactKeys` are also handled as read-only host filesystem paths.
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
  const hostEvidence = await executeSynopsisHostReads({
    requests: input.requests,
    existingEvidence: input.existingEvidence,
    createId: input.createId,
    ...(input.maxCandidates === undefined ? {} : { maxCandidates: input.maxCandidates }),
    ...(input.maxRequestsPerRound === undefined ? {} : { maxRequestsPerRound: input.maxRequestsPerRound }),
  })

  const maxRequests = input.maxRequestsPerRound ?? input.requests.length
  const selected = input.requests.slice(0, maxRequests)
  const seen = new Set([
    ...input.existingEvidence.map((item) => `${item.ownerId}:${item.digest}`),
    ...hostEvidence.map((item) => `${item.ownerId}:${item.digest}`),
  ])
  const collected: TurnReadEvidence[] = [...hostEvidence]
  for (const request of selected) {
    const mode = request.query.readMode ?? "read_full"
    const hostKeys = extractAbsoluteHostKeys(request)
    const hasRelativeKeys = request.query.exactKeys.some((key) => {
      const trimmed = key.trim()
      return trimmed.length > 0 && !isAbsoluteHostPath(trimmed)
    })
    // Absolute-only requests are fully handled by host reads; skip empty catalog noise.
    if (hostKeys.length > 0 && !hasRelativeKeys && request.query.semanticTexts.every((term) => term.trim().length === 0)) {
      continue
    }
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
      if (isWorkDescriptionRulePath(entry.relativePath)) {
        assertWorkDescriptionCharLimit(entry.relativePath, content)
      }
      if (mode === "grep") {
        const keywords = grepKeywords(request)
        const snippets = grepMarkdownContent({
          content,
          keywords,
          contextLines: request.query.grepContextLines ?? DEFAULT_GREP_CONTEXT_LINES,
          maxMatches: request.query.grepMaxMatchesPerFile ?? DEFAULT_GREP_MAX_MATCHES_PER_FILE,
        })
        if (snippets.length === 0) {
          const emptyText = [
            `# grep: ${entry.relativePath}`,
            `sizeBytes: ${String(entry.size)}`,
            "matches: 0",
            `keywords: ${keywords.join(" | ") || "(none)"}`,
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
  return grepKeywordsFromRequest(request.query)
}

function synopsisRolesForRequest(
  request: PhaseResultEnvelope["requestedReads"][number],
  allowWorkspaceChapterReads: boolean,
): Set<WorkspaceCatalogEntry["role"]> {
  // Full workspace read: every catalog root is readable (still write-gated elsewhere).
  if (allowWorkspaceChapterReads) {
    return new Set<WorkspaceCatalogEntry["role"]>([
      "world_rules",
      "settings",
      "references",
      "chapters",
      "presentation",
      "staging",
      "outline",
    ])
  }
  const roles = new Set<WorkspaceCatalogEntry["role"]>()
  if (request.query.sourceKinds.includes("rule")) {
    roles.add("world_rules")
    // Presentation rules live under 表现输出/ and share the "rule" sourceKind in discuss ReAct.
    roles.add("presentation")
  }
  if (request.query.sourceKinds.includes("reference")) {
    roles.add("settings")
    roles.add("references")
    roles.add("staging")
    roles.add("outline")
  }
  if (requestMentionsPresentationRules(request)) roles.add("presentation")
  return roles
}

/** True when the read query explicitly targets 描写/笔风/本作品描写 paths or labels. */
export function requestMentionsPresentationRules(
  request: PhaseResultEnvelope["requestedReads"][number],
): boolean {
  return [...request.query.exactKeys, ...request.query.semanticTexts].some((term) => {
    const normalized = term.trim().replace(/\\/gu, "/")
    return (
      normalized.startsWith("表现输出/")
      || normalized.includes("描写规则")
      || normalized.includes("笔风规则")
      || normalized.includes("本作品描写")
    )
  })
}

/** User-rule markdown under `世界推演规则/用户规则/` (nested folders allowed). */
export function isUserRuleMarkdownPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/gu, "/")
  return normalized.startsWith("世界推演规则/用户规则/") && normalized.endsWith(".md")
}

export function listUserRuleMarkdownPaths(
  entries: readonly Readonly<{ relativePath: string; entryKind: string }>[],
): string[] {
  return entries
    .filter((entry) => entry.entryKind === "file" && isUserRuleMarkdownPath(entry.relativePath))
    .map((entry) => entry.relativePath.trim().replace(/\\/gu, "/"))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
}

/** User-selected 描写/笔风 dropdown files (not the this-work overlay). */
export function isPresentationRuleMarkdownPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/gu, "/")
  return /^表现输出\/(?:描写规则|笔风规则)\/[^/]+\.md$/u.test(normalized)
}
