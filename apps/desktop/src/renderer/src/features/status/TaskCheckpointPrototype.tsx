import { useState } from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  FileCheck2,
  Gauge,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react"

import type { TaskSnapshot } from "../../api/client.js"

type RuntimeMetric = Readonly<{
  id: string
  label: string
  value: string
  ratio?: number
  resettable: boolean
  resetLabel?: string
}>

type RuntimeLimits = Readonly<{
  maxModelCalls: number
  maxWallTimeMs: number
  maxRetrievalRounds: number
}>

type UsageSummary = Readonly<{
  modelCalls: number
  inputTokens: number
  outputTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
  retrievalRounds?: number
}>

export function RuntimeMonitor({ task, executionLimits = { maxModelCalls: 400, maxWallTimeMs: 7_200_000, maxRetrievalRounds: 10 }, onOpenCheckpoint }: {
  task: TaskSnapshot | undefined
  executionLimits?: RuntimeLimits
  onOpenCheckpoint: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [resetMetricIds, setResetMetricIds] = useState<ReadonlySet<string>>(new Set())
  const usage = summarizeUsage(task)
  const elapsedMs = summarizeElapsedMs(task)
  const hasTask = task !== undefined
  const latestPhase = task?.lastPhase ?? task?.phaseRuns?.at(-1)?.phase
  const checkpointLabel = latestPhase === undefined ? "本轮尚未开始" : `${latestPhase} / ${task?.status ?? "running"}`
  const metrics: readonly RuntimeMetric[] = [
    { id: "time", label: "执行时间", value: hasTask ? `${formatDuration(elapsedMs)} / ${formatDuration(executionLimits.maxWallTimeMs)}` : "-", ...(hasTask ? { ratio: elapsedMs / executionLimits.maxWallTimeMs } : {}), resettable: true },
    { id: "calls", label: "模型调用", value: hasTask ? `${String(usage.modelCalls)} / ${String(executionLimits.maxModelCalls)}` : "-", ...(hasTask ? { ratio: usage.modelCalls / executionLimits.maxModelCalls } : {}), resettable: true },
    { id: "input", label: "输入 Token", value: hasTask ? `${formatCompact(usage.inputTokens)} / 不限制` : "-", resettable: false },
    { id: "output", label: "输出 Token", value: hasTask ? `${formatCompact(usage.outputTokens)} / 模型限制` : "-", resettable: false },
    { id: "context", label: "动态上下文", value: "不可用", resettable: false },
    { id: "retrieval", label: "检索轮次", value: !hasTask ? "-" : usage.retrievalRounds === undefined ? "不可用" : `${String(usage.retrievalRounds)} / ${String(executionLimits.maxRetrievalRounds)}`, ...(usage.retrievalRounds === undefined ? {} : { ratio: usage.retrievalRounds / executionLimits.maxRetrievalRounds }), resettable: true },
  ]
  const warningCount = metrics.filter((metric) => metric.ratio !== undefined && metric.ratio >= .8).length

  const resetMetric = (metricId: string): void => {
    setResetMetricIds((current) => new Set([...current, metricId]))
  }

  return <section className={`runtime-monitor ${expanded ? "expanded" : ""}`}>
    <button className="runtime-monitor-heading" type="button" aria-expanded={expanded} onClick={() => { setExpanded((value) => !value); }}>
      <Gauge size={14} />
      <span><strong>运行监控</strong><small>当前额度窗口</small></span>
      <em>{!hasTask ? "等待本轮数据" : warningCount === 0 ? "指标正常" : `${String(warningCount)} 项接近上限`}</em>
      <ChevronDown size={14} />
    </button>
    {expanded ? <>
      <button className="checkpoint-head" type="button" onClick={onOpenCheckpoint} data-testid="checkpoint-open">
        <ShieldCheck size={15} />
        <span><small>最近稳定检查点</small><strong>{checkpointLabel}</strong></span>
        <em>{hasTask ? "实时状态" : "暂无任务"}</em>
        <Eye size={14} />
      </button>
      <div className="runtime-metrics">
        {metrics.map((metric) => <div className={`runtime-metric ${metric.ratio !== undefined && metric.ratio >= .8 ? "warning" : ""}`} key={metric.id}>
          <span>{metric.label}</span>
          <div className="runtime-meter" aria-hidden="true"><i style={{ width: `${String(Math.round((metric.ratio ?? 0) * 100))}%` }} /></div>
          <strong>{resetMetricIds.has(metric.id) ? "0 / 新窗口" : metric.value}</strong>
          {metric.resettable ? <button type="button" disabled={!hasTask} title={metric.resetLabel ?? `重置${metric.label}`} onClick={() => { resetMetric(metric.id); }}><RotateCcw size={12} /></button> : <em>只读</em>}
        </div>)}
      </div>
      <div className="runtime-monitor-footer">
        <span>累计 {hasTask ? `${formatCompact(usage.inputTokens + usage.outputTokens)} Token` : "-"} · KV {formatKVRate(usage)}</span>
        <button type="button" disabled={!hasTask} onClick={() => { setResetMetricIds(new Set(metrics.filter((metric) => metric.resettable).map((metric) => metric.id))); }}><RefreshCcw size={12} />全部重置</button>
      </div>
    </> : null}
  </section>
}

export function TaskCheckpointDialog({ task, executionLimits = { maxModelCalls: 400, maxWallTimeMs: 7_200_000, maxRetrievalRounds: 10 }, onClose, onResume, onPause }: {
  task: TaskSnapshot
  executionLimits?: RuntimeLimits
  onClose: () => void
  onResume: (mode: "continue" | "retry_phase", resetMetricIds: readonly string[]) => Promise<void>
  onPause: () => Promise<void>
}): React.JSX.Element {
  const [resetMetricIds, setResetMetricIds] = useState<ReadonlySet<string>>(new Set())
  const [pendingAction, setPendingAction] = useState<"pause" | "retry" | "continue">()
  const [actionError, setActionError] = useState<string>()
  const usage = summarizeUsage(task)
  const blockedMetrics = task.interruption?.blockedMetrics ?? []
  const allBlockedMetricsReset = blockedMetrics.every((metricId) => resetMetricIds.has(metricId))
  const latestPhase = task.interruption?.phase ?? task.lastPhase ?? task.phaseRuns?.at(-1)?.phase ?? "尚未进入模型阶段"
  const interruptionMessage = task.interruption?.message ?? task.error?.message ?? "推演执行被暂停，已保存最近稳定检查点。"
  const completedPhases = new Set(task.phaseRuns?.filter((run) => run.status === "completed").map((run) => run.phase) ?? []).size

  const runResume = async (mode: "continue" | "retry_phase"): Promise<void> => {
    setPendingAction(mode === "continue" ? "continue" : "retry")
    setActionError(undefined)
    try {
      await onResume(mode, [...resetMetricIds])
      onClose()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      setPendingAction(undefined)
    }
  }

  const keepPaused = async (): Promise<void> => {
    setPendingAction("pause")
    setActionError(undefined)
    try {
      await onPause()
      onClose()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      setPendingAction(undefined)
    }
  }

  return <div className="dialog-backdrop checkpoint-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="checkpoint-dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-dialog-title" data-testid="checkpoint-dialog">
      <header className="checkpoint-dialog-header">
        <span className="checkpoint-status-icon"><Pause size={17} /></span>
        <div><strong id="checkpoint-dialog-title">推演已暂停</strong><small>{latestPhase} · 最近稳定检查点</small></div>
        <span className="checkpoint-state">等待决定</span>
        <button type="button" title="保持暂停并关闭" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="checkpoint-dialog-body">
        <div className="checkpoint-callout">
          <AlertTriangle size={18} />
          <div><strong>{blockedMetrics.length === 0 ? "本轮执行遇到可恢复错误" : "本轮执行指标已达到上限"}</strong><p>{interruptionMessage} 此前阶段、读取结果和待提交作用域均已保存。</p></div>
        </div>

        <div className="checkpoint-facts">
          <span><small>恢复位置</small><strong>{latestPhase}</strong></span>
          <span><small>已完成阶段</small><strong>{completedPhases} / 16</strong></span>
          <span><small>模型调用</small><strong>{usage.modelCalls} / {executionLimits.maxModelCalls}</strong></span>
          <span><small>待提交作用域</small><strong>pending</strong></span>
        </div>

        <section className="checkpoint-limit-section">
          <header><div><strong>阻塞指标</strong><small>重置仅创建新的额度窗口，累计成本不会清零</small></div><em>{allBlockedMetricsReset ? "已解除" : `${blockedMetrics.length} 项阻塞`}</em></header>
          {blockedMetrics.length === 0 ? <div className="checkpoint-limit-row resolved"><Check size={15} /><span><strong>无需重置额度</strong><small>可直接继续或重试当前阶段</small></span><div className="checkpoint-limit-meter"><i style={{ width: "0%" }} /></div><b>可恢复</b><em>只读</em></div> : blockedMetrics.map((metricId) => {
            const reset = resetMetricIds.has(metricId)
            return <div className={`checkpoint-limit-row ${reset ? "resolved" : "blocked"}`} key={metricId}>
              <Clock3 size={15} />
              <span><strong>{checkpointMetricLabel(metricId)}</strong><small>{reset ? "新窗口可用" : "当前额度窗口已耗尽"}</small></span>
              <div className="checkpoint-limit-meter"><i style={{ width: reset ? "0%" : "100%" }} /></div>
              <b>{checkpointMetricValue(metricId, usage, executionLimits)}</b>
              <button type="button" disabled={reset} onClick={() => { setResetMetricIds((current) => new Set([...current, metricId])); }}><RotateCcw size={12} />{reset ? "已重置" : "重置"}</button>
            </div>
          })}
        </section>

        <div className="checkpoint-details-grid">
          <details open>
            <summary><FileCheck2 size={14} />已保留内容</summary>
            <ul>
              <li><Check size={12} />用户输入、规则快照与选择性读取证据</li>
              <li><Check size={12} />前五个阶段的 AI 输出和自审结果</li>
              <li><Check size={12} />当前 pending 图与章节草稿引用</li>
            </ul>
          </details>
          <details>
            <summary><RefreshCcw size={14} />恢复影响</summary>
            <p>继续执行会重发当前模型请求；重试当前阶段会回到正文阶段入口。此前完成阶段不会重跑，pending 内容不会提前成为世界事实。</p>
          </details>
          <details>
            <summary><AlertTriangle size={14} />错误详情</summary>
            <p>{interruptionMessage}</p>
          </details>
        </div>

        {actionError === undefined ? null : <div className="checkpoint-decision-result" role="alert"><AlertTriangle size={14} />{actionError}</div>}
      </div>

      <footer className="checkpoint-dialog-footer">
        <button className="checkpoint-pause-command" type="button" disabled={pendingAction !== undefined} onClick={() => { void keepPaused(); }}><Pause size={13} />保持暂停</button>
        <span>{allBlockedMetricsReset ? "可以选择恢复方式" : `请先重置 ${blockedMetrics.length} 项限制`}</span>
        <button type="button" disabled={!allBlockedMetricsReset || pendingAction !== undefined} onClick={() => { void runResume("retry_phase"); }}><RotateCcw size={13} />重试当前阶段</button>
        <button className="checkpoint-continue-command" type="button" disabled={!allBlockedMetricsReset || pendingAction !== undefined} onClick={() => { void runResume("continue"); }}><Play size={13} />继续执行</button>
      </footer>
    </section>
  </div>
}

function checkpointMetricLabel(metricId: string): string {
  return ({ wall_time: "执行时间", model_calls: "模型调用", tokens: "Token 预算", retrieval_rounds: "检索轮次" } as Record<string, string>)[metricId] ?? metricId
}

function checkpointMetricValue(metricId: string, usage: UsageSummary, limits: RuntimeLimits): string {
  if (metricId === "model_calls") return `${usage.modelCalls} / ${limits.maxModelCalls}`
  if (metricId === "wall_time") return `${formatDuration(limits.maxWallTimeMs)} / ${formatDuration(limits.maxWallTimeMs)}`
  if (metricId === "retrieval_rounds") return `${usage.retrievalRounds ?? 0} / ${limits.maxRetrievalRounds}`
  return `${formatCompact(usage.inputTokens + usage.outputTokens)} / 当前窗口`
}

function formatCompact(value: number): string {
  if (value < 1_000) return value.toLocaleString()
  return `${(value / 1_000).toFixed(1)}k`
}

function summarizeUsage(task: TaskSnapshot | undefined): UsageSummary {
  return (task?.phaseRuns ?? []).reduce<UsageSummary>((summary, phaseRun) => {
    const usage = readUsage(phaseRun.usage)
    return {
      modelCalls: summary.modelCalls + (usage.modelCalls ?? (phaseRun.status === "completed" ? 1 : 0)),
      inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
      cacheHitInputTokens: summary.cacheHitInputTokens + (usage.cacheHitInputTokens ?? 0),
      cacheMissInputTokens: summary.cacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
      ...mergeOptionalCount(summary.retrievalRounds, usage.retrievalRounds, "retrievalRounds"),
    }
  }, { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitInputTokens: 0, cacheMissInputTokens: 0 })
}

function readUsage(value: unknown): Partial<UsageSummary> {
  if (typeof value !== "object" || value === null) return {}
  const record = value as Record<string, unknown>
  return {
    ...readOptionalNumber(record, "modelCalls"),
    ...readOptionalNumber(record, "inputTokens"),
    ...readOptionalNumber(record, "outputTokens"),
    ...readOptionalNumber(record, "cacheHitInputTokens"),
    ...readOptionalNumber(record, "cacheMissInputTokens"),
    ...readOptionalNumber(record, "retrievalRounds"),
  }
}

function readOptionalNumber(record: Record<string, unknown>, key: string): Record<string, number> {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? { [key]: record[key] } : {}
}

function mergeOptionalCount(current: number | undefined, next: number | undefined, key: string): Record<string, number> {
  return current === undefined && next === undefined ? {} : { [key]: (current ?? 0) + (next ?? 0) }
}

function summarizeElapsedMs(task: TaskSnapshot | undefined): number {
  const phaseRuns = task?.phaseRuns ?? []
  const firstStart = phaseRuns.map((run) => run.startedAtMs).filter(Number.isFinite).at(0)
  if (firstStart === undefined) return 0
  const end = task?.status === "running" ? Date.now() : Math.max(...phaseRuns.map((run) => run.finishedAtMs ?? run.startedAtMs))
  return Math.max(0, end - firstStart)
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatKVRate(usage: UsageSummary): string {
  const total = usage.cacheHitInputTokens + usage.cacheMissInputTokens
  return total === 0 ? "不可用" : `${String(Math.round((usage.cacheHitInputTokens / total) * 100))}%`
}
