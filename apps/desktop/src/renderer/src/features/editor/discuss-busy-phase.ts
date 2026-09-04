import type { SynopsisConversationStreamSnapshot } from "@worldseed/contracts"

/** Creation-desk discuss busy phase while synopsis.conversation.send is in flight. */
export type DiscussBusyPhase = "idle" | "generating" | "previewing" | "finalizing"

export function resolveDiscussBusyPhase(input: Readonly<{
  busy: boolean
  streamStatus: SynopsisConversationStreamSnapshot["status"] | undefined
  hasPreviewContent: boolean
}>): DiscussBusyPhase {
  if (!input.busy) return "idle"
  if (input.streamStatus === "completed" || input.streamStatus === "failed") return "finalizing"
  if (input.hasPreviewContent) return "previewing"
  return "generating"
}

export function discussBusyPhaseLabel(phase: DiscussBusyPhase): string | undefined {
  if (phase === "generating") return "讨论进行中 · 生成回复"
  if (phase === "previewing") return "讨论进行中 · 预览未定稿，仍可停止"
  if (phase === "finalizing") return "回复已就绪 · 正在写入文件与消息"
  return undefined
}

export function discussFinalOutputHeader(phase: DiscussBusyPhase, streaming: boolean): string {
  if (streaming && phase === "previewing") return "正式输出（生成中）"
  if (streaming && phase === "finalizing") return "正式输出（写入中）"
  if (streaming && phase === "generating") return "正式输出（生成中）"
  return "正式输出"
}
