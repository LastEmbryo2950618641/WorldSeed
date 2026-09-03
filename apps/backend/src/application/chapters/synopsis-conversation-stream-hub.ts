import type {
  SynopsisConversationStreamSearch,
  SynopsisConversationStreamSnapshot,
  SynopsisConversationStreamUsage,
} from "@worldseed/contracts"

type MutableSearch = {
  query: string
  status: SynopsisConversationStreamSearch["status"]
  resultSummary?: string
  asOfChapterSequence?: number
  temporalRole?: "as_of" | "current"
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
  content: string
  searching: MutableSearch[]
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

/**
 * In-process synopsis discuss stream state for concurrent peek polling while send runs.
 * Cumulative usage survives turn clear so the UI can keep showing token metrics.
 */
export class SynopsisConversationStreamHub {
  private readonly byProject = new Map<string, MutableSnapshot>()
  private readonly cumulativeUsageByProject = new Map<string, MutableUsage>()

  public begin(projectId: string, sessionId: string, nowMs: number): void {
    this.ensureCumulative(projectId)
    this.byProject.set(projectId, {
      sessionId,
      projectId,
      status: "running",
      thinking: "",
      content: "",
      searching: [],
      usage: emptyUsage(),
      updatedAtMs: nowMs,
    })
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

  public appendThinking(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed" || delta.length === 0) return
    if (current.status !== "running") return
    current.thinking += delta
    current.updatedAtMs = nowMs
  }

  public appendContent(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed" || delta.length === 0) return
    if (current.status !== "running") return
    current.content += delta
    current.updatedAtMs = nowMs
  }

  public setThinking(projectId: string, thinking: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status === "failed") return
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
    const index = current.searching.findIndex((item) => item.query === search.query)
    if (index < 0) current.searching.push({ ...search })
    else current.searching[index] = { ...current.searching[index], ...search }
    current.updatedAtMs = nowMs
  }

  public complete(projectId: string, nowMs: number, final?: Readonly<{ thinking?: string; content?: string }>): void {
    const current = this.byProject.get(projectId)
    if (current === undefined) return
    if (final?.thinking !== undefined) current.thinking = final.thinking
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
        content: "",
        searching: [],
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
        content: "",
        searching: [],
        ...(cumulative === undefined ? {} : { usage: cumulative }),
        updatedAtMs: 0,
      }
    }
    if (sessionId !== undefined && current.sessionId !== undefined && current.sessionId !== sessionId) {
      return {
        status: "idle",
        thinking: "",
        content: "",
        searching: [],
        ...(cumulative === undefined ? {} : { usage: cumulative }),
        updatedAtMs: 0,
      }
    }
    return {
      ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
      status: current.status,
      thinking: current.thinking,
      content: current.content,
      searching: current.searching.map((item) => ({
        query: item.query,
        status: item.status,
        ...(item.resultSummary === undefined ? {} : { resultSummary: item.resultSummary }),
        ...(item.asOfChapterSequence === undefined ? {} : { asOfChapterSequence: item.asOfChapterSequence }),
        ...(item.temporalRole === undefined ? {} : { temporalRole: item.temporalRole }),
      })),
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
