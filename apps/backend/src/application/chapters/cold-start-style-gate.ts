import {
  WORK_STYLE_RULE_PATH,
  assessWorkStyleMarkdown,
  type WorkStyleAssessment,
} from "../../core/workspace/work-style-gate.js"

export type ColdStartAssistSlice = Readonly<{
  chapterDraftProposal?: unknown
  chapterDraftProposals?: readonly unknown[] | undefined
  appendedDraft?: unknown
  volumeChapterPlans?: readonly unknown[] | undefined
  arcPlanMarkdown?: string | undefined
  continueTurn?: boolean | undefined
  focusChange?: unknown
  choices?: readonly unknown[] | undefined
  presentationWrites?: readonly Readonly<{
    relativePath: string
    markdown: string
    mode: "create" | "update"
  }>[] | undefined
}>

/**
 * Strip jump-ahead writes when 作品风格.md is incomplete.
 * Pending presentationWrites to that path are overlaid before assessment.
 */
export function applyColdStartStyleGate<T extends ColdStartAssistSlice>(input: Readonly<{
  assist: T
  diskStyleMarkdown: string | undefined
}>): Readonly<{
  assist: T
  assessment: WorkStyleAssessment
  notices: readonly string[]
  blocked: boolean
}> {
  const overlay = overlayStyleFromWrites(input.diskStyleMarkdown, input.assist.presentationWrites)
  const assessment = assessWorkStyleMarkdown(overlay)
  if (assessment.complete) {
    return { assist: input.assist, assessment, notices: [], blocked: false }
  }

  const notices: string[] = [
    formatStyleIncompleteNotice(assessment),
  ]
  const {
    chapterDraftProposal: _d1,
    chapterDraftProposals: _d2,
    appendedDraft: _d3,
    volumeChapterPlans: _d4,
    arcPlanMarkdown: _d5,
    continueTurn: _d6,
    focusChange: _d7,
    ...rest
  } = input.assist

  const hadBlocked = input.assist.chapterDraftProposal !== undefined
    || (input.assist.chapterDraftProposals?.length ?? 0) > 0
    || input.assist.appendedDraft !== undefined
    || (input.assist.volumeChapterPlans?.length ?? 0) > 0
    || input.assist.arcPlanMarkdown !== undefined

  if (hadBlocked) {
    notices.push("本轮正文草稿 / 卷章规划 / 卷大纲写入已拦截；请先完成风格备选与落盘。")
  }

  const wroteStyle = (input.assist.presentationWrites ?? []).some((write) => {
    const path = write.relativePath.replaceAll("\\", "/").replace(/^\.\//u, "")
    return path === WORK_STYLE_RULE_PATH
  })
  const hasChoices = (input.assist.choices?.length ?? 0) > 0
  if (!wroteStyle && !hasChoices) {
    notices.push(
      "本轮须给出 2–3 套风格备选（choices），每套绑定一个已有 `表现输出/笔风规则/*.md`，并写清命名规则与对话方式。",
    )
  }

  return {
    assist: rest as T,
    assessment,
    notices,
    blocked: true,
  }
}

function overlayStyleFromWrites(
  disk: string | undefined,
  writes: ColdStartAssistSlice["presentationWrites"],
): string | undefined {
  if (writes === undefined || writes.length === 0) return disk
  for (let index = writes.length - 1; index >= 0; index -= 1) {
    const write = writes[index]
    if (write === undefined) continue
    const path = write.relativePath.replaceAll("\\", "/").replace(/^\.\//u, "")
    if (path === WORK_STYLE_RULE_PATH) return write.markdown
  }
  return disk
}

function formatStyleIncompleteNotice(assessment: WorkStyleAssessment): string {
  const bits: string[] = ["【开书冷启动】`表现输出/本作品描写/作品风格.md` 尚未合格。"]
  if (!assessment.exists) {
    bits.push("文件不存在或为空。")
  }
  if (assessment.missingHeadings.length > 0) {
    bits.push(`缺节：${assessment.missingHeadings.join("、")}。`)
  }
  if (assessment.pendingHeadings.length > 0) {
    bits.push(`仍为「待定」：${assessment.pendingHeadings.join("、")}。`)
  }
  if (assessment.weakHeadings.length > 0) {
    bits.push(
      `实质不足（须绑笔风路径、命名正反例、人称类型、对话系统等）：${assessment.weakHeadings.join("、")}。`,
    )
  }
  bits.push(
    "请先给出 2–3 套风格备选（choices，每套=一个可下拉笔风），选定后用 presentationWrites 写满 8 维正向定义，再写卷大纲。",
  )
  return bits.join("")
}
