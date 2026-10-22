import type {
  SynopsisConversationMessage,
  SynopsisConversationStreamSnapshot,
} from "@worldseed/contracts"

import { normalizeThinkingDisplayText } from "./synopsis-thinking-text.js"

/** True when the live stream has anything worth keeping as a chat bubble. */
export function streamHasVisibleProgress(
  peek: Readonly<Pick<
    SynopsisConversationStreamSnapshot,
    "thinking" | "thinkingRounds" | "content" | "searching" | "editing" | "toolRuns" | "todos"
  >>,
): boolean {
  if (peek.thinking.trim().length > 0) return true
  if (peek.content.trim().length > 0) return true
  if (peek.thinkingRounds.some((round) => round.text.trim().length > 0)) return true
  if (peek.searching.length > 0) return true
  if (peek.editing.length > 0) return true
  if (peek.toolRuns.length > 0) return true
  if (peek.todos.length > 0) return true
  return false
}

/**
 * Build the assistant fields to persist when a discuss turn errors or is stopped.
 * Keeps thinking / tool / todo metadata so the UI does not go blank.
 */
export function buildInterruptedAssistantMessageFields(
  peek: SynopsisConversationStreamSnapshot,
  errorLabel: string,
): Readonly<{
  content: string
  reasoningContent?: string
  thinkingRounds?: SynopsisConversationMessage["thinkingRounds"]
  searching?: SynopsisConversationMessage["searching"]
  editing?: SynopsisConversationMessage["editing"]
  toolRuns?: SynopsisConversationMessage["toolRuns"]
  todos?: SynopsisConversationMessage["todos"]
  error: string
}> {
  const content = interruptedAssistantContent(peek)
  const thinking = normalizeThinkingDisplayText(
    peek.thinking.length === 0 ? undefined : peek.thinking,
  )
  return {
    content,
    ...(thinking === undefined ? {} : { reasoningContent: thinking }),
    ...(peek.thinkingRounds.length === 0 ? {} : { thinkingRounds: peek.thinkingRounds }),
    ...(peek.searching.length === 0 ? {} : { searching: peek.searching }),
    ...(peek.editing.length === 0 ? {} : { editing: peek.editing }),
    ...(peek.toolRuns.length === 0 ? {} : { toolRuns: peek.toolRuns }),
    ...(peek.todos.length === 0 ? {} : { todos: peek.todos }),
    error: errorLabel.trim().length === 0 ? "本轮未完成" : errorLabel.trim(),
  }
}

function interruptedAssistantContent(peek: SynopsisConversationStreamSnapshot): string {
  const raw = peek.content.trim()
  if (raw.length === 0) return "（本轮回复未完成）"
  const extracted = extractAssistantMessageField(raw)
  if (extracted !== undefined && extracted.trim().length > 0) return extracted.trim()
  if (raw.startsWith("{")) return "（本轮回复未完成，结构化输出中断）"
  return raw
}

function extractAssistantMessageField(raw: string): string | undefined {
  const match = raw.match(/"assistantMessage"\s*:\s*"((?:\\.|[^"\\])*)"/u)
  if (match?.[1] === undefined) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
  }
}
