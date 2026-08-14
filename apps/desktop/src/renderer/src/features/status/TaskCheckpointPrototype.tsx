import { useState } from "react"
import type { ResettableRuntimeMetricId, RuntimeMetric } from "@worldseed/contracts"
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

type ResetMetrics = (metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>

export function RuntimeMonitor({ task, onOpenCheckpoint, onResetMetrics }: {
  task: TaskSnapshot | undefined
  onOpenCheckpoint: () => void
  onResetMetrics?: ResetMetrics | undefined
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [pendingMetricIds, setPendingMetricIds] = useState<ReadonlySet<string>>(new Set())
  const [resetError, setResetError] = useState<string>()
  const metrics = task?.runtimeMetrics?.metrics ?? []
  const latestPhase = task?.lastPhase ?? task?.phaseRuns?.at(-1)?.phase
  const checkpointLabel = latestPhase === undefined ? "本轮尚未开始" : `${latestPhase} / ${task?.status ?? "running"}`
  const warningCount = metrics.filter((metric) => metric.state === "warning" || metric.state === "exhausted").length
  const resettableMetrics = metrics.filter((metric): metric is RuntimeMetric & { metricId: ResettableRuntimeMetricId } => metric.resettable)
  const canReset = task?.status === "paused" || task?.status === "awaiting_user_decision"

  const reset = async (metricIds: readonly ResettableRuntimeMetricId[]): Promise<void> => {
    if (onResetMetrics === undefined || metricIds.length === 0) return
    setPendingMetricIds(new Set(metricIds))
    setResetError(undefined)
    try {
      await onResetMetrics(metricIds)
    } catch (cause) {
      setResetError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingMetricIds(new Set())
    }
  }

  return <section className={`runtime-monitor ${expanded ? "expanded" : ""}`}>
    <button className="runtime-monitor-heading" type="button" aria-expanded={expanded} onClick={() => { setExpanded((value) => !value); }}>
      <Gauge size={14} />
      <span><strong>运行监控</strong><small>后端实时额度窗口</small></span>
      <em>{metrics.length === 0 ? "等待本轮数据" : warningCount === 0 ? "指标正常" : `${String(warningCount)} 项需关注`}</em>
      <ChevronDown size={14} />
    </button>
    {expanded ? <>
      <button className="checkpoint-head" type="button" onClick={onOpenCheckpoint} data-testid="checkpoint-open">
        <ShieldCheck size={15} />
        <span><small>最近稳定检查点</small><strong>{checkpointLabel}</strong></span>
        <em>{task === undefined ? "暂无任务" : "实时状态"}</em>
        <Eye size={14} />
      </button>
      <div className="runtime-metrics">
        {metrics.length === 0 ? <p className="phase-empty">等待后端返回运行指标。</p> : metrics.map((metric) => {
          const ratio = metric.limit === null || metric.current === null ? 0 : Math.min(1, metric.current / metric.limit)
          const pending = pendingMetricIds.has(metric.metricId)
          return <div className={`runtime-metric ${metric.state === "warning" || metric.state === "exhausted" ? "warning" : ""}`} key={metric.metricId} title={metric.description}>
            <span>{metric.label}</span>
            <div className="runtime-meter" aria-hidden="true"><i style={{ width: `${String(Math.round(ratio * 100))}%` }} /></div>
            <strong>{formatMetric(metric)}{metric.cumulative === null ? "" : ` · 累计 ${formatMetricNumber(metric.cumulative, metric.unit)}`}</strong>
            {metric.resettable ? <button type="button" disabled={!canReset || pending} title={`重置${metric.label}`} onClick={() => { void reset([metric.metricId as ResettableRuntimeMetricId]); }}><RotateCcw size={12} /></button> : <em>只读</em>}
          </div>
        })}
      </div>
      <div className="runtime-monitor-footer">
        <span>{resetError ?? `快照 ${task?.runtimeMetrics === undefined ? "-" : formatTimestamp(task.runtimeMetrics.capturedAtMs)}`}</span>
        <button type="button" disabled={!canReset || resettableMetrics.length === 0 || pendingMetricIds.size > 0} onClick={() => { void reset(resettableMetrics.map((metric) => metric.metricId)); }}><RefreshCcw size={12} />全部重置</button>
      </div>
    </> : null}
  </section>
}

export function TaskCheckpointDialog({ task, onClose, onResume, onPause, onResetMetrics }: {
  task: TaskSnapshot
  onClose: () => void
  onResume: (mode: "continue" | "retry_phase") => Promise<void>
  onPause: () => Promise<void>
  onResetMetrics?: ResetMetrics | undefined
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<"pause" | "retry" | "continue" | "reset">()
  const [actionError, setActionError] = useState<string>()
  const blockedMetricIds = task.interruption?.blockedMetrics ?? []
  const blockedMetrics = blockedMetricIds.map((metricId) => task.runtimeMetrics?.metrics.find((metric) => metric.metricId === metricId))
  const unresolvedMetrics = blockedMetrics.filter((metric) => metric === undefined || metric.blocking)
  const allBlockedMetricsReset = unresolvedMetrics.length === 0
  const finalizationActive = task.finalization !== undefined && task.finalization.status !== "completed"
  const latestPhase = finalizationActive
    ? `正式章节收尾 · ${finalizationLabel(task.finalization.status)}`
    : task.interruption?.phase ?? task.lastPhase ?? task.phaseRuns?.at(-1)?.phase ?? "尚未进入模型阶段"
  const interruptionMessage = task.interruption?.message ?? task.error?.message ?? "推演执行被暂停，已保存最近稳定检查点。"
  const completedPhases = new Set(task.phaseRuns?.filter((run) => run.status === "completed").map((run) => run.phase) ?? []).size
  const modelCalls = task.runtimeMetrics?.metrics.find((metric) => metric.metricId === "model_calls")

  const runResume = async (mode: "continue" | "retry_phase"): Promise<void> => {
    setPendingAction(mode === "continue" ? "continue" : "retry")
    setActionError(undefined)
    try {
      await onResume(mode)
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

  const reset = async (metricIds: readonly ResettableRuntimeMetricId[]): Promise<void> => {
    if (onResetMetrics === undefined || metricIds.length === 0) return
    setPendingAction("reset")
    setActionError(undefined)
    try {
      await onResetMetrics(metricIds)
      setPendingAction(undefined)
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
          <div><strong>{blockedMetricIds.length === 0 ? "本轮执行遇到可恢复错误" : "本轮执行指标已达到上限"}</strong><p>{interruptionMessage} {finalizationActive ? "正文与世界提交进度已经保存，恢复不会重新调用 AI。" : "此前阶段、读取结果和待提交作用域均已保存。"}</p></div>
        </div>

        <div className="checkpoint-facts">
          <span><small>恢复位置</small><strong>{latestPhase}</strong></span>
          <span><small>已完成阶段</small><strong>{completedPhases} / 16</strong></span>
          <span><small>模型调用</small><strong>{modelCalls === undefined ? "-" : formatMetric(modelCalls)}</strong></span>
          <span><small>世界作用域</small><strong>{finalizationActive && task.finalization.status !== "prepared" ? "committed" : "pending"}</strong></span>
        </div>

        <section className="checkpoint-limit-section">
          <header>
            <div><strong>阻塞指标</strong><small>重置创建持久额度窗口，累计成本不会清零</small></div>
            <em>{allBlockedMetricsReset ? "已解除" : `${String(unresolvedMetrics.length)} 项阻塞`}</em>
            {unresolvedMetrics.length > 1 ? <button type="button" disabled={pendingAction !== undefined} onClick={() => { void reset(unresolvedMetrics.flatMap((metric) => metric?.resettable === true ? [metric.metricId as ResettableRuntimeMetricId] : [])); }}><RefreshCcw size={12} />全部重置</button> : null}
          </header>
          {blockedMetricIds.length === 0 ? <div className="checkpoint-limit-row resolved"><Check size={15} /><span><strong>无需重置额度</strong><small>{finalizationActive ? "可直接继续未完成的收尾步骤" : "可直接继续或重试当前阶段"}</small></span><div className="checkpoint-limit-meter"><i style={{ width: "0%" }} /></div><b>可恢复</b><em>只读</em></div> : blockedMetricIds.map((metricId, index) => {
            const metric = blockedMetrics[index]
            const resolved = metric !== undefined && !metric.blocking
            return <div className={`checkpoint-limit-row ${resolved ? "resolved" : "blocked"}`} key={metricId}>
              <Clock3 size={15} />
              <span><strong>{metric?.label ?? metricId}</strong><small>{resolved ? `新窗口第 ${String(metric.resetGeneration)} 代可用` : "当前额度窗口已耗尽"}</small></span>
              <div className="checkpoint-limit-meter"><i style={{ width: resolved ? "0%" : "100%" }} /></div>
              <b>{metric === undefined ? "后端指标缺失" : formatMetric(metric)}</b>
              {metric?.resettable === true ? <button type="button" disabled={resolved || pendingAction !== undefined} onClick={() => { void reset([metric.metricId as ResettableRuntimeMetricId]); }}><RotateCcw size={12} />{resolved ? "已重置" : "重置"}</button> : <em>只读</em>}
            </div>
          })}
        </section>

        <div className="checkpoint-details-grid">
          <details open>
            <summary><FileCheck2 size={14} />已保留内容</summary>
            <ul>
              <li><Check size={12} />用户输入、规则快照与选择性读取证据</li>
              <li><Check size={12} />已完成阶段的 AI 输出和自审结果</li>
              <li><Check size={12} />{finalizationActive ? "正式正文引用、世界提交状态与章节发布进度" : "当前 pending 图与章节草稿引用"}</li>
            </ul>
          </details>
          <details>
            <summary><RefreshCcw size={14} />恢复影响</summary>
            <p>{finalizationActive ? "继续或重试只会执行尚未完成的提交、发布或登记步骤，不会重新调用模型、生成正文或治理世界图。" : "继续执行保留当前阶段已完成结果；重试当前阶段回到阶段入口。此前完成阶段不会重跑，pending 内容不会提前成为世界事实。"}</p>
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
        <span>{allBlockedMetricsReset ? "可以选择恢复方式" : `请先重置 ${String(unresolvedMetrics.length)} 项限制`}</span>
        <button type="button" disabled={!allBlockedMetricsReset || pendingAction !== undefined} onClick={() => { void runResume("retry_phase"); }}><RotateCcw size={13} />{finalizationActive ? "重试收尾步骤" : "重试当前阶段"}</button>
        <button className="checkpoint-continue-command" type="button" disabled={!allBlockedMetricsReset || pendingAction !== undefined} onClick={() => { void runResume("continue"); }}><Play size={13} />继续执行</button>
      </footer>
    </section>
  </div>
}

function finalizationLabel(status: NonNullable<TaskSnapshot["finalization"]>["status"] | undefined): string {
  switch (status) {
    case "prepared": return "等待提交世界"
    case "scope_committed": return "等待发布章节"
    case "chapter_published": return "等待登记章节"
    case "chapter_registered": return "等待完成任务"
    case "completed": return "已完成"
    default: return "状态未知"
  }
}

function formatMetric(metric: RuntimeMetric): string {
  const current = metric.current === null ? "不可用" : formatMetricNumber(metric.current, metric.unit)
  const limit = metric.limit === null ? "只读" : formatMetricNumber(metric.limit, metric.unit)
  return `${current} / ${limit}`
}

function formatMetricNumber(value: number, unit: RuntimeMetric["unit"]): string {
  if (unit === "milliseconds") return formatDuration(value)
  if (unit === "ratio") return `${String(Math.round(value * 100))}%`
  if (unit === "tokens") return formatCompact(value)
  return value.toLocaleString()
}

function formatCompact(value: number): string {
  if (value < 1_000) return value.toLocaleString()
  return `${(value / 1_000).toFixed(1)}k`
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatTimestamp(valueMs: number): string {
  return new Date(valueMs).toLocaleTimeString("zh-CN", { hour12: false })
}
