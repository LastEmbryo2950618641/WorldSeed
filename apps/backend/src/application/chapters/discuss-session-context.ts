import type {
  ModelContextMessage,
  VisibleModelContextMessage,
  WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import { digest, isAutoDescriptionSelection, listDescriptionRuleFiles, listWorkDescriptionRuleFiles } from "../../core/index.js"
import { isPresentationRuleMarkdownPath, listUserRuleMarkdownPaths } from "./synopsis-workspace-reads.js"

export function listSynopsisDiscussBootstrapPaths(input: Readonly<{
  catalog: WorkspaceCatalogSnapshot
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
  }>
}>): readonly string[] {
  const autoDescription = isAutoDescriptionSelection(input.presentation?.descriptionRulePath)
  const descriptionPaths = autoDescription
    ? listDescriptionRuleFiles(input.catalog.entries).map((entry) => entry.relativePath)
    : [input.presentation?.descriptionRulePath?.trim() ?? ""]
      .filter((path): path is string => path.length > 0 && isPresentationRuleMarkdownPath(path))
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
