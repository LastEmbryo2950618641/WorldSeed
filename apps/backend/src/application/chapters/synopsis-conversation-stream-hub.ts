import type {
  SynopsisConversationStreamEdit,
  SynopsisConversationStreamRun,
  SynopsisConversationStreamSearch,
  SynopsisConversationStreamSnapshot,
  SynopsisConversationStreamUsage,
  SynopsisConversationThinkingRound,
  SynopsisConversationTodo,
} from "@worldseed/contracts"

type MutableSearch = {
  query: string
  status: SynopsisConversationStreamSearch["status"]
  resultSummary?: string | undefined
  asOfChapterSequence?: number | undefined
  temporalRole?: "as_of" | "current" | undefined
  round?: number | undefined
}

type MutableEdit = {
  path: string
  kind: SynopsisConversationStreamEdit["kind"]
  status: SynopsisConversationStreamEdit["status"]
  summary?: string | undefined
  opsApplied?: number | undefined
  opsAttempted?: number | undefined
}

type MutableRun = {
  runId: string
  name: string
  action: SynopsisConversationStreamRun["action"]
  arguments?: string | undefined
  status: SynopsisConversationStreamRun["status"]
  resultSummary?: string | undefined
  round?: number | undefined
}

type MutableThinkingRound = {
  round: number
  text: string
}

type MutableUsage = {
  inputTokens: number
  outputTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
  lastRequestInputTokens?: number
}

type MutableSnapshot = {
  sessionId?: string
  projectId?: string
  status: SynopsisConversationStreamSnapshot["status"]
  thinking: string
  thinkingRounds: MutableThinkingRound[]
  currentThinkingRound?: number
  content: string
  searching: MutableSearch[]
  editing: MutableEdit[]
  toolRuns: MutableRun[]
  todos: SynopsisConversationTodo[]
  /** Unfinished todos inherited from the previous send of the same session. */
  carriedTodoIds: Set<string>
  /** Per-turn usage while a send is running. */
  usage: MutableUsage
  error?: string
  updatedAtMs: number
}

function emptyUsage(): MutableUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
  }
}

function addUsageInto(
  target: MutableUsage,
  usage: Readonly<{
    inputTokens?: number
    outputTokens?: number
    cacheHitInputTokens?: number
    cacheMissInputTokens?: number
    lastRequestInputTokens?: number
  }>,
): void {
  if (typeof usage.inputTokens === "number") target.inputTokens += usage.inputTokens
  if (typeof usage.outputTokens === "number") target.outputTokens += usage.outputTokens
  if (typeof usage.cacheHitInputTokens === "number") {
    target.cacheHitInputTokens += usage.cacheHitInputTokens
  }
  if (typeof usage.cacheMissInputTokens === "number") {
    target.cacheMissInputTokens += usage.cacheMissInputTokens
  }
  if (typeof usage.lastRequestInputTokens === "number") {
    target.lastRequestInputTokens = usage.lastRequestInputTokens
  }
}

function mapEditing(items: readonly MutableEdit[]): SynopsisConversationStreamEdit[] {
  return items.map((item) => ({
    path: item.path,
    kind: item.kind,
    status: item.status,
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.opsApplied === undefined ? {} : { opsApplied: item.opsApplied }),
    ...(item.opsAttempted === undefined ? {} : { opsAttempted: item.opsAttempted }),
  }))
}

function mapSearching(items: readonly MutableSearch[]): SynopsisConversationStreamSearch[] {
  return items.map((item) => ({
    query: item.query,
    status: item.status,
    ...(item.resultSummary === undefined ? {} : { resultSummary: item.resultSummary }),
    ...(item.asOfChapterSequence === undefined ? {} : { asOfChapterSequence: item.asOfChapterSequence }),
    ...(item.temporalRole === undefined ? {} : { temporalRole: item.temporalRole }),
    ...(item.round === undefined ? {} : { round: item.round }),
  }))
}

function mapToolRuns(items: readonly MutableRun[]): SynopsisConversationStreamRun[] {
  return items.map((item) => ({
    runId: item.runId,
    name: item.name,
    action: item.action,
    status: item.status,
    ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
    ...(item.resultSummary === undefined ? {} : { resultSummary: item.resultSummary }),
    ...(item.round === undefined ? {} : { round: item.round }),
  }))
}

function mapThinkingRounds(items: readonly MutableThinkingRound[]): SynopsisConversationThinkingRound[] {
  return items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => ({ round: item.round, text: item.text }))
}

function searchKey(item: Readonly<{ query: string; round?: number | undefined }>): string {
  return `${String(item.round ?? -1)}\0${item.query}`
}

/**
 * In-process synopsis discuss stream state for concurrent peek polling while send runs.
 * Cumulative usage survives turn clear so the UI can keep showing token metrics.
 */
export class SynopsisConversationStreamHub {
  private readonly byProject = new Map<string, MutableSnapshot>()
  private readonly cumulativeUsageByProject = new Map<string, MutableUsage>()

  public begin(projectId: string, sessionId: string, nowMs: number): void {
    this.ensureCumulative(projectId)
    // Multi-turn work (Auto continuation, choice replies) must not lose the open plan between sends.
    const previous = this.byProject.get(projectId)
    const carried = previous?.sessionId === sessionId
      ? previous.todos
        .filter((item) => item.status === "pending" || item.status === "in_progress")
        .map((item) => ({ ...item }))
      : []
    this.byProject.set(projectId, {
      sessionId,
      projectId,
      status: "running",
      thinking: "",
      thinkingRounds: [],
      content: "",
      searching: [],
      editing: [],
      toolRuns: [],
      todos: carried,
      carriedTodoIds: new Set(carried.map((item) => item.id)),
      usage: emptyUsage(),
      updatedAtMs: nowMs,
    })
  }

  /** Open todos carried into the current send from the previous one (same session). */
  public carriedTodos(projectId: string): readonly SynopsisConversationTodo[] {
    const current = this.byProject.get(projectId)
    if (current === undefined) return []
    return current.todos.filter((item) => current.carriedTodoIds.has(item.id))
  }

  public addUsage(
    projectId: string,
    usage: Readonly<{
      inputTokens?: number
      outputTokens?: number
      cacheHitInputTokens?: number
      cacheMissInputTokens?: number
      lastRequestInputTokens?: number
    }>,
    nowMs: number,
  ): void {
    const cumulative = this.ensureCumulative(projectId)
    addUsageInto(cumulative, usage)
    const current = this.byProject.get(projectId)
    if (current === undefined) return
    addUsageInto(current.usage, usage)
    current.updatedAtMs = nowMs
  }

  /** Start (or switch to) a thinking slice for this ReAct model attempt. */
  public beginThinkingRound(projectId: string, round: number, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    if (current.status !== "running") return
    current.currentThinkingRound = round
    const existing = current.thinkingRounds.find((item) => item.round === round)
    if (existing === undefined) {
      current.thinkingRounds.push({ round, text: "" })
    }
    current.thinking = existing?.text ?? ""
    current.updatedAtMs = nowMs
  }

  public appendThinking(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed" || delta.length === 0) return
    if (current.status !== "running") return
    this.ensureCurrentThinkingRound(current)
    const round = current.thinkingRounds.find((item) => item.round === current.currentThinkingRound)
    if (round === undefined) return
    round.text += delta
    current.thinking = round.text
    current.updatedAtMs = nowMs
  }

  public appendContent(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed" || delta.length === 0) return
    if (current.status !== "running") return
    current.content += delta
    current.updatedAtMs = nowMs
  }

  /** Clear streamed resulting JSON so a schema-repair pass does not look frozen. */
  public beginSchemaRepair(projectId: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    if (current.status !== "running") return
    current.content = ""
    current.updatedAtMs = nowMs
  }

  public setThinking(projectId: string, thinking: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    this.ensureCurrentThinkingRound(current)
    const round = current.thinkingRounds.find((item) => item.round === current.currentThinkingRound)
    if (round !== undefined) round.text = thinking
    current.thinking = thinking
    current.updatedAtMs = nowMs
  }

  public setContent(projectId: string, content: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    current.content = content
    current.updatedAtMs = nowMs
  }

  public upsertSearch(projectId: string, search: MutableSearch, nowMs: number): void {
    const current = this.byProject.get(projectId)
    // Allow search status updates after complete() so post-discuss staging writes still show.
    if (current === undefined || current.status === "failed") return
    const key = searchKey(search)
    const index = current.searching.findIndex((item) => searchKey(item) === key)
    if (index < 0) current.searching.push({ ...search })
    else current.searching[index] = { ...current.searching[index], ...search }
    current.updatedAtMs = nowMs
  }

  /** Upsert workspace write progress. Allowed after complete(); refused after fail(). */
  public upsertEdit(projectId: string, edit: MutableEdit, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    const index = current.editing.findIndex((item) => item.path === edit.path)
    if (index < 0) current.editing.push({ ...edit })
    else current.editing[index] = { ...current.editing[index], ...edit }
    current.updatedAtMs = nowMs
  }

  /** Upsert bash / Claude-style tool invocations shown as run(...). */
  public upsertToolRun(projectId: string, run: MutableRun, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    const index = current.toolRuns.findIndex((item) => item.runId === run.runId)
    if (index < 0) current.toolRuns.push({ ...run })
    else current.toolRuns[index] = { ...current.toolRuns[index], ...run }
    current.updatedAtMs = nowMs
  }

  /** Replace or merge Claude Code–style todos for the Todo panel. */
  public setTodos(
    projectId: string,
    todos: readonly SynopsisConversationTodo[],
    nowMs: number,
    options?: Readonly<{ merge?: boolean }>,
  ): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
    if (options?.merge === true) {
      const byId = new Map(current.todos.map((item) => [item.id, item]))
      for (const todo of todos) byId.set(todo.id, todo)
      current.todos = [...byId.values()]
    } else {
      // A full replace may reorganize, but carried open items must be closed explicitly (cancelled).
      const nextIds = new Set(todos.map((item) => item.id))
      const nextContents = new Set(todos.map((item) => item.content.trim()))
      const dropped = current.todos.filter((item) => (
        current.carriedTodoIds.has(item.id)
        && !nextIds.has(item.id)
        && !nextContents.has(item.content.trim())
        && (item.status === "pending" || item.status === "in_progress")
      ))
      current.todos = [...todos, ...dropped.map((item) => ({ ...item, status: "pending" as const }))]
    }
    current.updatedAtMs = nowMs
  }

  public complete(projectId: string, nowMs: number, final?: Readonly<{ thinking?: string; content?: string }>): void {
    const current = this.byProject.get(projectId)
    if (current === undefined) return
    if (final?.thinking !== undefined) {
      this.ensureCurrentThinkingRound(current)
      const round = current.thinkingRounds.find((item) => item.round === current.currentThinkingRound)
      if (round !== undefined) round.text = final.thinking
      current.thinking = final.thinking
    }
    if (final?.content !== undefined) current.content = final.content
    current.status = "completed"
    current.updatedAtMs = nowMs
  }

  public fail(projectId: string, error: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined) {
      this.byProject.set(projectId, {
        projectId,
        status: "failed",
        thinking: "",
        thinkingRounds: [],
        content: "",
        searching: [],
        editing: [],
        toolRuns: [],
        todos: [],
        carriedTodoIds: new Set(),
        usage: { ...this.ensureCumulative(projectId) },
        error,
        updatedAtMs: nowMs,
      })
      return
    }
    current.status = "failed"
    current.error = error
    current.updatedAtMs = nowMs
  }

  public peek(projectId: string, sessionId?: string): SynopsisConversationStreamSnapshot {
    const current = this.byProject.get(projectId)
    const cumulative = toStreamUsage(this.ensureCumulative(projectId))
    if (current === undefined) {
      return {
        status: "idle",
        thinking: "",
        thinkingRounds: [],
        content: "",
        searching: [],
        editing: [],
        toolRuns: [],
        todos: [],
        ...(cumulative === undefined ? {} : { usage: cumulative }),
        updatedAtMs: 0,
      }
    }
    if (sessionId !== undefined && current.sessionId !== undefined && current.sessionId !== sessionId) {
      return {
        status: "idle",
        thinking: "",
        thinkingRounds: [],
        content: "",
        searching: [],
        editing: [],
        toolRuns: [],
        todos: [],
        ...(cumulative === undefined ? {} : { usage: cumulative }),
        updatedAtMs: 0,
      }
    }
    return {
      ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
      status: current.status,
      thinking: current.thinking,
      thinkingRounds: mapThinkingRounds(current.thinkingRounds),
      content: current.content,
      searching: mapSearching(current.searching),
      editing: mapEditing(current.editing),
      toolRuns: mapToolRuns(current.toolRuns),
      todos: current.todos.map((item) => ({ ...item })),
      ...(current.error === undefined ? {} : { error: current.error }),
      ...(cumulative === undefined ? {} : { usage: cumulative }),
      updatedAtMs: current.updatedAtMs,
    }
  }

  public readCumulativeUsage(projectId: string): SynopsisConversationStreamUsage | undefined {
    return toStreamUsage(this.ensureCumulative(projectId))
  }

  public clear(projectId: string): void {
    this.byProject.delete(projectId)
  }

  public resetCumulativeUsage(projectId: string): void {
    this.cumulativeUsageByProject.delete(projectId)
  }

  /** Replace in-memory cumulative usage (e.g. hydrate from SQLite after restart). */
  public hydrateCumulativeUsage(
    projectId: string,
    usage: Readonly<{
      inputTokens?: number
      outputTokens?: number
      cacheHitInputTokens?: number
      cacheMissInputTokens?: number
      lastRequestInputTokens?: number
    }>,
  ): void {
    const next = emptyUsage()
    addUsageInto(next, usage)
    this.cumulativeUsageByProject.set(projectId, next)
  }

  private ensureCurrentThinkingRound(current: MutableSnapshot): void {
    if (current.currentThinkingRound !== undefined) {
      if (!current.thinkingRounds.some((item) => item.round === current.currentThinkingRound)) {
        current.thinkingRounds.push({ round: current.currentThinkingRound, text: "" })
      }
      return
    }
    const nextRound = current.thinkingRounds.length === 0
      ? 1
      : Math.max(...current.thinkingRounds.map((item) => item.round))
    current.currentThinkingRound = nextRound
    if (!current.thinkingRounds.some((item) => item.round === nextRound)) {
      current.thinkingRounds.push({ round: nextRound, text: "" })
    }
  }

  private ensureCumulative(projectId: string): MutableUsage {
    const existing = this.cumulativeUsageByProject.get(projectId)
    if (existing !== undefined) return existing
    const created = emptyUsage()
    this.cumulativeUsageByProject.set(projectId, created)
    return created
  }
}

function toStreamUsage(usage: MutableUsage): SynopsisConversationStreamUsage | undefined {
  const total = usage.inputTokens + usage.outputTokens
  if (total === 0 && usage.cacheHitInputTokens + usage.cacheMissInputTokens === 0) return undefined
  return {
    ...(usage.inputTokens === 0 ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === 0 ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheHitInputTokens === 0 ? {} : { cacheHitInputTokens: usage.cacheHitInputTokens }),
    ...(usage.cacheMissInputTokens === 0 ? {} : { cacheMissInputTokens: usage.cacheMissInputTokens }),
    ...(usage.lastRequestInputTokens === undefined ? {} : { lastRequestInputTokens: usage.lastRequestInputTokens }),
  }
}

export const synopsisConversationStreamHub = new SynopsisConversationStreamHub()
