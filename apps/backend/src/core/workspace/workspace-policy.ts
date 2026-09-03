import {
  isChapterPlanningMarkdownPath,
  isOutlineMarkdownPath,
  isSynopsisMarkdownPath,
  validateOutlineMarkdownPath,
  validateSynopsisMarkdownPath,
} from "../chapters/synopsis-path.js"
import {
  assertUniqueVolumeSequence,
  formatVolumeSequenceLabel,
  isChapterVolumeContainerPath,
  isLooseChapterRootMarkdownPath,
  isVolumeDirectoryPath,
  listVolumeFoldersFromInventory,
  validateChapterFileUnderVolume,
  validateVolumeFolderName,
} from "../chapters/chapter-volume.js"
import { fixedTopLevelDirectories, fixedWorkspaceEntries } from "./project-manifest.js"

export type WorkspaceInventoryEntry = Readonly<{
  path: string
  kind: "directory" | "file"
}>

export type WorkspaceValidationIssue = Readonly<{
  code:
    | "invalid_path"
    | "missing_fixed_entry"
    | "unexpected_root_entry"
    | "invalid_file_type"
    | "kind_mismatch"
    | "invalid_synopsis_name"
    | "chapter_missing_volume"
    | "invalid_volume_name"
    | "duplicate_volume_sequence"
  path: string
  message: string
}>

export type WorkspaceMutationActor = "user" | "platform" | "chapter_publisher"

export type WorkspaceLockKind = "platform_readonly" | "immutable_scaffold" | "chapter_workflow"

export class WorkspacePolicyError extends Error {}

const BASE_RULES_PREFIX = "世界推演规则/基础规则"

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

/** Platform-projected base rules: never user-editable. */
export function isPlatformLockedPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalized === BASE_RULES_PREFIX || normalized.startsWith(`${BASE_RULES_PREFIX}/`)
}

/** Fixed manifest entry whose path must not be deleted or renamed by the user. */
export function isPathImmutable(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  const fixed = fixedWorkspaceEntries.find((entry) => entry.relativePath === normalized)
  return fixed?.immutablePath === true
}

export function resolveWorkspaceLockKind(path: string): WorkspaceLockKind | undefined {
  const normalized = normalizeWorkspacePath(path)
  if (isPlatformLockedPath(normalized)) return "platform_readonly"
  // Volume containers themselves are not chapter-body locks (user may delete when no bodies).
  if (isChapterVolumeContainerPath(normalized)) return undefined
  if (normalized === "章节正文" || (normalized.startsWith("章节正文/") && !isChapterPlanningMarkdownPath(normalized))) {
    return "chapter_workflow"
  }
  if (isPathImmutable(normalized)) return "immutable_scaffold"
  return undefined
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
    throw new WorkspacePolicyError(`固定工作区条目不可修改：${normalized}`)
  }

  if (normalized === "章节正文" || normalized.startsWith("章节正文/")) {
    if (kind === "directory") {
      if (normalized === "章节正文") {
        throw new WorkspacePolicyError("不能覆盖固定目录「章节正文」")
      }
      if (!isVolumeDirectoryPath(normalized)) {
        const folderName = normalized.slice("章节正文/".length)
        const validated = validateVolumeFolderName(folderName)
        throw new WorkspacePolicyError(
          validated.ok
            ? `卷文件夹只能直接位于「章节正文/」下：${normalized}`
            : validated.reason,
        )
      }
      return normalized
    }

    if (isChapterPlanningMarkdownPath(normalized) && (actor === "user" || actor === "platform")) {
      const validation = isOutlineMarkdownPath(normalized)
        ? validateOutlineMarkdownPath(normalized)
        : validateSynopsisMarkdownPath(normalized)
      if (!validation.ok) {
        throw new WorkspacePolicyError(validation.reason)
      }
    } else if (actor === "chapter_publisher") {
      const underVolume = validateChapterFileUnderVolume(normalized)
      if (!underVolume.ok) {
        throw new WorkspacePolicyError(underVolume.reason)
      }
    } else {
      throw new WorkspacePolicyError("正式章节正文只能通过章节修订流程修改")
    }
  }

  if (isPlatformLockedPath(normalized) && actor !== "platform") {
    throw new WorkspacePolicyError("基础规则为平台只读投影，不能编辑、新建或删除")
  }

  const root = findWritableRoot(normalized)
  if (root === undefined) {
    throw new WorkspacePolicyError(`路径不在固定工作区根目录下：${normalized}`)
  }

  if (kind === "file" && !normalized.endsWith(".md")) {
    throw new WorkspacePolicyError("工作区只允许 .md 文件")
  }

  if (actor === "user") {
    const creatingVolume = kind === "directory" && isVolumeDirectoryPath(normalized)
    if (kind === "directory" && !root.allowUserFolders && !creatingVolume) {
      throw new WorkspacePolicyError(`不允许在「${root.relativePath}」下新建子文件夹`)
    }

    if (kind === "file" && !root.allowUserMarkdown && !isChapterPlanningMarkdownPath(normalized)) {
      throw new WorkspacePolicyError(`不允许在「${root.relativePath}」下新建或写入 Markdown`)
    }
  }

  return normalized
}

/** User may edit file contents (save). */
export function assertUserCanEditContent(path: string): string {
  return assertWorkspaceMutationAllowed(path, "file", "user")
}

/** User may create a new markdown file at this path. */
export function assertUserCanCreateMarkdown(path: string): string {
  const normalized = normalizeWorkspacePath(path)
  if (isPathImmutable(normalized)) {
    throw new WorkspacePolicyError(`不能覆盖固定脚手架文件：${normalized}`)
  }
  return assertWorkspaceMutationAllowed(normalized, "file", "user")
}

/** User may create a new directory at this path (not a fixed scaffold directory). */
export function assertUserCanCreateDirectory(path: string): string {
  const normalized = normalizeWorkspacePath(path)
  if (isPathImmutable(normalized)) {
    throw new WorkspacePolicyError(`不能创建或覆盖固定脚手架目录：${normalized}`)
  }
  if (isPlatformLockedPath(normalized)) {
    throw new WorkspacePolicyError("基础规则为平台只读投影，不能新建文件夹")
  }
  return assertWorkspaceMutationAllowed(normalized, "directory", "user")
}

/**
 * User may delete a markdown file. Immutable scaffold paths and platform locks are refused.
 * Canonical synopsis files are allowed; chapter bodies are not.
 */
export function assertUserCanDeleteMarkdown(path: string): string {
  const normalized = normalizeWorkspacePath(path)
  if (isPlatformLockedPath(normalized)) {
    throw new WorkspacePolicyError("基础规则为平台只读投影，不能删除")
  }
  if (isPathImmutable(normalized)) {
    throw new WorkspacePolicyError(`固定脚手架文件不可删除：${normalized}`)
  }
  if (normalized === "章节正文" || normalized.startsWith("章节正文/")) {
    if (isChapterPlanningMarkdownPath(normalized)) {
      const validation = isOutlineMarkdownPath(normalized)
        ? validateOutlineMarkdownPath(normalized)
        : validateSynopsisMarkdownPath(normalized)
      if (!validation.ok) {
        throw new WorkspacePolicyError(validation.reason)
      }
      return normalized
    }
    throw new WorkspacePolicyError("正式章节正文不能从工作区树直接删除")
  }
  return assertWorkspaceMutationAllowed(normalized, "file", "user")
}

/**
 * User may delete a volume directory under「章节正文/」when it has no formal chapter bodies.
 * Callers remove planning markdown first, then the directory.
 */
export function assertUserCanDeleteVolumeDirectory(path: string): string {
  const normalized = normalizeWorkspacePath(path)
  if (!isChapterVolumeContainerPath(normalized)) {
    throw new WorkspacePolicyError("只能删除「章节正文/」下的卷文件夹")
  }
  return normalized
}

/** @deprecated Prefer assertUserCanDeleteVolumeDirectory */
export function assertUserCanDeleteEmptyVolumeDirectory(path: string): string {
  return assertUserCanDeleteVolumeDirectory(path)
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
          message: "Only the six fixed top-level directories are allowed",
        })
      }

      if (entry.kind === "file" && !path.endsWith(".md")) {
        issues.push({ code: "invalid_file_type", path, message: "Only .md files are allowed" })
      }

      if (entry.kind === "directory" && path.startsWith("章节正文/") && path !== "章节正文") {
        if (!isVolumeDirectoryPath(path)) {
          issues.push({
            code: "invalid_volume_name",
            path,
            message: "卷文件夹必须命名为「第N卷 标题」（例如「第一卷 潮水退去时」）",
          })
        }
      }

      if (entry.kind === "file" && isLooseChapterRootMarkdownPath(path)) {
        issues.push({
          code: "chapter_missing_volume",
          path,
          message: "章节/梗概不能直接放在「章节正文/」根下，必须归入卷文件夹（例如「第一卷 潮水退去时/」）",
        })
      }

      if (entry.kind === "file" && isSynopsisMarkdownPath(path)) {
        const validation = validateSynopsisMarkdownPath(path)
        if (!validation.ok) {
          issues.push({
            code: "invalid_synopsis_name",
            path,
            message: validation.reason,
          })
        }
      }
      if (entry.kind === "file" && isOutlineMarkdownPath(path)) {
        const validation = validateOutlineMarkdownPath(path)
        if (!validation.ok) {
          issues.push({
            code: "invalid_synopsis_name",
            path,
            message: validation.reason,
          })
        }
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

  const volumes = listVolumeFoldersFromInventory([...normalizedEntries.values()])
  const seenSequences = new Map<number, string>()
  for (const volume of volumes) {
    const prior = seenSequences.get(volume.sequence)
    if (prior !== undefined) {
      issues.push({
        code: "duplicate_volume_sequence",
        path: volume.path,
        message: `${formatVolumeSequenceLabel(volume.sequence)}重复：已存在「${prior}」，又出现「${volume.folderName}」。同一序号只能有一个卷文件夹。`,
      })
      continue
    }
    seenSequences.set(volume.sequence, volume.folderName)
  }

  return Object.freeze(issues)
}

/** Reject creating a volume folder whose sequence already exists under「章节正文/」. */
export function assertVolumeSequenceAvailable(
  folderName: string,
  existingVolumeFolderNames: readonly string[],
  options?: Readonly<{ excludeFolderName?: string }>,
): string {
  const uniqueness = assertUniqueVolumeSequence(folderName, existingVolumeFolderNames, options)
  if (!uniqueness.ok) {
    throw new WorkspacePolicyError(uniqueness.reason)
  }
  const validated = validateVolumeFolderName(folderName)
  if (!validated.ok) {
    throw new WorkspacePolicyError(validated.reason)
  }
  return validated.folderName
}
