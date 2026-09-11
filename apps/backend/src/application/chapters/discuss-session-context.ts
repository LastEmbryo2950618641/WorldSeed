import type {
  ModelContextMessage,
  VisibleModelContextMessage,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import { digest, resolveDescriptionRulePaths, listWorkDescriptionRuleFiles } from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import { isPresentationRuleMarkdownPath, listUserRuleMarkdownPaths } from "./synopsis-workspace-reads.js"

export function listSynopsisDiscussBootstrapPaths(input: Readonly<{
  catalog: WorkspaceCatalogSnapshot
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
  }>
}>): readonly string[] {
  const descriptionPaths = resolveDescriptionRulePaths(
    input.presentation?.descriptionRulePath,
    input.catalog.entries,
  )
  const prosePath = input.presentation?.proseStyleRulePath?.trim()
  return [
    "设定集/readme.md",
    "参考文件/readme.md",
    ...descriptionPaths,
    ...(prosePath !== undefined && prosePath.length > 0 && isPresentationRuleMarkdownPath(prosePath)
      ? [prosePath]
      : []),
    ...listWorkDescriptionRuleFiles(input.catalog.entries).map((entry) => entry.relativePath),
    ...listUserRuleMarkdownPaths(input.catalog.entries),
  ]
}

export function computeDiscussBootstrapDigest(input: Readonly<{
  catalog: WorkspaceCatalogSnapshot
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
  }>
}>): string {
  const paths = listSynopsisDiscussBootstrapPaths(input)
  const byPath = new Map(input.catalog.entries.map((entry) => [entry.relativePath, entry]))
  return digest(paths.map((path) => {
    const entry = byPath.get(path)
    return {
      path,
      digest: entry?.digest ?? "",
      version: entry?.version ?? "",
    }
  }))
}

export function collectDiscussReadEvidenceFromContext(
  messages: readonly ModelContextMessage[],
): TurnReadEvidence[] {
  const collected: TurnReadEvidence[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.content === undefined) continue
    const parsed = parseJsonObject(message.content)
    if (parsed === undefined) continue
    for (const item of collectReadEvidenceNodes(parsed)) {
      const readId = typeof item.readId === "string" ? item.readId : undefined
      if (readId === undefined || seen.has(readId)) continue
      seen.add(readId)
      collected.push(item as TurnReadEvidence)
    }
  }
  return collected
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function collectReadEvidenceNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectReadEvidenceNodes)
  if (value === null || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const nested = Object.values(record).flatMap(collectReadEvidenceNodes)
  if (!Array.isArray(record.readEvidence)) return nested
  return [
    ...record.readEvidence.flatMap((item) => (
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? [item as Record<string, unknown>]
        : []
    )),
    ...nested,
  ]
}

export function toVisibleDiscussContextMessages(
  messages: readonly ModelContextMessage[],
): VisibleModelContextMessage[] {
  return messages.flatMap((message) => {
    if (message.content === undefined) return []
    return [{
      messageId: message.messageId,
      sequence: message.sequence,
      role: message.role,
      kind: message.kind,
      ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      ...(message.phase === undefined ? {} : { phase: message.phase }),
      content: message.content,
    }]
  })
}
