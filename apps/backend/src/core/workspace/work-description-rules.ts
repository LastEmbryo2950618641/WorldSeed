/** This-work presentation overlay: all files inject every turn; AI may write here. */

export const WORK_DESCRIPTION_RULES_DIR = "表现输出/本作品描写"
export const DESCRIPTION_RULES_DIR = "表现输出/描写规则"
export const PROSE_STYLE_RULES_DIR = "表现输出/笔风规则"
export function isSharedPresentationPath(path: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(path)
  return [DESCRIPTION_RULES_DIR, PROSE_STYLE_RULES_DIR]
    .some((directory) => normalized === directory || normalized.startsWith(`${directory}/`))
}
export const AUTO_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/自动.md`
export const SENSORY_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/感官描写.md`
export const DEAI_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/去AI味.md`
export const DEFAULT_PROSE_STYLE_RULE_PATH = `${PROSE_STYLE_RULES_DIR}/默认笔风规则.md`
export const WORK_DESCRIPTION_MAX_FILES = 8
export const WORK_DESCRIPTION_MAX_CHARS = 4000

/** Always-on description baselines (after `自动.md`, before scene cards). */
export const ALWAYS_ON_DESCRIPTION_BASELINES = [
  SENSORY_DESCRIPTION_RULE_PATH,
  DEAI_DESCRIPTION_RULE_PATH,
] as const

const WORK_DESCRIPTION_FILE_PATTERN = /^表现输出\/本作品描写\/[^/]+\.md$/u
const DESCRIPTION_RULE_FILE_PATTERN = /^表现输出\/描写规则\/[^/]+\.md$/u
const USER_PRESET_PRESENTATION_FILE_PATTERN = /^表现输出\/(?:描写规则|笔风规则)\/[^/]+\.md$/u

/** Platform seed: always-on sensory timing baseline (when to write, not how). */
export const SENSORY_DESCRIPTION_RULE_MARKDOWN = [
  "# 感官描写",
  "",
  "> 职责：规定**何时**必须落到感官与可感知细节。不管具体怎么写、用什么词、偏哪种腔。",
  "",
  "## 本轮身份",
  "",
  "本文件是描写**基线**，每轮正式推演与创作台讨论都会注入，不论下拉选「自动」还是锁定某一场面卡。",
  "切镜、密度、铺开顺序仍由 `自动.md` / 场面卡 / 锁定文件负责；本文件只补「该不该写感官」的时机。",
  "具体写法由 AI 按场面与人物限知自由发挥；若用户要固定气味、色调、禁用词等细节偏好，写在 `表现输出/本作品描写/`，不要改本文件的「时机」职责。",
  "",
  "## 硬约束",
  "",
  "- **时机到位就要写**：下列触发出现时，正文须留下可感知的感官或外观痕迹，禁止只用抽象判断句带过（如「很好看」「好臭」「很可怕」而无任何感知落点）。",
  "- **怎么写不规定**：不要求五感清单、不规定修辞、不规定篇幅；一点到位即可，也可更密，服从当前场面卡密度与限知。",
  "- **限知优先**：只写观察者当下能闻到、看见、听见、触到、尝到或身体直接感到的；不得为凑感官泄露其不知的信息。",
  "- **首次优先，重复从简**：同一对象/刺激的「首次」须落笔；之后只写变化、对比或当下仍抢注意力的一点，禁止每次见面重铺全套。",
  "- 不改世界事实；禁止把「镜头推进 / 切到特写」写进正文。",
  "",
  "## 何时必须落到感官或可感知细节",
  "",
  "### 人与人",
  "",
  "- **靠近、拥抱、贴身、共处一室到能闻到对方时**：落到体味、发香、汗气、呼吸、衣物气息等可感知气味（有则写，无则写清新/干燥/皂气等当场真实的一点，勿空喊「靠近了」）。",
  "- **本场或本章第一次看清某人**：落到可辨认的外观——脸、眉眼、身形、姿态、伤疤、脏污、气色等观察者此时能看见的一点或多点。",
  "- **对方换了衣服 / 第一次以这身装束出场**：落到衣装的形色、质地、新旧、是否合身、是否沾污等可见处。",
  "- **身体接触刚发生或性质变化时**（拉住、推开、擦伤、体温传来等）：落到触感或温度，不只写动作名。",
  "",
  "### 人与物 / 环境",
  "",
  "- **第一次进入关键空间，或空间气味/光线突变**：落到气味、空气、湿度、光暗、声响中至少一种当场可感。",
  "- **第一次拿起、穿上、吃到、踩上关键物件**：落到触感、重量、温度、味道或声音中与剧情有关的一点。",
  "",
  "### 刺激性场面（首次或剧情要求停住时）",
  "",
  "下列刺激在**首次遭遇**，或细纲/场面要求角色被其击中时，必须写可感知落点，禁止只贴标签：",
  "",
  "- 血腥、伤残、尸体与体液",
  "- 恐怖、惊惧、不洁与压迫感",
  "- 黑暗、眩光、烟尘、浓雾",
  "- 恶臭、腐气、刺鼻化学味",
  "- 强烈的美、华丽、醒目衣装或场面",
  "- 色欲 / 色情张力下的身体感知（气味、体温、触感、呼吸、布料等）——仍服从限知与用户规则/细纲禁笔，本文件只要求「有感知」，不规定尺度与措辞",
  "",
  "## 不做的事",
  "",
  "- 不教如何比喻、不列必须用的意象词。",
  "- 不要求每段五感齐全；与当前动作无关的感官可以不写。",
  "- 不替代 `本作品描写/`：作品级持续偏好（固定体味设定、禁用某种感官夸张等）由用户或讨论写入本作品描写。",
].join("\n")

/**
 * Platform seed: always-on anti-AI-slop baseline.
 * Synthesized from common fiction deslop practice (banned tells, show-don't-explain, speech-like dialogue).
 */
export const DEAI_DESCRIPTION_RULE_MARKDOWN = [
  "# 去AI味",
  "",
  "> 职责：压掉机器腔与模板句，让正文读起来像人写的场面。不管题材腔、笔风词表；那些由笔风规则 / 本作品描写负责。",
  "",
  "## 本轮身份",
  "",
  "本文件是描写**基线**，每轮正式推演与创作台讨论都会注入，不论下拉选「自动」还是锁定某一场面卡。",
  "切镜与密度仍由场面卡负责；感官落点时机由 `感官描写.md` 负责；本文件只管「别写成 AI 套话」。",
  "作品专属禁用词、口头禅偏好写在 `表现输出/本作品描写/`，可叠加在本基线之上。",
  "",
  "## 硬约束",
  "",
  "- **信任读者**：场面已经演出来的情绪/关系，禁止再跟一句作者总结（「他明白了」「这意味着」「真正重要的是」「从这一刻起」）。",
  "- **落到具体**：关键情绪用动作、物件、声音、后果承载；禁止空挂「感到一丝XX」「涌起一股XX」「一种说不清的感觉」。",
  "- **对话像说话**：可打断、吞字、说偏一点；禁止人人出口成章、句句金句。",
  "- **句式要有起伏**：长短交错；禁止整段同长并列、三连排比感官清单当装饰。",
  "- **不要为去味而注水**：删套话后用当场证据补上，不要机械换同义词，也不要故意错字装人。",
  "",
  "## 优先杀掉的模板（正文尽量不出现）",
  "",
  "### 中文高频套话",
  "",
  "- 眼中闪过一丝… / 眼神里写满了… / 目光如炬 / 眸光",
  "- 嘴角勾起一抹… / 嘴角微扬 / 扯出一抹笑",
  "- 心中涌起一股… / 不禁… / 不由自主… / 他感到… / 他意识到…",
  "- 空气仿佛凝固 / 时间在这一刻静止 / 沉默变得沉重",
  "- 映入眼帘 / 只见 / 此时此刻 / 深吸一口气（作万能转场）",
  "- 「不是A，而是B」解释腔；「声音不大，却带着…」；「带着一丝XX地说」",
  "- 「取而代之的是…」；「浑身散发着一股…气息/气场」；「命运/齿轮/棋局」收束升华",
  "- 连续堆砌「一丝 / 一抹 / 仿佛 / 似乎 / 显得有些」",
  "",
  "### 英文/翻译腔常见 AI tell（若正文出现英式转写也禁）",
  "",
  "- a sense of… / couldn't help but (feel) / a pang/wave of… washed over",
  "- eyes widened / heart pounded in his chest / let out a breath he didn't know he was holding",
  "- the air was thick with… / piercing … eyes / a knowing smile",
  "",
  "## 正向替代（原则，不规定用词）",
  "",
  "- 要写怒/怕/欲：写手、呼吸、距离、物件、话说到一半停住——不要贴标签。",
  "- 要写好看/可怕/臭：落到观察者当场看见或闻到的一点（与 `感官描写.md` 配合），不要只说「很好看/很可怕」。",
  "- 场面结束后直接切下一动作或对白；不要加旁白讲课。",
  "- 比喻须来自角色生活经验；禁止万能「像一把刀/像潮水」无差别乱贴。",
  "",
  "## 不做的事",
  "",
  "- 不规定必须冷峻、必须口语、必须短句——那是笔风规则的事。",
  "- 不要求每句都「骚操作」；过场可以平。",
  "- 人物对白里允许说套话（若符合性格）；作者叙述禁止套话。",
].join("\n")

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
  "`感官描写.md` 与 `去AI味.md` 是**始终生效的基线**，不是可切换场面卡；不要把它们当成「切到某种模式」。",
  "",
  "## 硬约束",
  "",
  "- 同一章**可以**出现多种描写场面，必须随情节功能切换，禁止整章锁死在一张卡上。",
  "- 用户若在下拉中锁定某一文件，则以该文件为准，本文件不生效；但 `感官描写.md` 与 `去AI味.md` 仍会一并注入。",
  "- 按文件名/标题匹配当前场面；没有对应卡时，用下方「缺卡时的默认判断」。",
  "- 禁止把「镜头推进 / 切到 / 特写」写进正文。不改世界事实与人物未知信息。",
  "",
  "## 何时切到哪张卡",
  "",
  "匹配文件名或标题中的关键词（不必字面相同）；**不要**把「感官描写」「去AI味」当作切换目标：",
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
  "感官落点时机始终遵守 `感官描写.md`；叙述去套话始终遵守 `去AI味.md`。",
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
      const leftBaseline = ALWAYS_ON_DESCRIPTION_BASELINES.indexOf(
        leftPath as typeof ALWAYS_ON_DESCRIPTION_BASELINES[number],
      )
      const rightBaseline = ALWAYS_ON_DESCRIPTION_BASELINES.indexOf(
        rightPath as typeof ALWAYS_ON_DESCRIPTION_BASELINES[number],
      )
      if (leftBaseline !== -1 || rightBaseline !== -1) {
        if (leftBaseline === -1) return 1
        if (rightBaseline === -1) return -1
        return leftBaseline - rightBaseline
      }
      return leftPath.localeCompare(rightPath, "zh-CN")
    })
}

/**
 * Auto: every 描写规则 file.
 * Locked: selected file + always-on baselines (`感官描写.md`, `去AI味.md`).
 */
export function resolveDescriptionRulePaths(
  descriptionRulePath: string | undefined,
  catalogEntries: readonly { relativePath: string; entryKind: string }[],
): string[] {
  if (!isAutoDescriptionSelection(descriptionRulePath)) {
    const selected = normalizeWorkspaceRelativePath(descriptionRulePath ?? "")
    if (!isDescriptionRuleMarkdownPath(selected)) {
      throw new Error(`Description rule must be inside ${DESCRIPTION_RULES_DIR}: ${descriptionRulePath ?? ""}`)
    }
    return ensureAlwaysOnDescriptionBaselines([selected])
  }
  const all = listDescriptionRuleFiles(catalogEntries).map((entry) => (
    normalizeWorkspaceRelativePath(entry.relativePath)
  ))
  if (all.length === 0) {
    throw new Error(`Selected presentation rule is missing: ${AUTO_DESCRIPTION_RULE_PATH}`)
  }
  return ensureAlwaysOnDescriptionBaselines(all)
}

/** Keep always-on baselines after auto, before scene cards; force-include even if catalog omitted them. */
export function ensureAlwaysOnDescriptionBaselines(paths: readonly string[]): string[] {
  const baselineSet = new Set<string>(ALWAYS_ON_DESCRIPTION_BASELINES)
  const normalized = paths.map((path) => normalizeWorkspaceRelativePath(path))
  const withoutBaselines = normalized.filter((path) => !baselineSet.has(path))
  const auto = withoutBaselines.filter((path) => path === AUTO_DESCRIPTION_RULE_PATH)
  const rest = withoutBaselines.filter((path) => path !== AUTO_DESCRIPTION_RULE_PATH)
  return [...auto, ...ALWAYS_ON_DESCRIPTION_BASELINES, ...rest]
}

/** @deprecated Use ensureAlwaysOnDescriptionBaselines */
export function ensureSensoryDescriptionAlwaysIncluded(paths: readonly string[]): string[] {
  return ensureAlwaysOnDescriptionBaselines(paths)
}

export function formatDescriptionRuleEvidence(
  relativePath: string,
  content: string,
  autoMode: boolean,
): string {
  const path = normalizeWorkspaceRelativePath(relativePath)
  if (path === SENSORY_DESCRIPTION_RULE_PATH) {
    return [
      "【描写·感官基线·本轮始终生效】",
      "本文件只管「何时该落感官」，不管怎么写；具体写法由 AI 自由发挥，或由用户在本作品描写中补充细节偏好。",
      "与自动调度 / 场面卡 / 锁定描写规则并存：那些管切镜与密度，本文件管感官落点时机。",
      "",
      content,
    ].join("\n")
  }
  if (path === DEAI_DESCRIPTION_RULE_PATH) {
    return [
      "【描写·去AI味基线·本轮始终生效】",
      "本文件压掉机器腔与模板句；不管题材腔与笔风词表。作品专属禁用词可写在本作品描写中叠加。",
      "与自动调度 / 场面卡 / 锁定描写规则并存。",
      "",
      content,
    ].join("\n")
  }
  if (autoMode) {
    if (path === AUTO_DESCRIPTION_RULE_PATH) {
      return [
        "【描写·自动调度】",
        "同一章可以切换多种描写场面。按本文件决定何时启用其他描写文件。",
        "`感官描写.md` 与 `去AI味.md` 始终生效，不是可切换场面卡。",
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
    "整章必须遵守本文件，不得改用同目录其他描写规则（感官与去AI味基线仍同时生效）。",
    "",
    content,
  ].join("\n")
}export function assertWorkDescriptionCharLimit(relativePath: string, content: string): void {
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
