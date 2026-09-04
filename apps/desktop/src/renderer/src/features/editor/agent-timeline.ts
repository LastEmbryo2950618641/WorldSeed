import type {
  SynopsisConversationMessage,
  SynopsisConversationStreamEdit,
  SynopsisConversationStreamSearch,
  SynopsisConversationStreamSnapshot,
  SynopsisConversationThinkingRound,
} from "@worldseed/contracts"

export type AgentTimelineSegment =
  | Readonly<{ kind: "thinking"; round: number; text: string }>
  | Readonly<{ kind: "searching"; round: number; items: readonly SynopsisConversationStreamSearch[] }>
  | Readonly<{ kind: "editing"; items: readonly SynopsisConversationStreamEdit[] }>
  | Readonly<{ kind: "final"; content: string }>

type TimelineSource = Readonly<{
  thinking?: string | undefined
  thinkingRounds?: readonly SynopsisConversationThinkingRound[] | undefined
  searching?: readonly SynopsisConversationStreamSearch[] | undefined
  editing?: readonly SynopsisConversationStreamEdit[] | undefined
  content?: string | undefined
  /** When false, omit bootstrap (round 0) searches. Default true = hide. */
  hideBootstrapSearches?: boolean
}>

/** Build ordered ReAct segments for live stream or persisted assistant message. */
export function toAgentTimeline(source: TimelineSource): AgentTimelineSegment[] {
  const hideBootstrap = source.hideBootstrapSearches !== false
  const searching = (source.searching ?? []).filter((item) => (
    !hideBootstrap || item.round !== 0
  ))
  const editing = source.editing ?? []
  const content = source.content?.trim() ?? ""
  const rounds = resolveThinkingRounds(source)
  const hasRoundMeta = rounds.length > 0
    || searching.some((item) => item.round !== undefined)

  if (!hasRoundMeta) {
    return buildFlatTimeline({
      thinking: source.thinking,
      searching,
      editing,
      content,
    })
  }

  const segments: AgentTimelineSegment[] = []
  const roundIds = collectRoundIds(rounds, searching)
  for (const round of roundIds) {
    const thinking = rounds.find((item) => item.round === round)
    if (thinking !== undefined && thinking.text.trim().length > 0) {
      segments.push({ kind: "thinking", round, text: thinking.text })
    }
    const items = searching.filter((item) => (item.round ?? -1) === round)
    if (items.length > 0) {
      segments.push({ kind: "searching", round, items })
    }
  }

  // Searches without round (legacy mixed into round-aware messages)
  const unscoped = searching.filter((item) => item.round === undefined)
  if (unscoped.length > 0) {
    segments.push({ kind: "searching", round: -1, items: unscoped })
  }

  if (editing.length > 0) {
    segments.push({ kind: "editing", items: editing })
  }
  if (content.length > 0) {
    segments.push({ kind: "final", content })
  }
  return segments
}

export function timelineFromStream(
  stream: SynopsisConversationStreamSnapshot,
  options?: Readonly<{ hideBootstrapSearches?: boolean }>,
): AgentTimelineSegment[] {
  return toAgentTimeline({
    thinking: stream.thinking,
    thinkingRounds: stream.thinkingRounds,
    searching: stream.searching,
    editing: stream.editing,
    content: stream.content,
    ...(options?.hideBootstrapSearches === undefined
      ? {}
      : { hideBootstrapSearches: options.hideBootstrapSearches }),
  })
}

export function timelineFromMessage(
  message: SynopsisConversationMessage,
  options?: Readonly<{ hideBootstrapSearches?: boolean }>,
): AgentTimelineSegment[] {
  return toAgentTimeline({
    thinking: message.reasoningContent,
    thinkingRounds: message.thinkingRounds,
    searching: message.searching,
    editing: message.editing,
    content: message.content,
    ...(options?.hideBootstrapSearches === undefined
      ? {}
      : { hideBootstrapSearches: options.hideBootstrapSearches }),
  })
}

function resolveThinkingRounds(source: TimelineSource): SynopsisConversationThinkingRound[] {
  if (source.thinkingRounds !== undefined && source.thinkingRounds.length > 0) {
    return source.thinkingRounds
      .filter((item) => item.text.trim().length > 0)
      .map((item) => ({ round: item.round, text: item.text }))
  }
  const thinking = source.thinking?.trim()
  if (thinking === undefined || thinking.length === 0) return []
  return [{ round: 1, text: thinking }]
}

function collectRoundIds(
  rounds: readonly SynopsisConversationThinkingRound[],
  searching: readonly SynopsisConversationStreamSearch[],
): number[] {
  const ids = new Set<number>()
  for (const item of rounds) ids.add(item.round)
  for (const item of searching) {
    if (item.round !== undefined && item.round !== 0) ids.add(item.round)
  }
  return [...ids].sort((a, b) => a - b)
}

function buildFlatTimeline(input: Readonly<{
  thinking?: string | undefined
  searching: readonly SynopsisConversationStreamSearch[]
  editing: readonly SynopsisConversationStreamEdit[]
  content: string
}>): AgentTimelineSegment[] {
  const segments: AgentTimelineSegment[] = []
  const thinking = input.thinking?.trim()
  if (thinking !== undefined && thinking.length > 0) {
    segments.push({ kind: "thinking", round: 1, text: thinking })
  }
  if (input.searching.length > 0) {
    segments.push({ kind: "searching", round: 1, items: input.searching })
  }
  if (input.editing.length > 0) {
    segments.push({ kind: "editing", items: input.editing })
  }
  if (input.content.length > 0) {
    segments.push({ kind: "final", content: input.content })
  }
  return segments
}
