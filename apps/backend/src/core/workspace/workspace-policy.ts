import { isSynopsisMarkdownPath } from "../chapters/synopsis-path.js"
import { fixedTopLevelDirectories, fixedWorkspaceEntries } from "./project-manifest.js"

export type WorkspaceInventoryEntry = Readonly<{
  path: string
  kind: "directory" | "file"
}>

export type WorkspaceValidationIssue = Readonly<{
  code: "invalid_path" | "missing_fixed_entry" | "unexpected_root_entry" | "invalid_file_type" | "kind_mismatch"
  path: string
  message: string
}>

export type WorkspaceMutationActor = "user" | "platform" | "chapter_publisher"

export class WorkspacePolicyError extends Error {}

export function normalizeWorkspacePath(path: string): string {
  if (path.includes("\0")) {
    throw new WorkspacePolicyError("Workspace path contains a null byte")
  }

  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "")
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new WorkspacePolicyError("Workspace path must be relative")
  }

  const segments = normalized.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WorkspacePolicyError("Workspace path cannot contain empty, current, or parent segments")
  }

  return segments.join("/")
}

function findWritableRoot(path: string) {
  return fixedWorkspaceEntries
    .filter((entry) => entry.entryKind === "directory" && (path === entry.relativePath || path.startsWith(`${entry.relativePath}/`)))
    .sort((left, right) => right.relativePath.length - left.relativePath.length)[0]
}

export function assertWorkspaceMutationAllowed(
  path: string,
  kind: "directory" | "file",
  actor: WorkspaceMutationActor,
): string {
  const normalized = normalizeWorkspacePath(path)
  const fixedEntry = fixedWorkspaceEntries.find((entry) => entry.relativePath === normalized)

  if (fixedEntry !== undefined && fixedEntry.immutablePath && actor === "user" && !fixedEntry.allowUserMarkdown) {
    throw new WorkspacePolicyError(`Fixed workspace entry cannot be changed: ${normalized}`)
  }

  if (normalized === "章节正文" || normalized.startsWith("章节正文/")) {
    const synopsisWritable = isSynopsisMarkdownPath(normalized) && (actor === "user" || actor === "platform")
    if (!synopsisWritable && actor !== "chapter_publisher") {
      throw new WorkspacePolicyError("Committed chapters can only be changed through the chapter workflow")
    }
  }

  if (normalized === "世界推演规则/基础规则" || normalized.startsWith("世界推演规则/基础规则/")) {
    if (actor !== "platform") {
      throw new WorkspacePolicyError("Base rules are read-only platform projections")
    }
  }

  const root = findWritableRoot(normalized)
  if (root === undefined) {
    throw new WorkspacePolicyError(`Path is outside the fixed workspace roots: ${normalized}`)
  }

  if (kind === "file" && !normalized.endsWith(".md")) {
    throw new WorkspacePolicyError("Only .md files are allowed in the workspace")
  }

  if (actor === "user") {
    if (kind === "directory" && !root.allowUserFolders) {
      throw new WorkspacePolicyError(`User folders are not allowed under ${root.relativePath}`)
    }

    if (kind === "file" && !root.allowUserMarkdown && !isSynopsisMarkdownPath(normalized)) {
      throw new WorkspacePolicyError(`User Markdown is not allowed under ${root.relativePath}`)
    }
  }

  return normalized
}

export function validateWorkspaceInventory(entries: readonly WorkspaceInventoryEntry[]): readonly WorkspaceValidationIssue[] {
  const issues: WorkspaceValidationIssue[] = []
  const normalizedEntries = new Map<string, WorkspaceInventoryEntry>()

  for (const entry of entries) {
    try {
      const path = normalizeWorkspacePath(entry.path)
      normalizedEntries.set(path, { ...entry, path })

      const topLevel = path.split("/")[0]
      if (topLevel === undefined || !fixedTopLevelDirectories.includes(topLevel as typeof fixedTopLevelDirectories[number])) {
        issues.push({
          code: "unexpected_root_entry",
          path,
          message: "Only the five fixed top-level directories are allowed",
        })
      }

      if (entry.kind === "file" && !path.endsWith(".md")) {
        issues.push({ code: "invalid_file_type", path, message: "Only .md files are allowed" })
      }
    } catch (error) {
      issues.push({
        code: "invalid_path",
        path: entry.path,
        message: error instanceof Error ? error.message : "Invalid workspace path",
      })
    }
  }

  for (const fixedEntry of fixedWorkspaceEntries) {
    const actual = normalizedEntries.get(fixedEntry.relativePath)
    if (actual === undefined) {
      issues.push({
        code: "missing_fixed_entry",
        path: fixedEntry.relativePath,
        message: "Required fixed workspace entry is missing",
      })
    } else if (actual.kind !== fixedEntry.entryKind) {
      issues.push({
        code: "kind_mismatch",
        path: fixedEntry.relativePath,
        message: `Expected ${fixedEntry.entryKind}, received ${actual.kind}`,
      })
    }
  }

  return Object.freeze(issues)
}
