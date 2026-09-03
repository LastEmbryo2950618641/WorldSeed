import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import type { ResettableRuntimeMetricId, RuntimeMetric, SettingsExtractionProposal, SettingsExtractionSnapshot } from "@worldseed/contracts"
import {
  AlertTriangle,
  ArrowLeftToLine,
  Check,
  ChevronDown,
  Gauge,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  X,
} from "lucide-react"

import type { OpenProject, TaskSnapshot } from "../../api/client.js"
import { invokeBackend } from "../../api/client.js"
import { UiTooltip, uiTooltipRich } from "../../components/UiTooltip.js"

type ResetMetrics = (metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>

type DiscussTokenMetrics = Readonly<{
  kvRate?: number
  totalTokens?: number
  currentContextTokens?: number
}>

type RingMetric = Readonly<{
  metricId: string
  unit: "count" | "tokens" | "milliseconds" | "ratio" | "generation"
  current: number | null
  limit: number | null
  state: "normal" | "warning" | "exhausted" | "ok" | "resetting" | "fixed"
}>

export function RuntimeMonitor({ task, onResetMetrics, supplementalTokenMetrics, contextWindowTokens }: {
  task: TaskSnapshot | undefined
  onResetMetrics?: ResetMetrics | undefined
  supplementalTokenMetrics?: DiscussTokenMetrics | undefined
  contextWindowTokens?: number | undefined
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [pendingMetricIds, setPendingMetricIds] = useState<ReadonlySet<string>>(new Set())
  const [resetError, setResetError] = useState<string>()
  const taskMetrics = task?.runtimeMetrics?.metrics ?? []
  const metrics: readonly RingMetric[] = taskMetrics.length > 0
    ? taskMetrics
    : synthesizeDiscussMetrics(supplementalTokenMetrics, contextWindowTokens)
  const warningCount = metrics.filter((metric) => metric.state === "warning" || metric.state === "exhausted").length
  const resettableMetrics = taskMetrics.filter((metric): metric is RuntimeMetric & { metricId: ResettableRuntimeMetricId } => metric.resettable)
  const canReset = task?.status === "paused" || task?.status === "awaiting_user_decision"
  const discussOnly = taskMetrics.length === 0 && metrics.length > 0

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
      <span><strong>运行监控</strong></span>
      <em>{metrics.length === 0
        ? "等待本轮数据"
        : discussOnly
          ? "梗概讨论用量"
          : warningCount === 0 ? "指标正常" : `${String(warningCount)} 项需关注`}</em>
      <ChevronDown size={14} />
    </button>
    {expanded ? <>
      <div className="runtime-metrics">
        <div className="runtime-ring-grid">
          <RuntimeRing metric={metrics.find((metric) => metric.metricId === "wall_time")} label="执行时间" />
          <RuntimeRing metric={metrics.find((metric) => metric.metricId === "context_tokens")} label="上下文长度" />
          <RuntimeRing metric={metrics.find((metric) => metric.metricId === "kv_cache_hit_rate")} label="KV 命中率" />
          <RuntimeRing metric={metrics.find((metric) => metric.metricId === "compression_generation")} label="压缩次数" />
        </div>
      </div>
      <div className="runtime-monitor-footer">
        <span>{resetError ?? (discussOnly
          ? "创作台累计（非正式推演）"
          : `快照 ${task?.runtimeMetrics === undefined ? "-" : formatTimestamp(task.runtimeMetrics.capturedAtMs)}`)}</span>
        <button type="button" disabled={!canReset || resettableMetrics.length === 0 || pendingMetricIds.size > 0} onClick={() => { void reset(resettableMetrics.map((metric) => metric.metricId)); }}><RefreshCcw size={12} />全部重置</button>
      </div>
    </> : null}
  </section>
}

function synthesizeDiscussMetrics(
  tokenMetrics: DiscussTokenMetrics | undefined,
  contextWindowTokens: number | undefined,
): RingMetric[] {
  if (tokenMetrics === undefined) return []
  const hasAny = tokenMetrics.totalTokens !== undefined
    || tokenMetrics.kvRate !== undefined
    || tokenMetrics.currentContextTokens !== undefined
  if (!hasAny) return []
  const metrics: RingMetric[] = []
  if (tokenMetrics.currentContextTokens !== undefined || (contextWindowTokens !== undefined && contextWindowTokens > 0)) {
    metrics.push({
      metricId: "context_tokens",
      unit: "tokens",
      current: tokenMetrics.currentContextTokens ?? 0,
      limit: contextWindowTokens ?? null,
      state: "normal",
    })
  }
  if (tokenMetrics.kvRate !== undefined) {
    metrics.push({
      metricId: "kv_cache_hit_rate",
      unit: "ratio",
      current: tokenMetrics.kvRate,
      limit: 1,
      state: "normal",
    })
  }
  return metrics
}

function RuntimeRing({ metric, label }: { metric: RingMetric | undefined; label: string }): React.JSX.Element {
  const limit = metric?.limit ?? null
  const currentValue = metric?.current ?? null
  const ratio = currentValue === null
    ? 0
    : Math.min(1, metric?.unit === "ratio" ? currentValue : limit === null ? 0 : currentValue / limit)
  const current = currentValue === null ? "--" : formatMetricNumber(currentValue, metric?.unit ?? "count")
  const centerValue = current
  const detail = metric === undefined
    ? "等待数据"
      : metric.unit === "ratio"
        ? "任务累计"
      : metric.unit === "generation"
        ? "活动链累计"
      : limit === null
        ? "只读"
        : `/ ${formatMetricNumber(limit, metric.unit)}`
  const style = { "--ring-progress": `${String(Math.round(ratio * 100))}%` } as CSSProperties
  const state = metric?.state === "warning" || metric?.state === "exhausted" ? " warning" : ""
  const tooltipValue = `${current} ${detail}`
  return <UiTooltip label={uiTooltipRich(label, tooltipValue)} rich>
    <div className={`runtime-ring-card${state}`}>
      <div className="runtime-ring" style={style} aria-label={`${label} ${tooltipValue}`} tabIndex={0}>
        <span>{centerValue}</span>
      </div>
    </div>
  </UiTooltip>
}

export function TaskCheckpointDialog({ task, project, onClose, onResume, onRollbackRound, onRefreshTask, onRefreshWorkspace }: {
  task: TaskSnapshot
  project?: OpenProject | undefined
  onClose: () => void
  onResume: (mode: "continue" | "retry_phase") => Promise<void>
  onRollbackRound: () => Promise<void>
  onResetMetrics?: ResetMetrics | undefined
  onRefreshTask?: () => Promise<void>
  onRefreshWorkspace?: () => Promise<void>
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<"rollback" | "retry" | "continue">()
  const [actionError, setActionError] = useState<string>()
  const isSettingsReview = task.interruption?.kind === "settings_extraction_review" || task.status === "waiting_for_review"
  const blockedMetricIds = isSettingsReview ? [] as const : (task.interruption?.blockedMetrics ?? [])
  const blockedMetrics = blockedMetricIds.map((metricId) => task.runtimeMetrics?.metrics.find((metric) => metric.metricId === metricId))
  const unresolvedMetrics = blockedMetrics.filter((metric) => metric === undefined || metric.blocking)
  const allBlockedMetricsReset = unresolvedMetrics.length === 0
  const finalizationActive = !isSettingsReview && task.finalization !== undefined && task.finalization.status !== "completed"
  const latestPhase = finalizationActive
    ? `正式章节收尾 · ${finalizationLabel(task.finalization.status)}`
    : task.interruption?.phase ?? task.lastPhase ?? task.phaseRuns?.at(-1)?.phase ?? "尚未进入模型阶段"
  const interruptionMessage = task.interruption?.message ?? task.error?.message
  const pauseReason = resolveCheckpointPauseReason({
    isSettingsReview,
    blockedMetricCount: blockedMetricIds.length,
    interruptionKind: task.interruption?.kind,
    interruptionMessage,
  })
  const resetHint = unresolvedMetrics.length === 0
    ? undefined
    : `请先在运行监控中重置 ${String(unresolvedMetrics.length)} 项限制后再继续。`
  const taskId = task.handle?.taskId
  const [settingsSnapshot, setSettingsSnapshot] = useState<SettingsExtractionSnapshot>()
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string>()
  const pendingSettingsProposals = useMemo(
    () => (settingsSnapshot?.proposals ?? []).filter((proposal) => proposal.status === "pending"),
    [settingsSnapshot?.proposals],
  )
  const settingsReadyToContinue = !isSettingsReview || pendingSettingsProposals.length === 0

  useEffect(() => {
    if (!isSettingsReview || project === undefined || taskId === undefined) {
      setSettingsSnapshot(undefined)
      return
    }
    let active = true
    void invokeBackend<SettingsExtractionSnapshot>("settings.extraction.list", {
      projectId: project.projectId,
      workspaceRootRef: project.workspaceRootRef,
      taskId,
    }).then((snapshot) => {
      if (active) setSettingsSnapshot(snapshot)
    }).catch((cause: unknown) => {
      if (active) setSettingsError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [isSettingsReview, project, taskId, task.status])

  const resolveSettingsProposals = async (proposalIds: readonly string[], action: "approve" | "reject"): Promise<void> => {
    if (project === undefined || taskId === undefined || proposalIds.length === 0) return
    setSettingsBusy(true)
    setSettingsError(undefined)
    try {
      const method = action === "approve" ? "settings.extraction.proposal.approve" as const : "settings.extraction.proposal.reject" as const
      const snapshot = await invokeBackend<SettingsExtractionSnapshot>(method, {
        projectId: project.projectId,
        workspaceRootRef: project.workspaceRootRef,
        taskId,
        proposalIds,
      })
      setSettingsSnapshot(snapshot)
      await onRefreshTask?.()
      if (action === "approve") await onRefreshWorkspace?.()
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSettingsBusy(false)
    }
  }

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

  const runRollback = async (): Promise<void> => {
    setPendingAction("rollback")
    setActionError(undefined)
    try {
      await onRollbackRound()
      onClose()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      setPendingAction(undefined)
    }
  }

  return createPortal(<div className="dialog-backdrop checkpoint-backdrop checkpoint-backdrop--locked" role="presentation">
    <section className="checkpoint-dialog checkpoint-dialog--compact" role="dialog" aria-modal="true" aria-labelledby="checkpoint-dialog-title" data-testid="checkpoint-dialog">
      <header className="checkpoint-dialog-header checkpoint-dialog-header--locked">
        <span className="checkpoint-status-icon"><Pause size={17} /></span>
        <div><strong id="checkpoint-dialog-title">{isSettingsReview ? "设定抽取待确认" : "推演已暂停"}</strong><small>{latestPhase}</small></div>
        <span className="checkpoint-state">{isSettingsReview ? "等待确认" : "等待决定"}</span>
      </header>

      <div className="checkpoint-dialog-body">
        <div className="checkpoint-callout">
          <AlertTriangle size={18} />
          <div>
            <strong>暂停原因</strong>
            <p className="checkpoint-reason">{pauseReason}</p>
          </div>
        </div>
        {resetHint === undefined ? null : <p className="checkpoint-action-hint">{resetHint}</p>}

        {isSettingsReview ? <SettingsExtractionReviewPanel
          proposals={pendingSettingsProposals}
          busy={settingsBusy}
          error={settingsError}
          onApprove={(proposalIds) => resolveSettingsProposals(proposalIds, "approve")}
          onReject={(proposalIds) => resolveSettingsProposals(proposalIds, "reject")}
        /> : null}

        {actionError === undefined ? null : <div className="checkpoint-decision-result" role="alert"><AlertTriangle size={14} />{actionError}</div>}
      </div>

      <footer className="checkpoint-dialog-footer">
        <button className="checkpoint-rollback-command" type="button" disabled={pendingAction !== undefined} data-testid="checkpoint-rollback" onClick={() => { void runRollback(); }}><ArrowLeftToLine size={13} />回退本轮</button>
        <button type="button" disabled={!settingsReadyToContinue || !allBlockedMetricsReset || pendingAction !== undefined} onClick={() => { void runResume("retry_phase"); }}><RotateCcw size={13} />{finalizationActive ? "重试收尾步骤" : isSettingsReview ? "重试设定抽取" : "重试"}</button>
        <button className="checkpoint-continue-command" type="button" disabled={!settingsReadyToContinue || !allBlockedMetricsReset || pendingAction !== undefined} data-testid="checkpoint-continue" onClick={() => { void runResume("continue"); }}><Play size={13} />{isSettingsReview ? "继续图治理" : "继续"}</button>
      </footer>
    </section>
  </div>, document.body)
}

function SettingsExtractionReviewPanel({ proposals, busy, error, onApprove, onReject }: {
  proposals: readonly SettingsExtractionProposal[]
  busy: boolean
  error?: string | undefined
  onApprove: (proposalIds: readonly string[]) => void
  onReject: (proposalIds: readonly string[]) => void
}): React.JSX.Element {
  const pendingIds = proposals.map((proposal) => proposal.proposalId)
  return <section className="checkpoint-settings-review" data-testid="checkpoint-settings-review">
    <header>
      <div><strong>设定集提案</strong><small>确认后写入 `设定集/`，拒绝则跳过</small></div>
      <em>{proposals.length === 0 ? "已全部处理" : `${String(proposals.length)} 条待确认`}</em>
      {proposals.length > 1 ? <>
        <button type="button" disabled={busy} onClick={() => { onApprove(pendingIds); }}><Check size={12} />全部采纳</button>
        <button type="button" disabled={busy} onClick={() => { onReject(pendingIds); }}><X size={12} />全部拒绝</button>
      </> : null}
    </header>
    {error === undefined ? null : <p className="checkpoint-decision-result" role="alert"><AlertTriangle size={14} />{error}</p>}
    {proposals.length === 0 ? <p className="phase-empty">没有待确认的设定提案，可以继续图治理。</p> : proposals.map((proposal) => (
      <article className="checkpoint-settings-proposal" data-testid="checkpoint-settings-proposal" key={proposal.proposalId}>
        <header>
          <strong>{settingsProposalKindLabel(proposal.kind)}</strong>
          <code>{settingsProposalPath(proposal)}</code>
        </header>
        {proposal.reason === undefined ? null : <p>{proposal.reason}</p>}
        {proposal.conflictNotes === undefined ? null : <p><small>冲突说明：{proposal.conflictNotes}</small></p>}
        <details>
          <summary>预览 Markdown</summary>
          <pre>{settingsProposalMarkdown(proposal)}</pre>
        </details>
        <footer>
          <button type="button" disabled={busy} data-testid="checkpoint-settings-reject" onClick={() => { onReject([proposal.proposalId]); }}>拒绝</button>
          <button type="button" disabled={busy} data-testid="checkpoint-settings-approve" onClick={() => { onApprove([proposal.proposalId]); }}>采纳并写入</button>
        </footer>
      </article>
    ))}
  </section>
}

function settingsProposalKindLabel(kind: SettingsExtractionProposal["kind"]): string {
  if (kind === "create") return "新增"
  if (kind === "update") return "更新"
  return "合并"
}

function settingsProposalPath(proposal: SettingsExtractionProposal): string {
  if (proposal.payload.kind === "merge") return proposal.payload.targetPath
  return proposal.payload.relativePath
}

function settingsProposalMarkdown(proposal: SettingsExtractionProposal): string {
  return proposal.payload.markdown
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

export function resolveCheckpointPauseReason(input: Readonly<{
  isSettingsReview: boolean
  blockedMetricCount: number
  interruptionKind?: string | undefined
  interruptionMessage?: string | undefined
}>): string {
  const rawMessage = input.interruptionMessage?.trim()
  if (rawMessage !== undefined && rawMessage.length > 0) {
    return localizeCheckpointPauseReason(rawMessage)
  }
  if (input.isSettingsReview) return "正文已生成，设定抽取提案待确认"
  if (input.blockedMetricCount > 0) return "本轮执行指标已达到上限"
  if (input.interruptionKind === "execution_error") return "本轮执行遇到可恢复错误"
  return "推演执行被暂停"
}

function localizeCheckpointPauseReason(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes("driver has already been destroyed") || normalized === "no result") {
    return "本地数据库连接已关闭，请再点一次回退本轮（系统会自动重连）"
  }
  if (normalized.includes("turn deadline exceeded")) {
    return "本轮执行时间已到上限"
  }
  if (normalized.includes("model credential was not resolved") || normalized.includes("api key is not configured")) {
    return "当前模型 API Key 未配置或未能解析"
  }
  if (normalized.includes("explicit budget reset required")) {
    return "需要先重置已耗尽的运行限制，才能继续"
  }
  if (normalized.includes("chapter publish failed")) {
    return "章节发布失败"
  }
  return message
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
