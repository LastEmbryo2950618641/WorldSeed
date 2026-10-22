import type { DiscussAgentMode } from "@worldseed/contracts"

export function discussAgentModePromptAppendix(mode: DiscussAgentMode): string {
  if (mode === "plan") {
    return [
      "【讨论模式=Plan】本轮只做规划与讨论：可 request_read / list / memory_write / 说明步骤与风险；",
      "禁止写入 synopsisBody/outlineBody/bodyEdits/stagingDelta/presentationWrites/chapterDraftProposal，",
      "禁止 invoke chapter_workflow / publish_draft / restage_chapter / bash 修改类操作；",
      "须先 todo_write 建本轮计划清单，再展开说明（Claude Code 风格）。",
    ].join("")
  }
  if (mode === "accept_edits") {
    return [
      "【讨论模式=Accept edits】用户已授权自动接受文件写入：需要落盘时直接执行，",
      "不要反复询问「是否写入」；仍须遵守工作区 bash 与正式正文/图治理专用通道；",
      "可执行任务须先 todo_write 建清单并随进度更新 status；全部项 completed/cancelled 后才能结束回合；",
      "换章用 focusChange 直接切焦点，勿用 set_focus 按钮索要确认；偏好/纠错用 memory_write。",
      AUTO_CONTINUE_RULE,
      "只有真正需要用户取舍（内容方向冲突）时才停并给 choices。",
    ].join("")
  }
  return [
    "【讨论模式=Auto】按创作台工作流自主选择工具与写入；",
    "用户每条可执行指令须先 todo_write 建 Claude Code 风格清单，再 request_read/bash/章节工具；推进中更新 status；",
    "Todo 由你全权维护：未把全部项标为 completed/cancelled 前禁止结束回合（除非 continueTurn=true）；",
    "当前章做完需进入下一章时直接输出 focusChange，不要停下来让用户点「是否换焦点」；",
    "用户说「记住…」或确认纠错/偏好时用 memory_write 更新 Agent记忆。",
    AUTO_CONTINUE_RULE,
    AUTO_SELF_DECIDE_RULE,
  ].join("")
}

/** Auto overrides every "ask the user via choices first" instruction elsewhere in the prompt. */
const AUTO_SELF_DECIDE_RULE = [
  "【Auto 自决·优先级高于其它征询类规则】用户选了 Auto，即授权你替他做所有确认与取舍：",
  "凡其它规则/输入（如 titleAlignmentIssue.remediation、梗概确认、confirm_synopsis、岔路选项）要求「先用 choices 征询用户」的，一律改为你自行决定并直接执行：",
  "标题分叉直接输出推荐的 titleAlignTarget；梗概无需等用户确认，可直接写细纲；多个可补的缺口按章节顺序依次自行补齐；",
  "在 assistantMessage 里用一两句说明你的取舍理由即可。Auto 下不要输出需要用户点选才能继续的 choices。",
].join("")

const AUTO_CONTINUE_RULE = [
  "多章/多步任务（如逐章写草稿→publish_draft 发布→下一章）一轮做不完时：本轮交付当前章的结果，",
  "并在 artifact 里设 continueTurn=true，系统会自动续跑下一轮；未完成的 Todo 保留 pending 即可。",
  "不要用 choices 询问「是否继续/先做哪个」来停下等用户。",
  "任务全部完成时不要设 continueTurn。",
].join("")
