/** UI-side lock classification — keep aligned with backend workspace-policy. */

import {
  isChapterPlanningMarkdownPath,
  isSynopsisMarkdownPath,
} from "../editor/synopsis-path.js"

export { isSynopsisMarkdownPath }

const BASE_RULES_PREFIX = "世界推演规则/基础规则"

/** Fixed scaffold files: content editable, path not deletable. */
const IMMUTABLE_FILE_PATHS = new Set([
  "设定集/readme.md",
  "参考文件/readme.md",
  "暂存区/readme.md",
  "暂存区/本章讨论笔记.md",
  "暂存区/人物草稿.md",
  "暂存区/世界与规则草稿.md",
  "暂存区/待落盘清单.md",
  "世界推演规则/基础规则/base-rules.md",
  "世界推演规则/基础规则/plot-synopsis-guide.md",
  "世界推演规则/基础规则/settings-query-guide.md",
  "世界推演规则/基础规则/settings-revision-guide.md",
])

const IMMUTABLE_DIRECTORY_PATHS = new Set([
  "世界推演规则",
  "世界推演规则/基础规则",
  "世界推演规则/用户规则",
  "设定集",
  "参考文件",
  "章节正文",
  "表现输出",
  "表现输出/描写规则",
  "表现输出/笔风规则",
  "暂存区",
])

export type WorkspaceLockKind = "platform_readonly" | "immutable_scaffold" | "chapter_workflow"

export function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "")
}

export function isPlatformLockedPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalized === BASE_RULES_PREFIX || normalized.startsWith(`${BASE_RULES_PREFIX}/`)
}

const VOLUME_FOLDER_PATTERN = /^第(?:\d+|[零一二三四五六七八九十百]+)卷\s+\S.*$/u
const VOLUME_LABEL_PREFIX = /^第(?:\d+|[零一二三四五六七八九十百]+)卷(?:\s|$)/u

export function isVolumeDirectoryPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (!normalized.startsWith("章节正文/")) return false
  const rest = normalized.slice("章节正文/".length)
  if (rest.includes("/")) return false
  return VOLUME_FOLDER_PATTERN.test(rest)
}

/** Immediate child of「章节正文/」— unlock + allow delete (even if name is invalid). */
export function isChapterVolumeContainerPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (!normalized.startsWith("章节正文/")) return false
  const rest = normalized.slice("章节正文/".length)
  return rest.length > 0 && !rest.includes("/")
}

export function parseVolumeSequenceFromLabel(label: string): number | undefined {
  const trimmed = label.trim()
  const match = trimmed.match(/^第(\d+)卷/u) ?? trimmed.match(/^第([零一二三四五六七八九十百]+)卷/u)
  if (match === null) return undefined
  const token = match[1]
  if (token === undefined) return undefined
  if (/^\d+$/u.test(token)) return Number(token)
  return parseChineseVolumeNumeral(token)
}

function parseChineseVolumeNumeral(value: string): number | undefined {
  if (value.length === 0) return undefined
  const digits: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (value === "十") return 10
  if (value.startsWith("十")) {
    const rest = value.slice(1)
    if (rest.length === 0) return 10
    return digits[rest] === undefined ? undefined : 10 + digits[rest]
  }
  if (value.endsWith("十") && value.length === 2) {
    const tens = digits[value[0] ?? ""]
    return tens === undefined ? undefined : tens * 10
  }
  if (value.includes("十")) {
    const parts = value.split("十")
    const tensPart = parts[0] ?? ""
    const onesPart = parts[1] ?? ""
    const tens = tensPart.length === 0 ? 1 : digits[tensPart]
    if (tens === undefined) return undefined
    if (onesPart.length === 0) return tens * 10
    const ones = digits[onesPart]
    return ones === undefined ? undefined : tens * 10 + ones
  }
  return digits[value]
}

export function resolveWorkspaceLockKind(path: string): WorkspaceLockKind | undefined {
  const normalized = normalizeWorkspacePath(path)
  if (isPlatformLockedPath(normalized)) return "platform_readonly"
  if (isChapterVolumeContainerPath(normalized)) return undefined
  if (normalized === "章节正文" || (normalized.startsWith("章节正文/") && !isChapterPlanningMarkdownPath(normalized))) {
    return "chapter_workflow"
  }
  if (IMMUTABLE_FILE_PATHS.has(normalized) || IMMUTABLE_DIRECTORY_PATHS.has(normalized)) {
    return "immutable_scaffold"
  }
  return undefined
}

export function lockTooltip(kind: WorkspaceLockKind): string {
  switch (kind) {
    case "platform_readonly":
      return "平台只读"
    case "immutable_scaffold":
      return "固定文件，可编辑内容但不可删除"
    case "chapter_workflow":
      return "正式章节请走修订流程"
  }
}

/** Preferred destinations for new user markdown (most specific first). */
export const USER_WRITABLE_CREATE_ROOTS = [
  "设定集",
  "世界推演规则/用户规则",
  "参考文件",
  "表现输出/描写规则",
  "表现输出/笔风规则",
  "暂存区",
] as const

/** Roots that allow nested user folders (aligned with project-manifest allowUserFolders). */
export const USER_FOLDER_CREATE_ROOTS = [
  "设定集",
  "世界推演规则/用户规则",
  "参考文件",
  "表现输出/描写规则",
  "表现输出/笔风规则",
  "章节正文",
] as const

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

export function canCreateMarkdownInDirectory(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (isPlatformLockedPath(normalized)) return false
  if (normalized === "章节正文" || normalized.startsWith("章节正文/")) return false
  return USER_WRITABLE_CREATE_ROOTS.some((root) => isUnderRoot(normalized, root))
}

export function canCreateFolderInDirectory(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (isPlatformLockedPath(normalized)) return false
  // Volume folders are created directly under 章节正文 with「第N卷 标题」names.
  if (normalized === "章节正文") return true
  return USER_FOLDER_CREATE_ROOTS.some((root) => isUnderRoot(normalized, root) && root !== "章节正文")
}

/** True when the folder name itself is a valid volume label (UI create dialog). */
export function isValidVolumeFolderName(name: string): boolean {
  return VOLUME_FOLDER_PATTERN.test(name.trim()) && VOLUME_LABEL_PREFIX.test(name.trim())
}

/**
 * Reject creating a volume whose sequence already exists (e.g. two「第一卷 …」).
 * `excludeFolderName` allows renaming the same folder’s title.
 */
export function findDuplicateVolumeSequence(
  folderName: string,
  existingVolumeFolderNames: readonly string[],
  options?: Readonly<{ excludeFolderName?: string }>,
): string | undefined {
  const sequence = parseVolumeSequenceFromLabel(folderName)
  if (sequence === undefined) return undefined
  const exclude = options?.excludeFolderName?.trim()
  for (const existing of existingVolumeFolderNames) {
    if (exclude !== undefined && existing === exclude) continue
    if (existing === folderName.trim()) continue
    if (parseVolumeSequenceFromLabel(existing) === sequence) return existing
  }
  return undefined
}

export function resolveCreateDestination(selectedPath: string | undefined): string {
  if (selectedPath === undefined || selectedPath.trim().length === 0) return "设定集"
  const normalized = normalizeWorkspacePath(selectedPath)
  if (isPlatformLockedPath(normalized) || normalized === "章节正文" || normalized.startsWith("章节正文/")) {
    return "设定集"
  }
  const directory = normalized.endsWith(".md")
    ? (normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "")
    : normalized
  if (directory.length > 0 && canCreateMarkdownInDirectory(directory)) return directory
  for (const root of USER_WRITABLE_CREATE_ROOTS) {
    if (directory === root || directory.startsWith(`${root}/`)) return directory
  }
  return "设定集"
}

export function canDeleteWorkspacePath(
  path: string,
  options?: Readonly<{ hasChapterBodies?: boolean }>,
): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (isChapterVolumeContainerPath(normalized)) {
    return options?.hasChapterBodies !== true
  }
  return resolveWorkspaceLockKind(normalized) === undefined && normalized.endsWith(".md")
}
