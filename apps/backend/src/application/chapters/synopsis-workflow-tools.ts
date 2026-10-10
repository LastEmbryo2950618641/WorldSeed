import type { ChapterNarrativeIntent, ProjectId, VisibleModelContextMessage } from "@worldseed/contracts"
import type { AIModelPort } from "../turns/ports/ai-model-port.js"

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

export type SynopsisWorkflowToolInput = SynopsisToolContext & Readonly<{ userInput: string; heading?: string }>
export type SynopsisWorkflowToolResult = Readonly<{
  revisionTaskId: string
  chapterId: string
  draftVersionId: string
  draftLabel: string
  heading: string
  body: string
  summary?: string
}>
export type SynopsisPublishDraftInput = SynopsisToolContext & Readonly<{ revisionTaskId: string; draftVersionId: string }>
export type SynopsisPublishDraftResult = Readonly<{
  revisionTaskId: string
  chapterId: string
  draftVersionId: string
  status: string
  summary?: string
}>
export type SynopsisWorkflowToolCallbacks = Readonly<{
  executeWorkflowTool?: (input: SynopsisWorkflowToolInput) => Promise<SynopsisWorkflowToolResult>
  publishDraft?: (input: SynopsisPublishDraftInput) => Promise<SynopsisPublishDraftResult>
}>
export type SynopsisToolName = "chapter_workflow" | "publish_draft"
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
    parameters: { userInput: "string (required)", heading: "string (optional)" },
    writingGuide: "userInput 写清本章事件、人物动机、因果与信息边界、场景起止、预期结局和要改进之处；参考已有梗概/细纲及证据，可加入草稿反馈。heading 为本章标题。只生成当前焦点章的新草稿，不修订图、不发布正文；可多次调用比较版本。无需已有正式正文。",
  },
  publish_draft: {
    parameters: { revisionTaskId: "string (required)", draftVersionId: "string (required)" },
    writingGuide: "从草稿结果或本说明的 drafts 中选择明确版本，不能用 latest 代替 ID。可自主提交发布，不必额外请求玩家确认。统一图修订提交管线先同步图，成功后才发布正文；status=graph_sync_pending 仅表示正在同步，不能声称已发布成功。",
  },
} as const

export function synopsisToolCatalog(callbacks: SynopsisWorkflowToolCallbacks): string {
  return JSON.stringify({
    protocol,
    instruction: "按需使用 artifact.toolRequest；先 action=describe 获取参数格式与撰写说明，再 action=invoke。arguments 为 JSON 字符串。工具结果回灌后继续讨论，可重复调用。每次请求只带 assistantMessage、finalSelfReview 和 toolRequest。目标锁定本轮捕获的 chapterSequence。",
    tools: [
      ...(callbacks.executeWorkflowTool === undefined ? [] : [{ name: "chapter_workflow", displayName: "流程推理工具", definition: "执行完整章节流程推理并生成草稿。", scenario: "初次撰写、推进情节、根据反馈重新推演。" }]),
      ...(callbacks.publishDraft === undefined ? [] : [{ name: "publish_draft", definition: "发布指定草稿版本。", scenario: "选定草稿后，通过统一图修订管线提交正文。" }]),
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
    const available = request.name === "chapter_workflow" ? callbacks.executeWorkflowTool : callbacks.publishDraft
    if (available === undefined) return { ...envelope, status: "error", code: "tool_unavailable", message: "该工具当前不可用" }
    if (request.action === "describe") {
      return { ...envelope, status: "described", ...descriptions[request.name],
        ...(request.name === "publish_draft" ? { drafts: await input.listDrafts() } : {}) }
    }
    if (!hasVisibleToolDescription(input.visibleMessages, request.name)) {
      return { ...envelope, status: "error", code: "describe_required", message: "请先 describe 获取参数格式与撰写说明，再 invoke" }
    }
    if (request.name === "chapter_workflow") {
      const args = parseArguments(request.arguments, ["userInput", "heading"])
      const result = await callbacks.executeWorkflowTool!({
        ...context, userInput: requiredText(args, "userInput"),
        ...(args.heading === undefined ? {} : { heading: requiredText(args, "heading") }),
      })
      context.signal?.throwIfAborted()
      return { ...envelope, status: "draft_created", result }
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
