/** This-work presentation overlay: all files inject every turn; AI may write here. */

export const WORK_DESCRIPTION_RULES_DIR = "表现输出/本作品描写"
export const DESCRIPTION_RULES_DIR = "表现输出/描写规则"
export const PROSE_STYLE_RULES_DIR = "表现输出/笔风规则"
export const AUTO_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/自动.md`
export const DEFAULT_PROSE_STYLE_RULE_PATH = `${PROSE_STYLE_RULES_DIR}/默认笔风规则.md`
export const WORK_DESCRIPTION_MAX_FILES = 8
export const WORK_DESCRIPTION_MAX_CHARS = 4000

const WORK_DESCRIPTION_FILE_PATTERN = /^表现输出\/本作品描写\/[^/]+\.md$/u
const DESCRIPTION_RULE_FILE_PATTERN = /^表现输出\/描写规则\/[^/]+\.md$/u
const USER_PRESET_PRESENTATION_FILE_PATTERN = /^表现输出\/(?:描写规则|笔风规则)\/[^/]+\.md$/u

/** Platform seed for dropdown「自动」: conductor for switching sibling description presets. */
export const AUTO_DESCRIPTION_RULE_MARKDOWN = [
  "# 自动",
  "",
  "> 职责：同一章内按场面切换描写规则。不管用语和题材腔。",
  "",
  "## 本轮身份",
  "",
  "创作台选「自动」时，同目录其他描写 `.md` 会一并注入，作为场面卡。",
  "本文件只负责**何时切换**；切过去之后，按匹配到的那张场面卡执行切镜、密度、铺开顺序。",
  "",
  "## 硬约束",
  "",
  "- 同一章**可以**出现多种描写场面，必须随情节功能切换，禁止整章锁死在一张卡上。",
  "- 用户若在下拉中锁定某一文件，则以该文件为准，本文件不生效。",
  "- 按文件名/标题匹配当前场面；没有对应卡时，用下方「缺卡时的默认判断」。",
  "- 禁止把「镜头推进 / 切到 / 特写」写进正文。不改世界事实与人物未知信息。",
  "",
  "## 何时切到哪张卡",
  "",
  "匹配文件名或标题中的关键词（不必字面相同）：",
  "",
  "- 冲突、对质、认人、近身交锋 → 对峙 / 升密：锁中近景，升密到招式、距离、当场证据。",
  "- 赶路、转场、办事、交代时间流逝 → 过场 / 白描：降密，一两笔事实立刻办事。",
  "- 跟随当前行动主体的手、呼吸、眼前一米 → 近景 / 跟随：锁其能看见、听见、碰到或误读的范围。",
  "- 多人同场、话轮来回 → 群像：每人一个辨识点，不要点名开会。",
  "- 本场第一次看见关键人物或地点 → 首次 / 铺陈：只铺开一次，再出场只写变化。",
  "- 必须停在某人注意力里 → 限知 / 主观：不写他看不见的，误判可以写、作者不纠正。",
  "- 换地、开战、入城、行军 → 远近 / 调度：先定场再落到可跟随的人或物。",
  "",
  "场面功能一变就换卡。转场切口用动作完成、话轮交接、观察者转身、换地；用声、光、气味或同一物件衔接。",
  "",
  "## 缺卡时的默认判断",
  "",
  "切镜 / 锁景 ＞ 密度 ＞ 铺开顺序。首次见关键对象可铺开；对峙升密；赶路降密；群像每人一点。近景只写最后有用的一槽。",
].join("\n")

export function normalizeWorkspaceRelativePath(path: string): string {
  return path.trim().replace(/\\/gu, "/")
}

/** Direct-child Markdown under `表现输出/本作品描写/`. */
export function isWorkDescriptionRulePath(path: string): boolean {
  return WORK_DESCRIPTION_FILE_PATTERN.test(normalizeWorkspaceRelativePath(path))
}

export function isDescriptionRuleMarkdownPath(path: string): boolean {
  return DESCRIPTION_RULE_FILE_PATTERN.test(normalizeWorkspaceRelativePath(path))
}

/** User-owned dropdown presets; AI must not write these. */
export function isUserPresetPresentationRulePath(path: string): boolean {
  return USER_PRESET_PRESENTATION_FILE_PATTERN.test(normalizeWorkspaceRelativePath(path))
}

/** Empty dropdown or the platform `自动.md` path. */
export function isAutoDescriptionSelection(path: string | undefined): boolean {
  const normalized = path?.trim()
  return normalized === undefined
    || normalized.length === 0
    || normalizeWorkspaceRelativePath(normalized) === AUTO_DESCRIPTION_RULE_PATH
}

export function listDescriptionRuleFiles<T extends { relativePath: string; entryKind: string }>(
  entries: readonly T[],
): T[] {
  return entries
    .filter((entry) => entry.entryKind === "file" && isDescriptionRuleMarkdownPath(entry.relativePath))
    .slice()
    .sort((left, right) => {
      const leftPath = normalizeWorkspaceRelativePath(left.relativePath)
      const rightPath = normalizeWorkspaceRelativePath(right.relativePath)
      if (leftPath === AUTO_DESCRIPTION_RULE_PATH) return -1
      if (rightPath === AUTO_DESCRIPTION_RULE_PATH) return 1
      return leftPath.localeCompare(rightPath, "zh-CN")
    })
}

/** Auto: every 描写规则 file. Locked: only the selected file. */
export function resolveDescriptionRulePaths(
  descriptionRulePath: string | undefined,
  catalogEntries: readonly { relativePath: string; entryKind: string }[],
): string[] {
  if (!isAutoDescriptionSelection(descriptionRulePath)) {
    const selected = normalizeWorkspaceRelativePath(descriptionRulePath ?? "")
    if (!isDescriptionRuleMarkdownPath(selected)) {
      throw new Error(`Description rule must be inside ${DESCRIPTION_RULES_DIR}: ${descriptionRulePath ?? ""}`)
    }
    return [selected]
  }
  const all = listDescriptionRuleFiles(catalogEntries).map((entry) => (
    normalizeWorkspaceRelativePath(entry.relativePath)
  ))
  if (all.length === 0) {
    throw new Error(`Selected presentation rule is missing: ${AUTO_DESCRIPTION_RULE_PATH}`)
  }
  return all
}

export function formatDescriptionRuleEvidence(
  relativePath: string,
  content: string,
  autoMode: boolean,
): string {
  const path = normalizeWorkspaceRelativePath(relativePath)
  if (autoMode) {
    if (path === AUTO_DESCRIPTION_RULE_PATH) {
      return [
        "【描写·自动调度】",
        "同一章可以切换多种描写场面。按本文件决定何时启用其他描写文件。",
        "",
        content,
      ].join("\n")
    }
    return [
      "【描写场面卡】",
      `文件：${path}`,
      "仅当自动调度判定当前场面匹配本文件时生效；不要整章锁死在本文件。",
      "",
      content,
    ].join("\n")
  }
  return [
    "【描写·本轮锁定】",
    "整章必须遵守本文件，不得改用同目录其他描写规则。",
    "",
    content,
  ].join("\n")
}

export function assertWorkDescriptionCharLimit(relativePath: string, content: string): void {
  if (content.length > WORK_DESCRIPTION_MAX_CHARS) {
    throw new Error(
      `本作品描写「${relativePath}」超过 ${String(WORK_DESCRIPTION_MAX_CHARS)} 字（当前 ${String(content.length)} 字）。请拆分或删减后重试。`,
    )
  }
}

export function listWorkDescriptionRuleFiles<T extends { relativePath: string; entryKind: string }>(
  entries: readonly T[],
): T[] {
  const prefix = `${WORK_DESCRIPTION_RULES_DIR}/`
  const unexpected = entries.filter((entry) => (
    entry.relativePath.startsWith(prefix)
    && !(entry.entryKind === "file" && isWorkDescriptionRulePath(entry.relativePath))
  ))
  const firstUnexpected = unexpected[0]
  if (firstUnexpected !== undefined) {
    throw new Error(
      `本作品描写只允许直接放 .md 文件，不能有子文件夹或非 Markdown。发现：${firstUnexpected.relativePath}`,
    )
  }
  const files = entries
    .filter((entry) => entry.entryKind === "file" && isWorkDescriptionRulePath(entry.relativePath))
    .slice()
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"))
  if (files.length > WORK_DESCRIPTION_MAX_FILES) {
    throw new Error(
      `本作品描写最多 ${String(WORK_DESCRIPTION_MAX_FILES)} 个文件，当前 ${String(files.length)} 个。请合并或删除后再推演。`,
    )
  }
  return files
}

export function formatWorkDescriptionRuleEvidence(relativePath: string, content: string): string {
  assertWorkDescriptionCharLimit(relativePath, content)
  return [
    "【本作品描写·附加层】",
    "以下约束适用于整部作品的持续呈现，不能改写本轮选中的描写规则或笔风规则。",
    "与选中描写/笔风冲突时，以选中文件为准。",
    "单章一次性氛围（雨夜、慢切等）写在梗概/细纲，不写在本文件。",
    "",
    content,
  ].join("\n")
}

export function assertWorkDescriptionWriteBatch(input: Readonly<{
  existingPaths: readonly string[]
  writes: readonly Readonly<{ relativePath: string; markdown: string }>[]
}>): void {
  const resulting = new Set(
    input.existingPaths
      .map((path) => normalizeWorkspaceRelativePath(path))
      .filter((path) => isWorkDescriptionRulePath(path)),
  )
  for (const write of input.writes) {
    const path = normalizeWorkspaceRelativePath(write.relativePath)
    if (!isWorkDescriptionRulePath(path)) {
      throw new Error(`表现规则写入路径非法（仅允许 ${WORK_DESCRIPTION_RULES_DIR}/*.md）：${write.relativePath}`)
    }
    assertWorkDescriptionCharLimit(path, write.markdown)
    resulting.add(path)
  }
  if (resulting.size > WORK_DESCRIPTION_MAX_FILES) {
    throw new Error(
      `本作品描写最多 ${String(WORK_DESCRIPTION_MAX_FILES)} 个文件，写入后将达到 ${String(resulting.size)} 个。请合并或删除后再保存。`,
    )
  }
}
