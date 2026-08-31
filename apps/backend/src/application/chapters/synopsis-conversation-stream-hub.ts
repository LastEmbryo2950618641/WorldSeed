import type { SynopsisConversationStreamSearch, SynopsisConversationStreamSnapshot } from "@worldseed/contracts"

type MutableSearch = {
  query: string
  status: SynopsisConversationStreamSearch["status"]
  resultSummary?: string
}

type MutableSnapshot = {
  sessionId?: string
  projectId?: string
  status: SynopsisConversationStreamSnapshot["status"]
  thinking: string
  content: string
  searching: MutableSearch[]
  error?: string
  updatedAtMs: number
}

/**
 * In-process synopsis discuss stream state for concurrent peek polling while send runs.
 */
export class SynopsisConversationStreamHub {
  private readonly byProject = new Map<string, MutableSnapshot>()

  public begin(projectId: string, sessionId: string, nowMs: number): void {
    this.byProject.set(projectId, {
      sessionId,
      projectId,
      status: "running",
      thinking: "",
      content: "",
      searching: [],
      updatedAtMs: nowMs,
    })
  }

  public appendThinking(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status !== "running" || delta.length === 0) return
    current.thinking += delta
    current.updatedAtMs = nowMs
  }

  public appendContent(projectId: string, delta: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status !== "running" || delta.length === 0) return
    current.content += delta
    current.updatedAtMs = nowMs
  }

  public setThinking(projectId: string, thinking: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status !== "running") return
    current.thinking = thinking
    current.updatedAtMs = nowMs
  }

  public setContent(projectId: string, content: string, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status !== "running") return
    current.content = content
    current.updatedAtMs = nowMs
  }

  public upsertSearch(projectId: string, search: MutableSearch, nowMs: number): void {
    const current = this.byProject.get(projectId)
    if (current === undefined || current.status !== "running") return
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
    if (current === undefined) {
      return {
        status: "idle",
        thinking: "",
        content: "",
        searching: [],
        updatedAtMs: 0,
      }
    }
    if (sessionId !== undefined && current.sessionId !== undefined && current.sessionId !== sessionId) {
      return {
        status: "idle",
        thinking: "",
        content: "",
        searching: [],
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
      })),
      ...(current.error === undefined ? {} : { error: current.error }),
      updatedAtMs: current.updatedAtMs,
    }
  }

  public clear(projectId: string): void {
    this.byProject.delete(projectId)
  }
}

export const synopsisConversationStreamHub = new SynopsisConversationStreamHub()
