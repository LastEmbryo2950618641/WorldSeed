import type { AIPhase, ProjectSettings, WorldDivergenceMode } from "@worldseed/contracts"

export function resolveWorldDivergenceMode(
  projectSettings: ProjectSettings | undefined,
): WorldDivergenceMode {
  return projectSettings?.execution.worldDivergenceMode ?? "world_consistent"
}

export function allowsSettingsCreate(mode: WorldDivergenceMode): boolean {
  return mode !== "strict"
}

/** Phase appendix injected after the static phase prompt for draft / settings_extraction. */
export function worldDivergencePhaseAppendix(
  mode: WorldDivergenceMode,
  phase: AIPhase,
): string | undefined {
  if (phase !== "draft" && phase !== "settings_extraction") return undefined
  const heading = "## 推演发散程度（本轮强制）"
  if (mode === "strict") {
    return [
      heading,
      "当前模式：**严格遵循设定**。",
      "- 只能基于已读设定集、已读证据与世界图中的既有材料推进；",
      "- **不得**引入未在上述材料中出现的新人物/地点/势力/规则等设定性内容；",
      "- 若正文需要新元素，只能使用已有设定的合理组合或明确标注为场景瞬时细节（不进入设定集）；",
      phase === "settings_extraction"
        ? "- 设定抽取：**禁止**输出 `create` 提案；仅可对已有设定文件提出 `update`/`merge`，若无必要变更则返回空 `proposals`。"
        : "- 不得为「以后写入设定集」而提前发明新设定实体。",
    ].join("\n")
  }
  if (mode === "free") {
    return [
      heading,
      "当前模式：**自由发挥**。",
      "- 在既有世界观基础上，可以衍生世界观分支、扩展规则体系，并创作新设定；",
      "- 新设定仍须自洽，并与已读图事实不冲突；冲突时服从已读图当前状态；",
      phase === "settings_extraction"
        ? "- 设定抽取：可为新材料输出 `create`，也可 `update`/`merge` 已有文件；全部提案须经用户确认后才写入。"
        : "- 新设定性内容可在正文中建立，后续由设定抽取提案给用户确认。",
    ].join("\n")
  }
  return [
    heading,
    "当前模式：**基于世界观生成设定**（默认）。",
    "- 必须基于已有世界观与设定推演，保持基调、规则与既有事实连续；",
    "- **可以**根据当前世界观补全/创建与之相容的新设定（新人物、地点、势力等）；",
    "- **不得**无故推翻或另起一套互斥的世界观根基；",
    phase === "settings_extraction"
      ? "- 设定抽取：允许对相容新材料输出 `create`，以及对已有文件 `update`/`merge`；全部提案须经用户确认后才写入。"
      : "- 新设定性内容可在正文中建立，后续由设定抽取提案给用户确认。",
  ].join("\n")
}
