import type {
  PhaseResultEnvelope,
  ProjectId,
  ReadRequest,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import type { DocumentRepository } from "../turns/ports/document-repository.js"
import type { InternalStorePort } from "../workspace/index.js"
import type { SettingsLineageService } from "../settings/settings-lineage-service.js"
import type { SqliteChapterIndexRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import { ChapterTemporalSourceResolver } from "./chapter-temporal-source-resolver.js"
import {
  grepMarkdownContent,
  selectSynopsisWorkspaceEntries,
  sliceMarkdownLines,
} from "./synopsis-workspace-reads.js"

export const DEFAULT_TEMPORAL_MAX_CHARS = 3_000
export const MAX_TEMPORAL_READS_PER_ROUND = 2

const DEFAULT_GREP_CONTEXT_LINES = 2
const DEFAULT_GREP_MAX_MATCHES = 8

export function isTemporalReadRequest(request: ReadRequest): boolean {
  const purpose = request.query.purpose ?? "current"
  return purpose === "as_of_chapter" || purpose === "past_chapter_text"
}

export function formatTemporalSearchLabel(request: ReadRequest): string {
  const purpose = request.query.purpose ?? "current"
  const n = request.query.asOfChapterSequence
  const keys = [...request.query.exactKeys, ...request.query.semanticTexts].filter((term) => term.trim().length > 0)
  const keyPart = keys.length === 0 ? "" : `: ${keys.slice(0, 2).join(" · ")}`
  if (purpose === "as_of_chapter" && n !== undefined) {
    return `as-of(第${String(n)}章)${keyPart}`
  }
  if (purpose === "past_chapter_text" && n !== undefined) {
    return `past-ch(第${String(n)}章)${keyPart}`
  }
  return `temporal${keyPart}`
}

export function validateTemporalChapterSequence(input: Readonly<{
  asOfChapterSequence: number
  sessionChapterSequence: number
}>): boolean {
  return input.asOfChapterSequence >= 1 && input.asOfChapterSequence < input.sessionChapterSequence
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…（已截断至 ${String(maxChars)} 字）`
}

export async function executeSynopsisTemporalReads(input: Readonly<{
  projectId: ProjectId
  sessionChapterSequence: number
  catalog: WorkspaceCatalogSnapshot
  requests: readonly PhaseResultEnvelope["requestedReads"][number][]
  existingEvidence: readonly TurnReadEvidence[]
  settingsLineage: SettingsLineageService
  chapterIndex: SqliteChapterIndexRepository
  documents: DocumentRepository
  internalStore: InternalStorePort
  chapterTemporal: ChapterTemporalSourceResolver
  createId: () => string
  maxCandidates?: number
}>): Promise<readonly TurnReadEvidence[]> {
  const seen = new Set(input.existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
  const collected: TurnReadEvidence[] = []

  for (const request of input.requests) {
    const purpose = request.query.purpose ?? "current"
    if (purpose === "current") continue
    const asOfN = request.query.asOfChapterSequence
    if (asOfN === undefined) continue
    if (!validateTemporalChapterSequence({
      asOfChapterSequence: asOfN,
      sessionChapterSequence: input.sessionChapterSequence,
    })) {
      continue
    }

    const maxChars = request.query.maxChars ?? DEFAULT_TEMPORAL_MAX_CHARS
    const mode = request.query.readMode ?? "read_full"

    if (purpose === "as_of_chapter") {
      const limit = Math.min(
        request.query.maxCandidates,
        input.maxCandidates ?? request.query.maxCandidates,
      )
      const paths = selectSynopsisWorkspaceEntries(
        input.catalog,
        request,
        limit,
        false,
      ).map((entry) => entry.relativePath)

      for (const relativePath of paths) {
        const resolved = await input.settingsLineage.readAsOfChapter({
          relativePath,
          chapterSequence: asOfN,
        })
        if (resolved === undefined) continue

        const evidenceItems = buildTemporalSettingsEvidence({
          request,
          relativePath,
          markdown: resolved.markdown,
          asOfN,
          mode,
          maxChars,
          createId: input.createId,
        })
        for (const item of evidenceItems) {
          const key = `${item.ownerId}:${item.digest}`
          if (seen.has(key)) continue
          seen.add(key)
          collected.push(item)
        }
      }
      continue
    }

    if (purpose === "past_chapter_text") {
      const resolved = await input.chapterTemporal.resolve({
        projectId: input.projectId,
        targetSequence: asOfN,
        cursorSequence: input.sessionChapterSequence,
      })
      if (resolved === undefined) continue
      const version = await input.documents.findStoredVersion(input.projectId, resolved.sourceId)
      if (version === undefined) continue
      let content = ""
      try {
        content = await input.internalStore.readDocument(version.contentRef)
      } catch {
        continue
      }

      const pinNote = resolved.pinned
        ? `（ lineage 钉住 · 写第 ${String(resolved.pinnedFromChapterSequence ?? input.sessionChapterSequence)} 章时的正文）`
        : "（当前定稿 head）"

      const evidenceItems = buildTemporalChapterEvidence({
        request,
        chapterSequence: asOfN,
        publishPath: resolved.publishPath,
        sourceId: resolved.sourceId,
        markdown: content,
        mode,
        maxChars,
        createId: input.createId,
        pinNote,
      })
      for (const item of evidenceItems) {
        const key = `${item.ownerId}:${item.digest}`
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(item)
      }
    }
  }

  return collected
}

function buildTemporalSettingsEvidence(input: Readonly<{
  request: ReadRequest
  relativePath: string
  markdown: string
  asOfN: number
  mode: NonNullable<ReadRequest["query"]["readMode"]>
  maxChars: number
  createId: () => string
}>): readonly TurnReadEvidence[] {
  const prefix = `# ${input.relativePath}（第 ${String(input.asOfN)} 章视角 · 非当前真相）`
  if (input.mode === "grep") {
    const keywords = [...input.request.query.exactKeys, ...input.request.query.semanticTexts, ...(input.request.query.entityHints ?? [])]
    const snippets = grepMarkdownContent({
      content: input.markdown,
      keywords,
      contextLines: input.request.query.grepContextLines ?? DEFAULT_GREP_CONTEXT_LINES,
      maxMatches: input.request.query.grepMaxMatchesPerFile ?? DEFAULT_GREP_MAX_MATCHES,
    })
    if (snippets.length === 0) {
      const emptyText = clampText(`${prefix}\nmatches: 0`, input.maxChars)
      return [makeTemporalEvidence({
        createId: input.createId,
        ownerKind: "settings-lineage:as_of:grep",
        ownerId: `${input.relativePath}#as-of-${String(input.asOfN)}#grep-empty`,
        exactKeys: [input.relativePath, `as-of:${String(input.asOfN)}`],
        semanticText: emptyText,
        asOfN: input.asOfN,
        digest: digest(emptyText),
      })]
    }
    return snippets.map((snippet) => {
      const body = [
        prefix,
        `L${String(snippet.lineStart)}-${String(snippet.lineEnd)}:`,
        snippet.text,
      ].join("\n")
      const semanticText = clampText(body, input.maxChars)
      return makeTemporalEvidence({
        createId: input.createId,
        ownerKind: "settings-lineage:as_of:grep",
        ownerId: `${input.relativePath}#as-of-${String(input.asOfN)}#L${String(snippet.lineStart)}`,
        exactKeys: [
          input.relativePath,
          `as-of:${String(input.asOfN)}`,
          `${input.relativePath}:L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
        ],
        semanticText,
        asOfN: input.asOfN,
        digest: digest(semanticText),
      })
    })
  }

  const sliced = sliceMarkdownLines(
    input.markdown,
    input.request.query.lineStart,
    input.request.query.lineEnd,
  )
  const body = `${prefix}\n\n${sliced.text}`
  const semanticText = clampText(body, input.maxChars)
  return [makeTemporalEvidence({
    createId: input.createId,
    ownerKind: "settings-lineage:as_of",
    ownerId: `${input.relativePath}#as-of-${String(input.asOfN)}`,
    exactKeys: [input.relativePath, `as-of:${String(input.asOfN)}`],
    semanticText,
    asOfN: input.asOfN,
    digest: digest(semanticText),
  })]
}

function buildTemporalChapterEvidence(input: Readonly<{
  request: ReadRequest
  chapterSequence: number
  publishPath: string
  sourceId: string
  markdown: string
  mode: NonNullable<ReadRequest["query"]["readMode"]>
  maxChars: number
  createId: () => string
  pinNote?: string
}>): readonly TurnReadEvidence[] {
  const prefix = `# 第 ${String(input.chapterSequence)} 章正文（定稿存档 · ${input.publishPath}${input.pinNote ?? ""}）`
  if (input.mode === "grep") {
    const keywords = [...input.request.query.exactKeys, ...input.request.query.semanticTexts]
    const snippets = grepMarkdownContent({
      content: input.markdown,
      keywords,
      contextLines: input.request.query.grepContextLines ?? DEFAULT_GREP_CONTEXT_LINES,
      maxMatches: input.request.query.grepMaxMatchesPerFile ?? DEFAULT_GREP_MAX_MATCHES,
    })
    if (snippets.length === 0) {
      const emptyText = clampText(`${prefix}\nmatches: 0`, input.maxChars)
      return [makeTemporalEvidence({
        createId: input.createId,
        ownerKind: "source:past_chapter:grep",
        ownerId: `chapter-seq-${String(input.chapterSequence)}#grep-empty`,
        exactKeys: [input.publishPath, `chapter:${String(input.chapterSequence)}`],
        semanticText: emptyText,
        asOfN: input.chapterSequence,
        digest: digest(emptyText),
        sourceRefs: [{ sourceKind: "source", sourceId: input.sourceId, chapterSequence: input.chapterSequence }],
      })]
    }
    return snippets.map((snippet) => {
      const body = [
        prefix,
        `L${String(snippet.lineStart)}-${String(snippet.lineEnd)}:`,
        snippet.text,
      ].join("\n")
      const semanticText = clampText(body, input.maxChars)
      return makeTemporalEvidence({
        createId: input.createId,
        ownerKind: "source:past_chapter:grep",
        ownerId: `chapter-seq-${String(input.chapterSequence)}#L${String(snippet.lineStart)}`,
        exactKeys: [
          input.publishPath,
          `chapter:${String(input.chapterSequence)}`,
          `L${String(snippet.lineStart)}-${String(snippet.lineEnd)}`,
        ],
        semanticText,
        asOfN: input.chapterSequence,
        digest: digest(semanticText),
        sourceRefs: [{ sourceKind: "source", sourceId: input.sourceId, chapterSequence: input.chapterSequence }],
      })
    })
  }

  const sliced = sliceMarkdownLines(
    input.markdown,
    input.request.query.lineStart,
    input.request.query.lineEnd,
  )
  const body = `${prefix}\n\n${sliced.text}`
  const semanticText = clampText(body, input.maxChars)
  return [makeTemporalEvidence({
    createId: input.createId,
    ownerKind: "source:past_chapter",
    ownerId: `chapter-seq-${String(input.chapterSequence)}`,
    exactKeys: [input.publishPath, `chapter:${String(input.chapterSequence)}`],
    semanticText,
    asOfN: input.chapterSequence,
    digest: digest(semanticText),
    sourceRefs: [{ sourceKind: "source", sourceId: input.sourceId, chapterSequence: input.chapterSequence }],
  })]
}

function makeTemporalEvidence(input: Readonly<{
  createId: () => string
  ownerKind: string
  ownerId: string
  exactKeys: readonly string[]
  semanticText: string
  asOfN: number
  digest: string
  sourceRefs?: readonly unknown[]
}>): TurnReadEvidence {
  return {
    readId: input.createId(),
    visibility: "committed",
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    exactKeys: [...input.exactKeys],
    semanticText: input.semanticText,
    sourceRefs: input.sourceRefs ?? [],
    digest: input.digest,
    stateRole: "historical",
    temporalRole: "as_of",
    asOfChapterSequence: input.asOfN,
  }
}

export function temporalSearchMeta(request: ReadRequest): Readonly<{
  asOfChapterSequence?: number
  temporalRole?: "as_of" | "current"
}> {
  const purpose = request.query.purpose ?? "current"
  if (purpose === "current") return {}
  return {
    ...(request.query.asOfChapterSequence === undefined
      ? {}
      : { asOfChapterSequence: request.query.asOfChapterSequence }),
    temporalRole: "as_of",
  }
}
