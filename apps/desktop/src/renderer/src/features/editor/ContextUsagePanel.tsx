import { useCallback, useEffect, useId, useRef, useState } from "react"

import { invokeBackend } from "../../api/client.js"

export type ContextUsageCategory = Readonly<{
  id: string
  label: string
  tokens: number
  share: number
  compressible: boolean
}>

export type ContextUsageSnapshot = Readonly<{
  sessionId?: string
  usedTokens: number
  maxTokens: number
  percent: number
  categories: readonly ContextUsageCategory[]
  empty: boolean
}>

const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  system_rules: "#8b95a8",
  phase_prompt: "#7c6cf0",
  tools: "#c084fc",
  presentation_rules: "#34d399",
  memory: "#fbbf24",
  evidence: "#fb7185",
  narrative: "#60a5fa",
  conversation: "#f43f5e",
  latest_delta: "#fb923c",
}

type Props = Readonly<{
  open: boolean
  projectId: string | undefined
  workspaceRootRef: string | undefined
  sessionId: string | undefined
  contextWindowTokens?: number
  /** Bump when a discuss turn finishes so an open panel reloads. */
  refreshToken?: string | number
  onClose(): void
}>

export function ContextUsagePanel(props: Props): React.JSX.Element | null {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [snapshot, setSnapshot] = useState<ContextUsageSnapshot>()

  const refresh = useCallback(async (): Promise<void> => {
    if (props.projectId === undefined || props.workspaceRootRef === undefined) {
      setSnapshot(undefined)
      setError("未打开书籍")
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await invokeBackend<ContextUsageSnapshot>("synopsis.conversation.contextUsage", {
        projectId: props.projectId,
        workspaceRootRef: props.workspaceRootRef,
        ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
        ...(props.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: props.contextWindowTokens }),
      })
      setSnapshot(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [props.contextWindowTokens, props.projectId, props.sessionId, props.workspaceRootRef])

  useEffect(() => {
    if (!props.open) return
    void refresh()
  }, [props.open, props.refreshToken, refresh])

  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose()
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest("[data-context-usage-trigger]")) return
      props.onClose()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onPointer)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onPointer)
    }
  }, [props.open, props.onClose])

  if (!props.open) return null

  const categories = snapshot?.categories ?? []
  const used = snapshot?.usedTokens ?? 0
  const max = snapshot?.maxTokens ?? props.contextWindowTokens ?? 1
  const percent = snapshot?.percent ?? 0
  const empty = snapshot?.empty === true || categories.length === 0

  return (
    <div
      ref={panelRef}
      className="context-usage-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="context-usage-panel"
    >
      <header className="context-usage-panel-header">
        <div>
          <strong id={titleId}>上下文占用</strong>
          <small>
            {loading
              ? "加载中…"
              : empty
                ? "尚无模型调用"
                : `${formatPercent(percent)} · ${formatTokens(used)} / ${formatTokens(max)}`}
          </small>
        </div>
        <button type="button" className="context-usage-panel-close" aria-label="关闭" onClick={props.onClose}>
          ×
        </button>
      </header>

      {error === undefined ? null : <p className="context-usage-panel-error" role="alert">{error}</p>}

      {empty && !loading
        ? <p className="context-usage-panel-empty">发送一条创作台消息后，这里会按分类显示当前可见链占用。</p>
        : <>
            <div className="context-usage-bar" aria-hidden>
              {categories.map((category) => (
                <span
                  key={category.id}
                  className="context-usage-bar-segment"
                  style={{
                    flexGrow: Math.max(category.share, 0.01),
                    background: CATEGORY_COLORS[category.id] ?? "#94a3b8",
                  }}
                  title={`${category.label} ${formatTokens(category.tokens)}`}
                />
              ))}
            </div>
            <ul className="context-usage-list">
              {categories.map((category) => (
                <li key={category.id}>
                  <span
                    className="context-usage-swatch"
                    style={{ background: CATEGORY_COLORS[category.id] ?? "#94a3b8" }}
                  />
                  <span className="context-usage-label">
                    {category.label}
                    {category.compressible
                      ? <em className="context-usage-tag">可机械压缩</em>
                      : <em className="context-usage-tag context-usage-tag--protected">受保护</em>}
                  </span>
                  <span className="context-usage-tokens">{formatTokens(category.tokens)}</span>
                  <span className="context-usage-share">{formatShare(category.share)}</span>
                </li>
              ))}
            </ul>
          </>}

      <footer className="context-usage-panel-tips">
        <p>对话/旧阶段占比高时，接近窗口阈值会机械移出；细节靠图与原文召回，不是 AI 摘要。</p>
        <p>证据占比高时少盲目读文件；叙事占比高属正常。勿清系统/表现规则前缀，否则破坏 KV 暖链。</p>
        <p>不建议假 completion「预热」：首包慢主要来自大 prompt 与供应商冷 KV，应保持同模型同链追加。</p>
      </footer>
    </div>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatPercent(value: number): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${rounded}%`
}

function formatShare(share: number): string {
  return `${Math.round(share * 1000) / 10}%`
}
