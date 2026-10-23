import type { AIPhase } from "@worldseed/contracts"

/** Short index always injected into system_rules (not full skill bodies). */
export const SKILL_INDEX_RESOURCE = "resources/v1/skill-index.md" as const

export type SkillInjectPolicy = "always" | "default" | "onDemand"

/**
 * Platform craft / discuss skills. Bodies stay in vendor or v1 guides;
 * only the index is sticky in system_rules.
 */
export type SkillDefinition = Readonly<{
  id: string
  name: string
  summary: string
  injectPolicy: SkillInjectPolicy
  /** Phases that auto-load this skill when injectPolicy is `default`. */
  defaultPhases: readonly (AIPhase | "synopsis_discuss")[]
  primaryResource: string
  referenceResources: readonly string[]
  /** Package-relative scripts dir (optional). */
  scriptsDir?: string
  /** Left-tree / catalog visibility hint. */
  treeVisibility: "primary" | "reference" | "hidden"
}>

const VENDOR = "resources/vendor/chinese-webnovel-skills" as const

export const PLATFORM_SKILLS: readonly SkillDefinition[] = Object.freeze([
  {
    id: "webnovel-deslop",
    name: "去 AI 味（deslop）",
    summary: "改工整/排比/翻译腔/空洞抒情；写正文或润色时用。",
    injectPolicy: "default",
    defaultPhases: ["draft", "synopsis_discuss"],
    primaryResource: `${VENDOR}/skills/deslop.md`,
    referenceResources: [
      `${VENDOR}/references/anti-ai-checklist.md`,
      `${VENDOR}/references/sentence-rhythm.md`,
    ],
    scriptsDir: "resources/skills/webnovel-deslop/scripts",
    treeVisibility: "primary",
  },
  {
    id: "webnovel-dialogue",
    name: "对话与台词",
    summary: "口语化、潜台词、角色声音、禁对白乒乓；写对白或改书面腔时用。",
    injectPolicy: "default",
    defaultPhases: ["draft", "synopsis_discuss"],
    primaryResource: `${VENDOR}/skills/dialogue.md`,
    referenceResources: [`${VENDOR}/references/dialogue-library.md`],
    scriptsDir: "resources/skills/webnovel-dialogue/scripts",
    treeVisibility: "primary",
  },
  {
    id: "webnovel-human",
    name: "人味 / 失控感",
    summary: "表面去味后仍像说明书时用：非理性、留白、私货。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource: `${VENDOR}/skills/human.md`,
    referenceResources: [`${VENDOR}/references/human-texture.md`],
    treeVisibility: "primary",
  },
  {
    id: "webnovel-emotion",
    name: "情绪演出",
    summary: "喊情绪不演、缺身体反应时用；查情绪→外显对照。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource: `${VENDOR}/skills/emotion.md`,
    referenceResources: [`${VENDOR}/references/show-emotion.md`],
    treeVisibility: "primary",
  },
  {
    id: "book-cold-start",
    name: "开书冷启动",
    summary: "一句话→绑笔风的风格备选→命名/对话硬落盘→卷大纲；未完成禁正文。",
    injectPolicy: "default",
    defaultPhases: ["synopsis_discuss"],
    primaryResource: "resources/skills/book-cold-start/SKILL.md",
    referenceResources: [
      "resources/skills/book-cold-start/references/style-pack-spec.md",
      "resources/vendor/webnovel-handbook/docs/core-writing/37-project-style-bible-character-voice.md",
      "resources/vendor/webnovel-handbook/docs/core-writing/106-naming-address-terminology-recognition-consistency.md",
    ],
    treeVisibility: "primary",
  },
  {
    id: "style-bible",
    name: "项目风格手册与声口",
    summary: "开书/续写前定旁白距离、角色声音矩阵、称呼与禁改平项。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource:
      "resources/vendor/webnovel-handbook/docs/core-writing/37-project-style-bible-character-voice.md",
    referenceResources: [
      "resources/vendor/webnovel-handbook/docs/advanced-craft/96-narrative-voice-attitude-narrator-persona.md",
      "resources/vendor/webnovel-handbook/docs/core-writing/04-character-and-dialogue.md",
    ],
    treeVisibility: "primary",
  },
  {
    id: "naming-consistency",
    name: "命名称谓一致性",
    summary: "人名/地名/称呼/术语防撞与前后一致；开书定命名或查撞名时用。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource:
      "resources/vendor/webnovel-handbook/docs/core-writing/106-naming-address-terminology-recognition-consistency.md",
    referenceResources: [],
    treeVisibility: "primary",
  },
  {
    id: "dialogue-subtext",
    name: "对话潜台词与战术话轮",
    summary: "对白有议程/潜台词/群戏分层；改审讯腔或同声对白时用。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource:
      "resources/vendor/webnovel-handbook/docs/advanced-craft/75-dialogue-subtext-tactical-conversation.md",
    referenceResources: [
      "resources/vendor/oh-story-claudecode/skills/story-long-write/references/dialogue-mastery.md",
      "resources/vendor/webnovel-handbook/docs/core-writing/59-dialogue-comparison-reference.md",
    ],
    treeVisibility: "primary",
  },
  {
    id: "style-profile",
    name: "文风剖析协议",
    summary: "从对标书抽出句长/对话/情绪周期文风手册时用。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource:
      "resources/vendor/oh-story-claudecode/skills/story-long-analyze/references/style-profile-generator.md",
    referenceResources: [],
    treeVisibility: "reference",
  },
  {
    id: "genre-style-presets",
    name: "题材笔风短预设",
    summary: "奇幻/言情/悬疑等短风格条；补笔风下拉或冷启动备选时参考。",
    injectPolicy: "onDemand",
    defaultPhases: [],
    primaryResource: "resources/vendor/ainovel-cli/assets/styles/default.md",
    referenceResources: [
      "resources/vendor/ainovel-cli/assets/styles/fantasy.md",
      "resources/vendor/ainovel-cli/assets/styles/romance.md",
      "resources/vendor/ainovel-cli/assets/styles/suspense.md",
      "resources/vendor/ainovel-cli/assets/references/anti-ai-tone.md",
    ],
    treeVisibility: "reference",
  },
  {
    id: "discuss-workflow",
    name: "创作台讨论工作流",
    summary: "创作台 outcome/工具/门禁流程；讨论回合默认挂载。",
    injectPolicy: "default",
    defaultPhases: ["synopsis_discuss"],
    primaryResource: "resources/v1/discuss-creation-desk-workflow.md",
    referenceResources: [],
    treeVisibility: "primary",
  },
  {
    id: "plot-synopsis",
    name: "梗概与细纲指南",
    summary: "写/改梗概或细纲时用。",
    injectPolicy: "default",
    defaultPhases: ["synopsis_discuss"],
    primaryResource: "resources/v1/plot-synopsis-guide.md",
    referenceResources: [],
    treeVisibility: "primary",
  },
  {
    id: "settings-revision",
    name: "设定修订指南",
    summary: "改设定集、对齐冲突设定时用。",
    injectPolicy: "default",
    defaultPhases: ["synopsis_discuss"],
    primaryResource: "resources/v1/settings-revision-guide.md",
    referenceResources: [],
    treeVisibility: "primary",
  },
] as const)

const skillById = new Map(PLATFORM_SKILLS.map((skill) => [skill.id, skill]))

export function resolveSkillDefinition(skillId: string): SkillDefinition | undefined {
  return skillById.get(skillId.trim())
}

export function listPlatformSkills(): readonly SkillDefinition[] {
  return PLATFORM_SKILLS
}

export function defaultSkillIdsForPhase(phase: AIPhase | "synopsis_discuss"): readonly string[] {
  return PLATFORM_SKILLS
    .filter((skill) => skill.injectPolicy === "default" && skill.defaultPhases.includes(phase))
    .map((skill) => skill.id)
}

/** Render the always-on skill index markdown (also shipped as skill-index.md). */
export function renderSkillIndexMarkdown(skills: readonly SkillDefinition[] = PLATFORM_SKILLS): string {
  const lines = [
    "# 平台 Skill 索引（按需加载）",
    "",
    "完整 skill 正文**不**常驻系统规则。需要时用工具 `load_skill`（先 describe 再 invoke），或由宿主按阶段默认挂载。",
    "arguments 示例：`{\"skillId\":\"webnovel-dialogue\",\"includeReferences\":false}`。",
    "",
    "| id | 名称 | 策略 | 何时用 |",
    "|----|------|------|--------|",
  ]
  for (const skill of skills) {
    const policy = skill.injectPolicy === "default"
      ? `default(${skill.defaultPhases.join(",")})`
      : skill.injectPolicy
    lines.push(`| \`${skill.id}\` | ${skill.name} | ${policy} | ${skill.summary} |`)
  }
  lines.push(
    "",
    "## 描写场面卡（工作区）",
    "",
    "Auto 模式只注入 `表现输出/描写规则/自动.md` + 感官/去AI味基线；其他场面卡用 `request_read`（`sourceKinds:[\"rule\"]`）或锁定下拉按需加载。",
    "",
  )
  return `${lines.join("\n")}\n`
}

export function formatSkillEvidenceHeader(skillId: string, includeReferences: boolean): string {
  return `【skill:${skillId}】${includeReferences ? "（含 references）" : "（仅 SKILL 正文）"}`
}

export const SYNOPSIS_SKILLS_PROTOCOL = "synopsis-skills-v1" as const
