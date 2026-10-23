import { describe, expect, it } from "vitest"

import { applyColdStartStyleGate } from "../src/application/chapters/cold-start-style-gate.js"
import {
  WORK_STYLE_REQUIRED_HEADINGS,
  WORK_STYLE_SEED_MARKDOWN,
  assessWorkStyleMarkdown,
  isWorkStyleComplete,
} from "../src/core/workspace/work-style-gate.js"

function completeStyleMarkdown(): string {
  return [
    "# 作品风格",
    "",
    "## 1. 语体笔风",
    "",
    "主锚：表现输出/笔风规则/东方玄幻.md。语气硬朗冷峻，描写密度适中，感官偏视觉。",
    "",
    "## 2. 时代科技生活",
    "",
    "冷兵器与符箓并行；货币用灵石；机构写宗门与城卫，不写现代警察。",
    "",
    "## 3. 规则称谓能力",
    "",
    "战力用境界名落笔；技能先效果后名称；称谓按辈分与阵营。",
    "",
    "## 4. 命名",
    "",
    "人名双/三音节错开姓与偏旁；常同框禁止同姓墙。",
    "正例：林烬、沈砚。反例：凌寒与凌霜同批不合格。",
    "势力：正派「×宗/×门」，商会「×阁」。",
    "",
    "## 5. 角色声口",
    "",
    "主角短句、少形容词，示例：「先活下来再说。」",
    "配角谋士长句带停顿，示例：「若依我看……此局已半输。」",
    "",
    "## 6. 尺度意象章钩",
    "",
    "暴力写后果不写虐杀展览；章末钩落在选择代价。",
    "",
    "## 7. 人称指称",
    "",
    "第三人称限知，贴林烬；正文以姓名为主。示例句：林烬抬眼，没接话。",
    "",
    "## 8. 句子与对话",
    "",
    "句长偏短；对白白话口语；禁对白乒乓，群戏按受损者→权力高位分层。",
    "正例：「滚。」反例：全员「我认为我们可以尝试一下」同一书面腔。",
    "",
  ].join("\n")
}

describe("work style gate", () => {
  it("treats seed template as incomplete", () => {
    const assessment = assessWorkStyleMarkdown(WORK_STYLE_SEED_MARKDOWN)
    expect(assessment.exists).toBe(true)
    expect(assessment.complete).toBe(false)
    expect(assessment.pendingHeadings).toEqual([...WORK_STYLE_REQUIRED_HEADINGS])
    expect(isWorkStyleComplete(WORK_STYLE_SEED_MARKDOWN)).toBe(false)
  })

  it("rejects thin naming/dialogue even when headings filled", () => {
    const thin = WORK_STYLE_REQUIRED_HEADINGS.map((heading) => (
      `${heading}\n\n已定：随便写点氛围。\n`
    )).join("\n")
    const assessment = assessWorkStyleMarkdown(`# 作品风格\n\n${thin}`)
    expect(assessment.complete).toBe(false)
    expect(assessment.weakHeadings.length).toBeGreaterThan(0)
  })

  it("accepts a fully filled style document", () => {
    expect(assessWorkStyleMarkdown(completeStyleMarkdown()).complete).toBe(true)
  })

  it("strips drafts and volume plans when style incomplete", () => {
    const { assist, blocked, notices } = applyColdStartStyleGate({
      diskStyleMarkdown: WORK_STYLE_SEED_MARKDOWN,
      assist: {
        chapterDraftProposal: { base: "draft", heading: "x", body: "y" },
        volumeChapterPlans: [{ chapterSequence: 1, synopsisBody: "a", outlineBody: "b" }],
        arcPlanMarkdown: "# 卷大纲",
        presentationWrites: [{
          relativePath: "表现输出/本作品描写/其他.md",
          markdown: "# 其他\n",
          mode: "create",
        }],
        choices: [{ label: "风格A", action: "continue_discuss" }],
      },
    })
    expect(blocked).toBe(true)
    expect(assist.chapterDraftProposal).toBeUndefined()
    expect(assist.volumeChapterPlans).toBeUndefined()
    expect(assist.arcPlanMarkdown).toBeUndefined()
    expect(assist.presentationWrites?.length).toBe(1)
    expect(assist.choices?.length).toBe(1)
    expect(notices.some((line) => line.includes("开书冷启动"))).toBe(true)
  })

  it("nudges for style choices when none offered", () => {
    const { notices } = applyColdStartStyleGate({
      diskStyleMarkdown: WORK_STYLE_SEED_MARKDOWN,
      assist: {
        presentationWrites: [{
          relativePath: "表现输出/本作品描写/其他.md",
          markdown: "# 其他\n",
          mode: "create",
        }],
      },
    })
    expect(notices.some((line) => line.includes("风格备选") && line.includes("笔风规则"))).toBe(true)
  })

  it("allows drafts when same-turn presentationWrites completes style", () => {
    const { blocked, assist } = applyColdStartStyleGate({
      diskStyleMarkdown: WORK_STYLE_SEED_MARKDOWN,
      assist: {
        chapterDraftProposal: { base: "draft", heading: "x", body: "y".repeat(100) },
        presentationWrites: [{
          relativePath: "表现输出/本作品描写/作品风格.md",
          markdown: completeStyleMarkdown(),
          mode: "update",
        }],
      },
    })
    expect(blocked).toBe(false)
    expect(assist.chapterDraftProposal).toBeDefined()
  })
})
