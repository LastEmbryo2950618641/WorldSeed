/** Cold-start work style file: hard sections for host gate + seed template. */

export const WORK_STYLE_RULE_PATH = "表现输出/本作品描写/作品风格.md" as const

/** Required `##` headings (exact match after trim). */
export const WORK_STYLE_REQUIRED_HEADINGS = [
  "## 1. 语体笔风",
  "## 2. 时代科技生活",
  "## 3. 规则称谓能力",
  "## 4. 命名",
  "## 5. 角色声口",
  "## 6. 尺度意象章钩",
  "## 7. 人称指称",
  "## 8. 句子与对话",
] as const

const PENDING_MARKERS = ["待定", "（待定）", "(待定)", "TBD", "todo"] as const

export type WorkStyleAssessment = Readonly<{
  path: typeof WORK_STYLE_RULE_PATH
  exists: boolean
  complete: boolean
  missingHeadings: readonly string[]
  pendingHeadings: readonly string[]
  /** Present and not「待定」, but fail substance (命名示例、笔风路径等). */
  weakHeadings: readonly string[]
}>

/**
 * Assess whether 作品风格.md has all 8 sections with non-placeholder, substantive body.
 */
export function assessWorkStyleMarkdown(markdown: string | undefined): WorkStyleAssessment {
  if (markdown === undefined || markdown.trim().length === 0) {
    return {
      path: WORK_STYLE_RULE_PATH,
      exists: false,
      complete: false,
      missingHeadings: [...WORK_STYLE_REQUIRED_HEADINGS],
      pendingHeadings: [],
      weakHeadings: [],
    }
  }
  const normalized = markdown.replaceAll("\r\n", "\n")
  const missingHeadings: string[] = []
  const pendingHeadings: string[] = []
  const weakHeadings: string[] = []
  for (const heading of WORK_STYLE_REQUIRED_HEADINGS) {
    if (!normalized.includes(heading)) {
      missingHeadings.push(heading)
      continue
    }
    const body = sectionBodyAfterHeading(normalized, heading)
    if (isPendingOrEmptySection(body)) {
      pendingHeadings.push(heading)
      continue
    }
    const weakReason = substanceFailure(heading, body)
    if (weakReason !== undefined) weakHeadings.push(heading)
  }
  return {
    path: WORK_STYLE_RULE_PATH,
    exists: true,
    complete: missingHeadings.length === 0
      && pendingHeadings.length === 0
      && weakHeadings.length === 0,
    missingHeadings,
    pendingHeadings,
    weakHeadings,
  }
}

export function isWorkStyleComplete(markdown: string | undefined): boolean {
  return assessWorkStyleMarkdown(markdown).complete
}

/** Empty seed: headings + checklist hints + 待定. */
export const WORK_STYLE_SEED_MARKDOWN = [
  "# 作品风格",
  "",
  "> 整部作品硬约束。人称/命名/声口/对话以本文件为准；描写/笔风下拉只管机位与腔调预设，不能改写本文件已定人称与命名。",
  "> 开书须先给出 2–3 套风格备选（choices），每套绑定一个 `表现输出/笔风规则/*.md`；用户选定或「按你的来」后再把下列 8 维写成正向定义（不得留「待定」）。",
  "",
  "## 1. 语体笔风",
  "",
  "待定",
  "",
  "（须含：主锚 `表现输出/笔风规则/××.md`；语气基调；描写密度）",
  "",
  "## 2. 时代科技生活",
  "",
  "待定",
  "",
  "## 3. 规则称谓能力",
  "",
  "待定",
  "",
  "## 4. 命名",
  "",
  "待定",
  "",
  "（须含：人名/地名/势力规则；防撞名；正例≥2、反例≥1）",
  "",
  "## 5. 角色声口",
  "",
  "待定",
  "",
  "（须含：主角声口 + 至少一名配角对照 + 示例句）",
  "",
  "## 6. 尺度意象章钩",
  "",
  "待定",
  "",
  "## 7. 人称指称",
  "",
  "待定",
  "",
  "（须含：人称类型；以「我」或姓名为主；示例句）",
  "",
  "## 8. 句子与对话",
  "",
  "待定",
  "",
  "（须含：句长；对白口语度；群戏/禁乒乓；对白正例与反例）",
  "",
].join("\n")

function sectionBodyAfterHeading(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  if (start < 0) return ""
  const after = markdown.slice(start + heading.length)
  const next = after.search(/\n##\s/u)
  return (next < 0 ? after : after.slice(0, next)).trim()
}

function isPendingOrEmptySection(body: string): boolean {
  if (body.length === 0) return true
  const withoutHints = body
    .split("\n")
    .filter((line) => !/^[（(]须含/u.test(line.trim()))
    .join("\n")
    .trim()
  if (withoutHints.length === 0) return true
  const compact = withoutHints.replace(/\s+/gu, "")
  if (compact.length === 0) return true
  for (const marker of PENDING_MARKERS) {
    if (compact === marker || compact === `>${marker}`) return true
  }
  if (/^待定[。．.!！]?$/u.test(withoutHints)) return true
  // Body is only 待定 plus parenthetical hints
  if (/^待定[。．.!！]?\s*(?:[（(][^）)]*[）)])?\s*$/u.test(withoutHints)) return true
  return false
}

function substanceFailure(heading: string, body: string): string | undefined {
  switch (heading) {
    case "## 1. 语体笔风": {
      if (!body.includes("笔风规则/")) {
        return "须点名表现输出/笔风规则/ 主锚路径"
      }
      return undefined
    }
    case "## 4. 命名": {
      if (body.replace(/\s+/gu, "").length < 40) return "命名节过短"
      if (!/(?:正例|示例|例如|例：|例\s)/u.test(body)) return "命名节须含示例/正例"
      if (!/(?:反例|不要|禁止|不合格)/u.test(body)) return "命名节须含反例或禁止取法"
      return undefined
    }
    case "## 5. 角色声口": {
      if (body.replace(/\s+/gu, "").length < 30) return "声口节过短"
      if (!/(?:示例|例：|例如|[「“"])/u.test(body)) return "声口节须含示例句"
      return undefined
    }
    case "## 7. 人称指称": {
      if (!/(?:第一人称|第二人称|第三人称|限知|全知)/u.test(body)) {
        return "人称节须写明人称类型"
      }
      return undefined
    }
    case "## 8. 句子与对话": {
      if (body.replace(/\s+/gu, "").length < 40) return "句子与对话节过短"
      if (!/(?:对白|对话)/u.test(body)) return "须写对白/对话规则"
      if (!/(?:乒乓|口语|文白|句长|群戏|潜台词)/u.test(body)) {
        return "须含句长/口语或群戏等对话系统字段"
      }
      return undefined
    }
    default:
      return undefined
  }
}
