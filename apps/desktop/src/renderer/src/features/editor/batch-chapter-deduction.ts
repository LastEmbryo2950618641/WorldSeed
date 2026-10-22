export type BatchDeductionPhase =
  | "idle"
  | "focus"
  | "volume_plan"
  | "synopsis"
  | "outline"
  | "draft"
  | "publish"
  | "paused"
  | "stopped"

export type BatchDeductionMode = "volume_batch" | "chapter_once"

export type BatchDeductionStatus = Readonly<{
  running: boolean
  phase: BatchDeductionPhase
  mode?: BatchDeductionMode
  volumeFolderName?: string
  chapterSequence?: number
  label: string
}>

/** Volume batch: one discuss reply writes multi-chapter synopsis+outline via volumeChapterPlans. */
export const BATCH_VOLUME_PLAN_USER_MESSAGE = [
  "【批量推演·卷规划】卷大纲已就绪。请在同一次回复中完成本卷规划并落盘：",
  "1) 给出目标字数、章节数（可用 volumePlanMeta）；",
  "2) 用 volumeChapterPlans 为本卷每一章写出完整 synopsisBody + outlineBody（勿只写当前焦点章）；",
  "3) 不要调用 chapter_workflow / publish_draft；不要输出 set_focus / focusChange；",
  "4) 规划落盘齐后等待系统进入正文阶段。",
].join("")

/** Volume batch body (default): discuss Agent writes multi-chapter drafts. */
export const BATCH_VOLUME_DRAFT_USER_MESSAGE = [
  "【批量推演·正文草稿】本卷各章梗概与细纲已齐。请在同一次回复中：",
  "1) 用 chapterDraftProposals 为本卷尚无草稿的各章写出完整正文草稿（heading + body）；",
  "2) 禁止优先 chapter_workflow；项目未启用正文推演工具时不得调用该工具；",
  "3) 不要 publish_draft（图治理由系统按章顺序串行提交）；不要输出 set_focus / focusChange。",
].join("")

/** Volume batch body when chapterWorkflowEnabled: one multi-chapter workflow invoke. */
export const BATCH_VOLUME_WORKFLOW_DRAFT_USER_MESSAGE = [
  "【批量推演·正文推演】本卷各章梗概与细纲已齐，且已启用正文推演工具。请：",
  "1) describe+invoke chapter_workflow，arguments 含 userInput 与 chapterSequences（本卷待写草稿的全部章号）；",
  "2) 一次工具调用产出多章草稿；不要 publish_draft（系统按章序号串行图治理）；",
  "3) 不要输出 set_focus / focusChange。",
].join("")

export const BATCH_CHAPTER_USER_MESSAGE = [
  "【批量推演】请尽快完成本焦点章规划与草稿：",
  "1) 写出完整 synopsisBody；",
  "2) 同轮或紧接写出合格 outlineBody（勿停在等待用户点「用这份梗概写细纲」）；",
  "3) 用 chapterDraftProposal 写草稿（不要优先 chapter_workflow）；图治理由系统提交；",
  "4) 不要输出 set_focus / focusChange（焦点由系统推进下一章）。",
].join("")

export const BATCH_CHAPTER_ONCE_USER_MESSAGE = [
  "【按章推演】请完成本焦点章全链路后停止：",
  "1) 写出完整 synopsisBody；",
  "2) 同轮或紧接写出合格 outlineBody；",
  "3) 用 chapterDraftProposal 写草稿（不要优先 chapter_workflow）；不要 publish_draft；",
  "4) 不要输出 set_focus / focusChange；完成后等待用户指示，不要自行进入下一章。",
].join("")

export const BATCH_CHAPTER_OUTLINE_FOLLOWUP = "用这份梗概写细纲"

export function batchDeductionStatusLabel(
  phase: BatchDeductionPhase,
  chapterSequence?: number,
  volumeFolderName?: string,
): string {
  if (phase === "idle") return ""
  if (phase === "stopped") return "已停止"
  const volume = volumeFolderName === undefined || volumeFolderName.length === 0
    ? ""
    : `${volumeFolderName} · `
  if (phase === "paused") {
    return chapterSequence === undefined
      ? `${volume}已暂停`
      : `${volume}第 ${String(chapterSequence)} 章 · 已暂停`
  }
  const chapter = chapterSequence === undefined ? "" : `第 ${String(chapterSequence)} 章 · `
  if (phase === "focus") return `${volume}${chapter}切换焦点`
  if (phase === "volume_plan") return `${volume}卷规划（多章梗概+大纲）`
  if (phase === "synopsis") return `${volume}${chapter}梗概`
  if (phase === "outline") return `${volume}${chapter}细纲`
  if (phase === "draft") return `${volume}${chapter}草稿`
  if (phase === "publish") return `${volume}${chapter}正文`
  return `${volume}${chapter}`.trim()
}

export function createIdleBatchStatus(): BatchDeductionStatus {
  return { running: false, phase: "idle", label: "" }
}

/** Target artifact stage the current batch phase is working toward. */
export function batchPhaseTargetStage(
  phase: BatchDeductionPhase,
): "synopsis" | "outline" | "draft" | "body" | undefined {
  if (phase === "volume_plan") return "outline"
  if (phase === "synopsis") return "synopsis"
  if (phase === "outline") return "outline"
  if (phase === "draft") return "draft"
  if (phase === "publish") return "body"
  return undefined
}

/** True when every chapter has both synopsis and outline planning files. */
export function volumeChaptersHavePlans(
  chapters: readonly Readonly<{ synopsisPath?: string; outlinePath?: string }>[],
): boolean {
  if (chapters.length === 0) return false
  return chapters.every((chapter) => (
    chapter.synopsisPath !== undefined && chapter.outlinePath !== undefined
  ))
}
