import { describe, expect, it } from "vitest"

import {
  fictionDeliveryReminder,
  inspectFictionProse,
  inspectPhaseFictionDelivery,
} from "../src/fiction-delivery.js"

describe("fiction delivery inspector", () => {
  it.each([
    ["抱歉，我无法生成涉及极端暴力的内容。", "refusal"],
    ["对不起，该请求不符合规范。", "refusal"],
    ["作为AI，我不能提供此类描写。", "refusal"],
    ["涉及敏感内容，请换一个题材。", "refusal"],
    ["（等待读取设定，尚未开始撰写正文。）", "refusal"],
    ["I cannot write this because it is against my guidelines.", "refusal"],
    ["As an AI I'm unable to continue.", "refusal"],
    ["我可以改成更安全的版本，去掉伤亡。", "fallback"],
  ] as const)("flags %s", (text, verdict) => {
    const inspection = inspectFictionProse(text)
    expect(inspection.ok).toBe(false)
    if (!inspection.ok) expect(inspection.verdict).toBe(verdict)
  })

  it.each([
    "刀光不能近身，他只能侧步，衣袖已经裂开。",
    "他无法可破，只能硬接这一掌，肋骨随即塌下去。",
    "「抱歉，这一刀来得太快。」血从袖口渗出来，校场上再没有人出声。",
    "人头落地之后，尘土里还在抽搐。围观的人谁也不敢先说话。",
    "反派把俘虏的手指一根根折断，问的却只是城门钥匙在谁手里。",
  ])("allows fictional prose: %s", (text) => {
    expect(inspectFictionProse(text)).toEqual({ ok: true })
  })

  it("inspects draft contentMarkdown and skips read requests", () => {
    expect(inspectPhaseFictionDelivery("draft", {
      contentMarkdown: "抱歉，我无法生成这段战斗。",
    }).ok).toBe(false)
    expect(inspectPhaseFictionDelivery("draft", {
      contentMarkdown: "刀光不能近身。",
    }).ok).toBe(true)
    expect(inspectPhaseFictionDelivery("draft", {
      contentMarkdown: "抱歉，我无法生成这段战斗。",
    }, "request_read").ok).toBe(true)
    expect(inspectPhaseFictionDelivery("interpret", {
      contentMarkdown: "抱歉，我无法生成这段战斗。",
    }).ok).toBe(true)
  })

  it("inspects revision and synopsis user-facing prose", () => {
    expect(inspectPhaseFictionDelivery("revision_assist", {
      proposedBody: "抱歉，我无法生成这段修订。",
      assistantMessage: "已按你的要求改了一刀。",
    }).ok).toBe(false)
    expect(inspectPhaseFictionDelivery("revision_assist", {
      proposedBody: "刀光不能近身，他只能侧步。",
      assistantMessage: "按你的要求把这一刀写进正文了。",
    }).ok).toBe(true)
    expect(inspectPhaseFictionDelivery("synopsis_discuss", {
      assistantMessage: "作为AI，我不能提供此类描写。",
    }).ok).toBe(false)
    expect(inspectPhaseFictionDelivery("synopsis_discuss", {
      assistantMessage: "这一章应把比武写到见血，再接到城门失守。",
      synopsisBody: "校场比武后，人头落地，围观的人谁也不敢先说话。",
    }).ok).toBe(true)
    expect(inspectPhaseFictionDelivery("synopsis_discuss", {
      assistantMessage: "恐惧不怕写，但不把她写成享受或自愿；细纲里身体反应仍按设定来。",
    }).ok).toBe(true)
    expect(inspectPhaseFictionDelivery("synopsis_discuss", {
      assistantMessage: "按你的要求改一场。",
      bodyEdits: {
        target: "outline",
        ops: [{ oldText: "原句", newText: "抱歉，我无法生成这段细纲。" }],
      },
    }).ok).toBe(false)
    expect(inspectPhaseFictionDelivery("synopsis_discuss", {
      assistantMessage: "按你的要求改一场。",
      bodyEdits: {
        target: "outline",
        ops: [{ oldText: "原句", newText: "刀光不能近身，他只能侧步。" }],
      },
    }).ok).toBe(true)
  })

  it("reminds the model that phenomenology follows in-world cause", () => {
    expect(fictionDeliveryReminder()).toContain("身心状态只跟世界因果")
    expect(fictionDeliveryReminder()).toContain("Affect follows in-world cause")
  })
})
