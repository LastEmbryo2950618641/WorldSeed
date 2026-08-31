import type { AIPhase, ChapterNarrativeIntent } from "@worldseed/contracts"

export const DEFAULT_CHAPTER_NARRATIVE_INTENT: ChapterNarrativeIntent = {
  boundaryPace: "advance_allowed",
  causalityFocus: "auto",
}

export function resolveChapterNarrativeIntent(
  intent: ChapterNarrativeIntent | undefined,
): ChapterNarrativeIntent {
  return intent ?? DEFAULT_CHAPTER_NARRATIVE_INTENT
}

/** Phase appendix for synopsis_discuss / draft — narrative pace, not world-divergence. */
export function chapterNarrativeIntentPhaseAppendix(
  intent: ChapterNarrativeIntent | undefined,
  phase: AIPhase,
): string | undefined {
  if (phase !== "synopsis_discuss" && phase !== "draft") return undefined
  const resolved = resolveChapterNarrativeIntent(intent)
  const boundary = boundaryPaceSection(resolved.boundaryPace)
  const causality = causalityFocusSection(resolved.causalityFocus, resolved.boundaryPace)
  return [
    "## 章节叙事意图（本轮强制）",
    "说明：本附录管**情节节奏与因果描写重心**，不管设定能否新造（设定发散见项目「推演发散程度」）。",
    "两条选项的共同默认：正文/梗概须大体待在已定梗概与设定边界内。",
    "",
    boundary,
    "",
    causality,
  ].join("\n")
}

function boundaryPaceSection(pace: ChapterNarrativeIntent["boundaryPace"]): string {
  if (pace === "hold_without_resolution") {
    return [
      "### 边界节奏：压而不决",
      "- 允许加压、揭示、逼近抉择，以及**过程性选择**；",
      "- **禁止**落地不可逆闭合结果：胜负定局、关系定死、终极目标完成、生死决断等章末定局；",
      "- **错误理解**：把本模式当成「角色不能做任何决定」——不允许；角色可以做过程性选择，只是不收束到不可逆结局。",
    ].join("\n")
  }
  return [
    "### 边界节奏：可推进（仍贴梗概）",
    "- 可设计章内合理行动与阶段性结果；",
    "- 不得无故违背已定梗概与设定边界；",
    "- 允许局部后果，但仍须贴梗概。",
  ].join("\n")
}

function causalityFocusSection(
  focus: ChapterNarrativeIntent["causalityFocus"],
  pace: ChapterNarrativeIntent["boundaryPace"],
): string {
  const holdNote = pace === "hold_without_resolution"
    ? "- 当前为「压而不决」：即使偏落点，也只允许可逆/局部落点，禁止不可逆定局。"
    : undefined
  if (focus === "buildup") {
    return [
      "### 因果焦点：蓄势",
      "- 偏前因、压力、信息铺垫；少写最终收束。",
      ...(holdNote === undefined ? [] : [holdNote]),
    ].join("\n")
  }
  if (focus === "action") {
    return [
      "### 因果焦点：行动",
      "- 偏过程、对抗、旅途、交锋。",
      ...(holdNote === undefined ? [] : [holdNote]),
    ].join("\n")
  }
  if (focus === "payoff") {
    return [
      "### 因果焦点：落点",
      "- 偏后果与阶段性收束。",
      ...(holdNote === undefined ? [] : [holdNote]),
    ].join("\n")
  }
  return [
    "### 因果焦点：自动",
    "- 按梗概与上下文自行分配前因/行动/后果比重；",
    "- 若某一阶段明显过重，可在讨论中建议拆到后续章（正式推演仍一章一轮）。",
    ...(holdNote === undefined ? [] : [holdNote]),
  ].join("\n")
}
