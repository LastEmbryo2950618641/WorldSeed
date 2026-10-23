import type {
  ChapterNarrativeIntent,
  ProjectId,
  SynopsisConversationTodo,
  VisibleModelContextMessage,
} from "@worldseed/contracts"
import type { AIModelPort } from "../turns/ports/ai-model-port.js"
import type { SynopsisBashResult } from "./synopsis-host-bash.js"

export type SynopsisToolContext = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  sessionId: string
  chapterSequence: number
  model: AIModelPort
  chapterIntent?: ChapterNarrativeIntent
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
    minimumWordCount: number
    maximumWordCount: number
  }>
  maxModelCalls?: number
  deadlineMs?: number
  signal?: AbortSignal
}>

export type SynopsisWorkflowToolInput = SynopsisToolContext & Readonly<{
  userInput: string
  heading?: string
  /** When set, generate drafts for these chapters (one model turn pipeline per chapter; results returned together). */
  chapterSequences?: readonly number[]
}>
export type SynopsisWorkflowToolResult = Readonly<{
  revisionTaskId: string
  chapterId: string
  draftVersionId: string
  draftLabel: string
  heading: string
  body: string
  summary?: string
  chapterSequence?: number
  drafts?: readonly Readonly<{
    revisionTaskId: string
    chapterId: string
    draftVersionId: string
    draftLabel: string
    heading: string
    body: string
    chapterSequence: number
  }>[]
}>
export type SynopsisPublishDraftInput = SynopsisToolContext & Readonly<{ revisionTaskId: string; draftVersionId: string }>
export type SynopsisPublishDraftResult = Readonly<{
  revisionTaskId: string
  chapterId: string
  draftVersionId: string
  status: string
  summary?: string
}>
export type SynopsisRestageInput = SynopsisToolContext & Readonly<{
  targetStage: "synopsis" | "outline"
  reason: string
}>
export type SynopsisRestageResult = Readonly<{
  chapterSequence: number
  targetStage: "synopsis" | "outline"
  reason: string
  synopsisConfirmedCleared: boolean
  clearedOutlinePath?: string
  archivedBodyPath?: string
  retiredBodyPath?: string
  focusKind: "plot_synopsis" | "plot_outline"
  synopsisPath?: string
  outlinePath?: string
}>
export type SynopsisBashInput = SynopsisToolContext & Readonly<{
  command: string
  cwd?: string
  timeoutMs?: number
}>
export type SynopsisTodoWriteInput = SynopsisToolContext & Readonly<{
  todos: readonly SynopsisConversationTodo[]
  merge?: boolean
}>
export type SynopsisTodoWriteResult = Readonly<{
  todos: readonly SynopsisConversationTodo[]
  merge: boolean
}>
export type SynopsisMemoryWriteInput = SynopsisToolContext & Readonly<{
  target: "index" | "topic"
  markdown: string
  /** Required when target=topic; basename or path under 世界推演规则/Agent记忆/ */
  filename?: string
}>
export type SynopsisMemoryWriteResult = Readonly<{
  relativePath: string
  target: "index" | "topic"
  truncated: boolean
  byteLength: number
}>
export type SynopsisLoadSkillInput = SynopsisToolContext & Readonly<{
  skillId: string
  includeReferences?: boolean
}>
export type SynopsisLoadSkillResult = Readonly<{
  skillId: string
  name: string
  includeReferences: boolean
  text: string
  digest: string
}>
export type SynopsisWorkflowToolCallbacks = Readonly<{
  executeWorkflowTool?: (input: SynopsisWorkflowToolInput) => Promise<SynopsisWorkflowToolResult>
  publishDraft?: (input: SynopsisPublishDraftInput) => Promise<SynopsisPublishDraftResult>
  restageChapter?: (input: SynopsisRestageInput) => Promise<SynopsisRestageResult>
  runBash?: (input: SynopsisBashInput) => Promise<SynopsisBashResult>
  writeTodos?: (input: SynopsisTodoWriteInput) => Promise<SynopsisTodoWriteResult>
  writeMemory?: (input: SynopsisMemoryWriteInput) => Promise<SynopsisMemoryWriteResult>
  loadSkill?: (input: SynopsisLoadSkillInput) => Promise<SynopsisLoadSkillResult>
}>
export type SynopsisToolName =
  | "chapter_workflow"
  | "publish_draft"
  | "restage_chapter"
  | "bash"
  | "todo_write"
  | "memory_write"
  | "load_skill"
export type SynopsisToolRequest = Readonly<{
  name: SynopsisToolName
  action: "describe" | "invoke"
  arguments?: string | undefined
}>
export type SynopsisDraftReference = Readonly<{
  revisionTaskId: string
  draftVersionId: string
  draftLabel: string
  heading: string
}>

const protocol = "synopsis-tools-v1"
const descriptions = {
  chapter_workflow: {
    parameters: {
      userInput: "string (required)",
      heading: "string (optional)",
      chapterSequences: "number[] (optional；批量时一次产出多章草稿)",
    },
    writingGuide: [
      "【正文推演工具】把情节推演成**草稿**（不是正式正文）。默认作用于焦点章。",
      "userInput 写清事件、人物动机、因果与信息边界、场景起止、预期结局和要改进之处；参考已有梗概/细纲及证据。heading 为标题（单章时）。",
      "批量：可传 chapterSequences（绝对章号数组），一次 invoke 为多章各生成草稿；勿在同轮 publish_draft。",
      "只追加草稿版本，不修订图、不覆盖正式正文；可多次调用比较草稿。",
      "若用户已提供完整正文、只需落库并图治理：不要调用本工具，改用 `chapterDraftProposal` / `chapterDraftProposals`，再图治理。",
      "工具可能因项目设置关闭而不可用；关闭时改用草稿提案字段。",
    ].join(""),
  },
  publish_draft: {
    parameters: { revisionTaskId: "string (required)", draftVersionId: "string (required)" },
    writingGuide: [
      "【图治理工具】把指定**草稿版本**经图治理管线转换为/覆盖为**正式正文**。",
      "必须从 drafts 或先前工具结果中选择明确 revisionTaskId+draftVersionId，不能用 latest。",
      "正式正文不存在独立「旧版本」轴：只有草稿可回退/比较；正文落盘前必须经过本工具。",
      "可自主提交，不必再请用户点确认。工具会等待图同步完成：status=completed 即已发布，可直接继续写/发布下一章；",
      "status 仍为 graph_sync_pending 表示同步未完成，不能声称已发布，也不要停下来请用户选择——系统会自动续跑。",
    ].join(""),
  },
  restage_chapter: {
    parameters: {
      targetStage: '"synopsis" | "outline" (required)',
      reason: "string (required)",
    },
    writingGuide: [
      "把当前焦点章的工作区表面回退到更早阶段，以便按新方向重写。",
      "targetStage=synopsis：清零梗概确认、删除本章细纲、把正式正文改名为「… [已回退].md」移出树表面；之后须重写 synopsisBody，再经用户 confirm_synopsis，再用 outlineBody；需要新正文时：要么正文推演工具生成草稿，要么 chapterDraftProposal 直接落用户正文为草稿，再图治理工具发布。",
      "targetStage=outline：仅归档正式正文，保留梗概与细纲；适合「细纲仍可用、只要重写正文」。",
      "reason 写清用户意图（如「第一章按新梗概重写，覆盖旧细纲与正文」）。",
      "不可改章节号；图/世界线历史 checkout 不在本工具范围内。调用后根据返回的 cleared/archived 路径再继续写入，不能假装旧细纲/正文仍是权威表面。",
    ].join(""),
  },
  bash: {
    parameters: {
      command: "string (required)",
      cwd: "string (optional, default=工作区根)",
      timeoutMs: "number (optional, default 30000, max 120000)",
    },
    writingGuide: [
      "【bash】在项目**工作区**内执行 shell（Windows 为 cmd；默认 cwd=工作区根）。",
      "硬约束：cwd 必须在工作区内；创建/修改/删除/重定向等变更只能落在工作区内。",
      "允许：从工作区外 copy/cp/robocopy 等**拷入**工作区后再改；只读列举/查看外部路径可以。",
      "读本机目录/正文：优先 request_read 绝对路径，不要先用 bash 硬闯含中文/全角标点/感叹号的路径。",
      "禁止：在工作区外落地修改；把正式正文发布、图治理、梗概确认等权威流程用 bash 冒充。",
      "失败时：把 exitCode/stderr 直接告诉用户，禁止默默改用工作区材料顶替本机路径内容。",
      "区分：工作区=整部项目根（含设定集/章节正文/大纲/暂存区等）；暂存区=工作区内的 `暂存区/` 中间态，不是设定集权威。",
      "command 为一条非交互命令；超长输出会被截断。详规见《创作台讨论工作流》。",
      "平台 skill 只读校验（需已知绝对路径）：scan-template-tells.mjs / scan-dialogue-pingpong.mjs（见 skill-script-whitelist）。",
    ].join(""),
  },
  todo_write: {
    parameters: {
      todos: 'Array<{ id: string, content: string, status: "pending"|"in_progress"|"completed"|"cancelled" }> (required)',
      merge: "boolean (optional, default false；true=按 id 合并更新，false=整表替换)",
    },
    writingGuide: [
      "【todo_write】Claude Code 风格任务清单（创作台 Todo 面板）。可执行任务必须先写再动手；你有完全写入权限。",
      "开局：merge=false 写入 ≥2 项真实步骤；将第一项标 in_progress。",
      "推进：merge=true 更新 status（完成→completed，下一步→in_progress）；同一时刻最多一个 in_progress。",
      "收尾（Auto/Accept edits）：结束前须把全部项标 completed 或 cancelled，否则系统会打回。",
      "禁止只在 assistantMessage 列步骤却不调用本工具；这不是设定集目标（deduction goals）。",
    ].join(""),
  },
  memory_write: {
    parameters: {
      target: '"index" | "topic" (required)',
      markdown: "string (required；整文件替换内容)",
      filename: "string (target=topic 时必填；如 preferences.md，落在 世界推演规则/Agent记忆/)",
    },
    writingGuide: [
      "【memory_write】Codex 风格跨回合 Agent 记忆。索引 MEMORY.md 启动时注入（前 200 行/25KB）；详情写主题文件。",
      "何时写：用户说「记住…」、确认纠错/偏好、或开放约定需跨会话保留时。",
      "target=index：替换 世界推演规则/Agent记忆/MEMORY.md（保持精炼索引+指向主题文件的链接）。",
      "target=topic：替换同目录下某 .md（filename 仅单层文件名）；索引里用一行摘要+路径引用。",
      "勿把整章设定/正文塞进记忆；设定权威仍在设定集。Plan 模式也可用本工具。",
    ].join(""),
  },
  load_skill: {
    parameters: {
      skillId: "string (required；见系统规则中的 Skill 索引)",
      includeReferences: "boolean (optional；true 时附带 references 长文，默认 false)",
    },
    writingGuide: [
      "【load_skill】按需加载平台写作/讨论 skill 全文（去味、对话、人味、情绪、工作流等）。",
      "系统规则只含短索引；默认阶段包可能已挂主 skill，仍缺细则时再 load。",
      "includeReferences=true 会明显增大上下文，仅在主正文不够用时开启。",
      "描写场面卡不在本工具：用 request_read + sourceKinds:[\"rule\"] 读 表现输出/描写规则/。",
    ].join(""),
  },
} as const

function callbackForTool(
  name: SynopsisToolName,
  callbacks: SynopsisWorkflowToolCallbacks,
): ((input: never) => Promise<unknown>) | undefined {
  if (name === "chapter_workflow") return callbacks.executeWorkflowTool as ((input: never) => Promise<unknown>) | undefined
  if (name === "publish_draft") return callbacks.publishDraft as ((input: never) => Promise<unknown>) | undefined
  if (name === "restage_chapter") return callbacks.restageChapter as ((input: never) => Promise<unknown>) | undefined
  if (name === "bash") return callbacks.runBash as ((input: never) => Promise<unknown>) | undefined
  if (name === "todo_write") return callbacks.writeTodos as ((input: never) => Promise<unknown>) | undefined
  if (name === "memory_write") return callbacks.writeMemory as ((input: never) => Promise<unknown>) | undefined
  if (name === "load_skill") return callbacks.loadSkill as ((input: never) => Promise<unknown>) | undefined
  return undefined
}

export function synopsisToolCatalog(callbacks: SynopsisWorkflowToolCallbacks): string {
  return JSON.stringify({
    protocol,
    instruction: [
      "按需使用 artifact.toolRequest；先 action=describe 再 action=invoke；arguments 为 JSON 字符串。",
      "工具与正文通道流程以《创作台讨论工作流》为准（系统规则已注入）；每次请求只带 assistantMessage、finalSelfReview、toolRequest；锁定本轮 chapterSequence。",
    ].join(""),
    tools: [
      ...(callbacks.executeWorkflowTool === undefined ? [] : [{
        name: "chapter_workflow",
        displayName: "正文推演工具",
        definition: "推演本章情节并生成/追加草稿，不写正式正文。",
        scenario: "需要 AI 新写或重推正文草稿时；用户已提供完整正文时不要用。",
      }]),
      ...(callbacks.publishDraft === undefined ? [] : [{
        name: "publish_draft",
        displayName: "图治理工具",
        definition: "将指定草稿版本经图治理转换为正式正文并覆盖工作区正文文件。",
        scenario: "已有满意草稿（推演生成或 chapterDraftProposal 导入）后发布为正式正文。",
      }]),
      ...(callbacks.restageChapter === undefined ? [] : [{
        name: "restage_chapter",
        displayName: "章节阶段回退",
        definition: "把本章工作区表面回退到梗概或细纲阶段，并归档正式正文（可选清除细纲）。",
        scenario: "用户要求从某章重写梗概并覆盖已有细纲/正文；或保留细纲只重写正文。",
      }]),
      ...(callbacks.runBash === undefined ? [] : [{
        name: "bash",
        displayName: "工作区 Bash",
        definition: "在项目工作区内执行 shell；可从外部拷贝进工作区，修改只能落在工作区。",
        scenario: "需要列目录、拷入外部资料、在工作区做脚本化整理时；正式正文/图治理仍走专用工具。",
      }]),
      ...(callbacks.writeTodos === undefined ? [] : [{
        name: "todo_write",
        displayName: "Todo 清单",
        definition: "写入/更新 Claude Code 风格任务清单，供创作台 Todo 面板展示。",
        scenario: "用户每条可执行指令开始时必须先调用；建清单后再读文件/bash/章节工具，并随进度更新 status。",
      }]),
      ...(callbacks.writeMemory === undefined ? [] : [{
        name: "memory_write",
        displayName: "Agent 记忆",
        definition: "写入跨讨论回合的 MEMORY.md 索引或主题记忆文件。",
        scenario: "用户要求记住偏好/纠错/约定，或需把稳定工作记忆落到 世界推演规则/Agent记忆/。",
      }]),
      ...(callbacks.loadSkill === undefined ? [] : [{
        name: "load_skill",
        displayName: "加载 Skill",
        definition: "按需注入平台 skill 正文（去味/对话/人味/情绪/讨论指南等）。",
        scenario: "索引不够、默认包未覆盖、或需要 references 细则时。",
      }]),
    ],
  })
}

// Only a currently visible, system-authored description grants invocation access.
// This survives turns and process restarts, but expires when evidence is compacted away.
export function hasVisibleToolDescription(messages: readonly VisibleModelContextMessage[], name: SynopsisToolName): boolean {
  return messages.some((message) => {
    if (message.role !== "system" || message.kind !== "phase_instruction") return false
    try {
      const result = JSON.parse(message.content) as Record<string, unknown>
      return result.protocol === protocol && result.name === name
        && result.action === "describe" && result.status === "described"
    } catch {
      return false
    }
  })
}

function parseArguments(raw: string | undefined, keys: readonly string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(raw ?? "{}")
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("arguments 必须为 JSON 对象")
  const args = value as Record<string, unknown>
  if (Object.keys(args).some((key) => !keys.includes(key))) throw new Error("arguments 含未披露参数；不能覆盖章节、模型或项目")
  return args
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} 必须为非空字符串`)
  return value.trim()
}

/** File body: non-empty after trim, but preserve intentional trailing newlines. */
function requiredMarkdownBody(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} 必须为非空字符串`)
  return value.replaceAll("\r\n", "\n")
}

function requiredTargetStage(args: Record<string, unknown>): "synopsis" | "outline" {
  const value = args.targetStage
  if (value !== "synopsis" && value !== "outline") {
    throw new Error("targetStage 必须为 \"synopsis\" 或 \"outline\"")
  }
  return value
}

function requiredBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key]
  if (typeof value !== "boolean") throw new Error(`${key} 必须为布尔值`)
  return value
}

function optionalPositiveIntArray(value: unknown): readonly number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("chapterSequences 必须为非空正整数数组")
  }
  const sequences: number[] = []
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1) {
      throw new Error("chapterSequences 每项必须为正整数")
    }
    sequences.push(item)
  }
  return sequences
}

function requiredTodos(raw: unknown): SynopsisConversationTodo[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("todos 必须为非空数组")
  const todos: SynopsisConversationTodo[] = []
  const seen = new Set<string>()
  let inProgress = 0
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("todos 每项必须为对象")
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id.trim() : ""
    const content = typeof record.content === "string" ? record.content.trim() : ""
    const status = record.status
    if (id.length === 0 || content.length === 0) throw new Error("todos.id/content 不能为空")
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") {
      throw new Error("todos.status 非法")
    }
    if (seen.has(id)) throw new Error(`todos.id 重复：${id}`)
    seen.add(id)
    if (status === "in_progress") inProgress += 1
    todos.push({ id, content, status })
  }
  if (inProgress > 1) throw new Error("同一时刻最多一个 in_progress todo")
  return todos
}

export async function executeSynopsisTool(input: Readonly<{
  request: SynopsisToolRequest
  context: SynopsisToolContext
  callbacks: SynopsisWorkflowToolCallbacks
  visibleMessages: readonly VisibleModelContextMessage[]
  listDrafts: () => Promise<readonly SynopsisDraftReference[]>
}>): Promise<Record<string, unknown>> {
  const { request, context, callbacks } = input
  const envelope = { protocol, name: request.name, action: request.action, chapterSequence: context.chapterSequence }
  context.signal?.throwIfAborted()
  try {
    const available = callbackForTool(request.name, callbacks)
    if (available === undefined) {
      const message = request.name === "chapter_workflow"
        ? "正文推演工具未启用：请在项目设置中开启「正文推演工具」，或改用 chapterDraftProposal / chapterDraftProposals 写草稿"
        : "该工具当前不可用"
      return { ...envelope, status: "error", code: "tool_unavailable", message }
    }
    if (request.action === "describe") {
      return { ...envelope, status: "described", ...descriptions[request.name],
        ...(request.name === "publish_draft" ? { drafts: await input.listDrafts() } : {}) }
    }
    if (!hasVisibleToolDescription(input.visibleMessages, request.name)) {
      return { ...envelope, status: "error", code: "describe_required", message: "请先 describe 获取参数格式与撰写说明，再 invoke" }
    }
    if (request.name === "chapter_workflow") {
      const args = parseArguments(request.arguments, ["userInput", "heading", "chapterSequences"])
      const chapterSequences = optionalPositiveIntArray(args.chapterSequences)
      const result = await callbacks.executeWorkflowTool!({
        ...context,
        userInput: requiredText(args, "userInput"),
        ...(args.heading === undefined ? {} : { heading: requiredText(args, "heading") }),
        ...(chapterSequences === undefined ? {} : { chapterSequences }),
      })
      context.signal?.throwIfAborted()
      const multi = result.drafts !== undefined && result.drafts.length > 1
      return {
        ...envelope,
        status: multi ? "drafts_created" : "draft_created",
        result,
        ...(multi ? { chapterCount: result.drafts!.length } : {}),
      }
    }
    if (request.name === "restage_chapter") {
      const args = parseArguments(request.arguments, ["targetStage", "reason"])
      const result = await callbacks.restageChapter!({
        ...context,
        targetStage: requiredTargetStage(args),
        reason: requiredText(args, "reason"),
      })
      context.signal?.throwIfAborted()
      return { ...envelope, status: "restaged", result }
    }
    if (request.name === "bash") {
      const args = parseArguments(request.arguments, ["command", "cwd", "timeoutMs"])
      const timeoutRaw = args.timeoutMs
      const timeoutMs = timeoutRaw === undefined
        ? undefined
        : (typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
          ? Math.trunc(timeoutRaw)
          : (() => { throw new Error("timeoutMs 必须为数字") })())
      const result = await callbacks.runBash!({
        ...context,
        command: requiredText(args, "command"),
        ...(args.cwd === undefined ? {} : { cwd: requiredText(args, "cwd") }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      context.signal?.throwIfAborted()
      return { ...envelope, status: "bash_completed", result }
    }
    if (request.name === "todo_write") {
      const args = parseArguments(request.arguments, ["todos", "merge"])
      const todos = requiredTodos(args.todos)
      const merge = args.merge === undefined ? false : requiredBoolean(args, "merge")
      const result = await callbacks.writeTodos!({
        ...context,
        todos,
        merge,
      })
      context.signal?.throwIfAborted()
      return { ...envelope, status: "todos_updated", result }
    }
    if (request.name === "memory_write") {
      const args = parseArguments(request.arguments, ["target", "markdown", "filename"])
      const target = args.target
      if (target !== "index" && target !== "topic") {
        throw new Error('target 必须为 "index" 或 "topic"')
      }
      const markdown = requiredMarkdownBody(args, "markdown")
      const filename = args.filename === undefined ? undefined : requiredText(args, "filename")
      if (target === "topic" && filename === undefined) {
        throw new Error("target=topic 时必须提供 filename")
      }
      const result = await callbacks.writeMemory!({
        ...context,
        target,
        markdown,
        ...(filename === undefined ? {} : { filename }),
      })
      context.signal?.throwIfAborted()
      return { ...envelope, status: "memory_written", result }
    }
    if (request.name === "load_skill") {
      const args = parseArguments(request.arguments, ["skillId", "includeReferences"])
      const skillId = requiredText(args, "skillId")
      const includeReferences = args.includeReferences === undefined
        ? false
        : requiredBoolean(args, "includeReferences")
      const result = await callbacks.loadSkill!({
        ...context,
        skillId,
        includeReferences,
      })
      context.signal?.throwIfAborted()
      return {
        ...envelope,
        status: "skill_loaded",
        protocol: "synopsis-skills-v1",
        skillId: result.skillId,
        result,
      }
    }
    const args = parseArguments(request.arguments, ["revisionTaskId", "draftVersionId"])
    const revisionTaskId = requiredText(args, "revisionTaskId")
    const draftVersionId = requiredText(args, "draftVersionId")
    const drafts = await input.listDrafts()
    if (!drafts.some((draft) => draft.revisionTaskId === revisionTaskId && draft.draftVersionId === draftVersionId)) {
      return { ...envelope, status: "error", code: "draft_not_in_focus", message: "指定草稿不属于当前捕获的焦点章，请 describe 获取本章版本" }
    }
    context.signal?.throwIfAborted()
    const result = await callbacks.publishDraft!({ ...context, revisionTaskId, draftVersionId })
    context.signal?.throwIfAborted()
    return { ...envelope, status: "publication_submitted", result }
  } catch (error) {
    context.signal?.throwIfAborted()
    return { ...envelope, status: "error", code: "tool_failed", message: error instanceof Error ? error.message : String(error) }
  }
}
