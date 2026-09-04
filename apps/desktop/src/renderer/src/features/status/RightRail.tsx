import { useEffect, useState } from "react"
import { Activity, Check, Circle, GitBranch, History, Network, Orbit } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { aiPhaseValues, type HistoryOverview, type ProjectSettings, type ResettableRuntimeMetricId } from "@worldseed/contracts"

import type { GraphSlice, OpenProject, PhaseRunSnapshot, TaskSnapshot } from "../../api/client.js"
import type { SynopsisConversationStreamSnapshot } from "@worldseed/contracts"
import { UiTooltip, uiTooltipRich } from "../../components/UiTooltip.js"
import { useWorkbenchStore, type RightTab } from "../../state/workbench-store.js"
import { WorldGraph } from "./WorldGraph.js"
import { HistoryPanel } from "./HistoryPanel.js"
import { RuntimeMonitor, TaskCheckpointDialog } from "./TaskCheckpointPrototype.js"

type Props = Readonly<{
  task: TaskSnapshot | undefined
  project?: OpenProject | undefined
  graphSlice: GraphSlice | undefined
  graphSettings?: ProjectSettings["graph"] | undefined
  historyRetentionLimit?: number | null | undefined
  history?: HistoryOverview | undefined
  historyLoading?: boolean | undefined
  /** Active model profile context window for 当前上下文/最大上下文. */
  contextWindowTokens?: number | undefined
  onOpenProjectSettings?(): void
  onResumeTask?(mode: "continue" | "retry_phase"): Promise<void>
  onResetTaskMetrics?(metricIds: readonly ResettableRuntimeMetricId[]): Promise<void>
  onSaveHistory?(): Promise<void>
  onRestoreHistory?(entryId: string): Promise<void>
  onContinueFromHistory?(entryId: string): Promise<void>
  onReturnPreviousRound?(): Promise<void>
  onRefreshTask?(): Promise<void>
  onRefreshWorkspace?(): Promise<void>
}>

const labels: Record<string, string> = {
  interpret: "理解用户输入",
  rule_assembly: "装配规则快照",
  source_retrieval: "选择性检索资料",
  emergence_planning: "规划内容出现",
  emergence_review: "审查出现依据",
  draft: "撰写正文",
  chapter_naming: "生成章节标题",
  dependency_audit: "检查依赖闭合",
  settings_extraction: "抽取设定提案",
  response_review: "审查正文响应",
  graph_governance: "治理世界图",
  graph_structure_plan: "候选结构规划",
  graph_capacity_rewrite: "热点局部重构",
  graph_spacetime_settlement: "时空与历史结算",
  graph_retrieval_design: "查询投影设计",
  graph_governance_review: "整体治理审核",
  semantic_review: "语义一致性复核",
  settlement_review: "结算资料返回路径",
  frontier_settlement: "结算演化前沿",
  commit_review: "最终提交审查",
}

const stagedGraphPhases = [
  "graph_structure_plan",
  "graph_capacity_rewrite",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
] as const

const visibleTopLevelPhases = aiPhaseValues.filter((phase) => (
  phase !== "graph_governance"
  && phase !== "semantic_review"
  && !stagedGraphPhases.includes(phase as typeof stagedGraphPhases[number])
))

export function RightRail({
  task,
  project,
  graphSlice,
  graphSettings,
  historyRetentionLimit = null,
  history,
  historyLoading,
  contextWindowTokens,
  onOpenProjectSettings,
  onResumeTask,
  onResetTaskMetrics,
  onSaveHistory,
  onRestoreHistory,
  onContinueFromHistory,
  onReturnPreviousRound,
  onRefreshTask,
  onRefreshWorkspace,
}: Props): React.JSX.Element {
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const tab = useWorkbenchStore((state) => state.rightTab)
  const setTab = useWorkbenchStore((state) => state.setRightTab)
  const tokenSummary = summarizeTaskTokenMetrics(task)
  useEffect(() => {
    if (task?.status === "awaiting_user_decision" || task?.status === "waiting_for_review") setCheckpointOpen(true)
  }, [task?.status])
  return <><aside className="right-rail">
    <div className="right-tabs" role="tablist" aria-label="右侧面板">
      <Tab id="process" tab={tab} onChange={setTab} icon={<Activity size={15} />} label="流程" />
      <Tab id="graph" tab={tab} onChange={setTab} icon={<Network size={15} />} label="世界图" />
      <Tab id="evolution" tab={tab} onChange={setTab} icon={<Orbit size={15} />} label="自洽演化" />
      <Tab id="history" tab={tab} onChange={setTab} icon={<History size={15} />} label="历史" />
    </div>
    <div className="right-content">
      {tab === "process" ? <ProcessPanel
        task={task}
        onResetMetrics={onResetTaskMetrics}
      /> : null}
      {tab === "graph" ? <WorldGraph slice={graphSlice} settings={graphSettings} /> : null}
      {tab === "evolution" ? <EvolutionPanel /> : null}
      {tab === "history" ? <HistoryPanel
        entries={history?.entries ?? []}
        branches={history?.branches ?? []}
        {...(history?.activeBranchId === undefined ? {} : { activeBranchId: history.activeBranchId })}
        {...(history?.selectedEntryId === undefined ? {} : { selectedEntryId: history.selectedEntryId })}
        retentionLimit={historyRetentionLimit}
        taskRunning={task?.status === "running"}
        {...(historyLoading === undefined ? {} : { loading: historyLoading })}
        onOpenSettings={onOpenProjectSettings ?? (() => undefined)}
        onOpenCheckpoint={() => { setCheckpointOpen(true); }}
        onSave={onSaveHistory ?? (() => Promise.reject(new Error("历史保存接口尚未连接")))}
        onRestore={onRestoreHistory ?? (() => Promise.reject(new Error("历史恢复接口尚未连接")))}
        onContinueFrom={onContinueFromHistory ?? (() => Promise.reject(new Error("历史分叉接口尚未连接")))}
        onReturnPreviousRound={onReturnPreviousRound ?? (() => Promise.reject(new Error("返回上一轮接口尚未连接")))}
      /> : null}
    </div>
    <div className="world-summary" data-testid="world-summary">
      <span>世界时间 <strong>当前章节锚点</strong></span>
      <span>图局部 <strong>{graphSlice === undefined ? "未读取" : `${String(graphSlice.nodes.length)} 节点 / ${String(graphSlice.links.length)} 连接`}</strong></span>
      <span>任务状态 <strong>{task?.status ?? "未运行"}</strong></span>
      <span>推演 KV 命中率 <strong>{tokenSummary.kvRate === undefined ? "—" : `${String(Math.round(tokenSummary.kvRate * 100))}%`}</strong></span>
      <span>推演总 Token <strong>{tokenSummary.totalTokens === undefined ? "—" : formatCompactMetric(tokenSummary.totalTokens)}</strong></span>
      <span>推演上下文 / 最大上下文 <strong>{formatContextWindow(tokenSummary.currentContextTokens, contextWindowTokens)}</strong></span>
    </div>
  </aside>{checkpointOpen && task !== undefined ? <TaskCheckpointDialog
    task={task}
    project={project}
    onClose={() => { setCheckpointOpen(false); }}
    onResume={onResumeTask ?? (() => Promise.reject(new Error("恢复接口尚未连接")))}
    onResetMetrics={onResetTaskMetrics ?? (() => Promise.reject(new Error("指标重置接口尚未连接")))}
    onRollbackRound={onReturnPreviousRound ?? (() => Promise.reject(new Error("回退本轮接口尚未连接")))}
    onRefreshTask={onRefreshTask}
    onRefreshWorkspace={onRefreshWorkspace}
  /> : null}</>
}

function Tab({ id, tab, onChange, icon, label }: { id: RightTab; tab: RightTab; onChange: (tab: RightTab) => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return <UiTooltip label={label}>
    <button
      type="button"
      className={tab === id ? "active" : ""}
      role="tab"
      aria-selected={tab === id}
      aria-label={label}
      onClick={() => { onChange(id); }}
    >
      <span className="right-tab-icon" aria-hidden="true">{icon}</span>
      <span className="right-tab-label">{label}</span>
    </button>
  </UiTooltip>
}

function ProcessPanel({
  task,
  onResetMetrics,
}: {
  task: TaskSnapshot | undefined
  onResetMetrics?: ((metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>) | undefined
}): React.JSX.Element {
  return <div className="process-panel">
    <RuntimeMonitor
      task={task}
      onResetMetrics={onResetMetrics}
    />
    {task?.finalization === undefined || task.finalization.status === "completed" ? null : <p className="phase-empty">正式章节收尾：{task.finalization.status} · {task.finalization.chapterHeading}</p>}
    <div className="phase-list">{visibleTopLevelPhases.flatMap((phase) => {
      const rows: React.ReactNode[] = []
      if (phase === "settlement_review") rows.push(<GraphGovernanceGroup task={task} key="staged-graph-governance" />)
      const runs = task?.phaseRuns?.filter((run) => run.phase === phase) ?? []
      const latest = runs.at(-1)
      const isDone = latest?.status === "completed"
      const isCurrent = latest?.status === "running" || latest?.status === "failed"
      rows.push(<details className={`phase-detail ${isDone ? "done" : isCurrent ? "current" : ""}`} key={phase}>
        <summary className={`phase-row ${isDone ? "done" : isCurrent ? "current" : ""}`}>
          <UiTooltip label={uiTooltipRich(labels[phase] ?? phase, phase)} rich>
            <span className="phase-icon">{isDone ? <Check size={13} /> : isCurrent ? <span className="phase-spinner" aria-hidden="true" /> : <Circle size={10} />}</span>
          </UiTooltip>
          <span className="phase-row-copy">
            <strong>{labels[phase] ?? phase}</strong>
            <small>{phase}</small>
          </span>
          <PhaseMetricRings runs={runs} />
        </summary>
        {latest?.result === undefined ? <PhasePending latestStatus={latest?.status} /> : <PhaseDetails result={latest.result} />}
      </details>)
      return rows
    })}</div>
    {task?.error?.message === undefined ? null : <p className="task-error">{task.error.message}</p>}
  </div>
}

function GraphGovernanceGroup({ task }: { task: TaskSnapshot | undefined }): React.JSX.Element {
  const runs = task?.phaseRuns?.filter((run) => stagedGraphPhases.includes(run.phase as typeof stagedGraphPhases[number])) ?? []
  const completed = new Set(runs.filter((run) => run.status === "completed").map((run) => run.phase))
  const active = runs.findLast((run) => run.status === "running" || run.status === "failed")
  const done = completed.has("graph_governance_review")
  const capacityRuns = runs.filter((run) => run.phase === "graph_capacity_rewrite")
  const steps = [
    { id: "graph_structure_plan", label: "候选结构规划", kind: "ai" as const },
    { id: "graph_capacity_assessment", label: "容量检查", kind: "mechanical" as const },
    { id: "graph_capacity_rewrite", label: "热点局部重构", kind: "ai" as const },
    { id: "graph_capacity_reassessment", label: "容量复检", kind: "mechanical" as const },
    { id: "graph_spacetime_settlement", label: "时空与历史结算", kind: "ai" as const },
    { id: "graph_retrieval_design", label: "查询投影设计", kind: "ai" as const },
    { id: "graph_governance_review", label: "整体治理审核", kind: "ai" as const },
  ]
  return <details className={`phase-detail graph-governance-group ${done ? "done" : active === undefined ? "" : "current"}`}>
    <summary className={`phase-row ${done ? "done" : active === undefined ? "" : "current"}`}>
      <UiTooltip label={uiTooltipRich("分步治理世界图", "graph_governance")} rich>
        <span className="phase-icon">{done ? <Check size={13} /> : active === undefined ? <Circle size={10} /> : <span className="phase-spinner" aria-hidden="true" />}</span>
      </UiTooltip>
      <span className="phase-row-copy">
        <strong>分步治理世界图</strong>
        <small>graph_governance</small>
      </span>
      <PhaseMetricRings runs={runs} />
    </summary>
    <div className="governance-step-list">{steps.map((step) => {
      const phaseRuns = step.kind === "ai" ? runs.filter((run) => run.phase === step.id) : []
      const latest = phaseRuns.at(-1)
      const mechanicalComplete = step.id === "graph_capacity_assessment"
        ? completed.has("graph_structure_plan")
        : completed.has("graph_structure_plan") && (capacityRuns.length === 0 || completed.has("graph_capacity_rewrite"))
      const stepDone = step.kind === "mechanical" ? mechanicalComplete : latest?.status === "completed"
      const stepCurrent = latest?.status === "running" || latest?.status === "failed"
      return <details className={`governance-step ${stepDone ? "done" : stepCurrent ? "current" : ""}`} key={step.id}>
        <summary>
          <UiTooltip label={uiTooltipRich(step.label, step.id)} rich>
            <span className="governance-step-icon">{stepDone ? <Check size={12} /> : stepCurrent ? <span className="phase-spinner phase-spinner-sm" aria-hidden="true" /> : <Circle size={9} />}</span>
          </UiTooltip>
          <strong className="governance-step-copy">{step.label}</strong>
          <PhaseMetricRings runs={phaseRuns} />
        </summary>
        {step.kind === "mechanical"
          ? <CapacityRunDetails rewriteCount={capacityRuns.length} complete={mechanicalComplete} />
          : latest?.result === undefined ? <PhasePending latestStatus={latest?.status} /> : <PhaseDetails result={latest.result} />}
      </details>
    })}</div>
  </details>
}

type PhaseMetric = Readonly<{
  contextTokens?: number
  modelCalls?: number
  kvRate?: number
  latencyMs?: number
  retrievalRounds?: number
}>

function PhaseMetricRings({ runs }: { runs: readonly PhaseRunSnapshot[] }): React.JSX.Element {
  const metric = summarizePhaseMetrics(runs)
  return <span className="phase-metric-rings" aria-label="阶段运行指标">
    <PhaseMetricRing value={metric.contextTokens === undefined ? "--" : formatCompactMetric(metric.contextTokens)} label="平均上下文请求 Token 数" />
    <PhaseMetricRing value={metric.modelCalls === undefined ? "--" : formatCompactMetric(metric.modelCalls)} label="平均 AI 请求数" />
    <PhaseMetricRing value={metric.kvRate === undefined ? "--" : `${String(Math.round(metric.kvRate * 100))}%`} label="平均 KV 缓存命中率" {...(metric.kvRate === undefined ? {} : { progress: metric.kvRate })} />
    <PhaseMetricRing value={metric.latencyMs === undefined ? "--" : formatPhaseDuration(metric.latencyMs)} label="平均请求时间" />
    <PhaseMetricRing value={metric.retrievalRounds === undefined ? "--" : String(metric.retrievalRounds)} label="当前阶段检索轮次" />
  </span>
}

function PhaseMetricRing({ value, label, progress }: { value: string; label: string; progress?: number }): React.JSX.Element {
  const style = { "--phase-ring-progress": progress === undefined ? "0%" : `${String(Math.round(progress * 100))}%` } as React.CSSProperties
  return <UiTooltip label={uiTooltipRich(label, value)} rich>
    <span className={`phase-metric-ring${value === "--" ? " empty" : ""}`} style={style} aria-label={`${label}: ${value}`} tabIndex={0} />
  </UiTooltip>
}

function summarizePhaseMetrics(runs: readonly PhaseRunSnapshot[]): PhaseMetric {
  const samples = runs.map((run) => ({ run, usage: readPhaseUsage(run.usage) }))
  const average = (values: readonly number[]): number | undefined => values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
  const modelCalls = samples.map((sample) => sample.usage.modelCalls).filter(isNumber)
  const requestSamples = samples.flatMap((sample) => {
    const inputTokens = sample.usage.inputTokens
    const latencyMs = sample.usage.latencyMs ?? phaseElapsedMs(sample.run)
    const calls = sample.usage.modelCalls ?? (inputTokens !== undefined || latencyMs !== undefined ? 1 : 0)
    return calls > 0 ? [{ calls, inputTokens, latencyMs }] : []
  })
  const totalRequestCalls = requestSamples.reduce((sum, sample) => sum + sample.calls, 0)
  const totalInputTokens = requestSamples.reduce((sum, sample) => sum + (sample.inputTokens ?? 0), 0)
  const totalLatencyMs = requestSamples.reduce((sum, sample) => sum + (sample.latencyMs ?? 0), 0)
  const hitTokens = samples.map((sample) => sample.usage.cacheHitInputTokens).filter(isNumber).reduce((sum, value) => sum + value, 0)
  const missTokens = samples.map((sample) => sample.usage.cacheMissInputTokens).filter(isNumber).reduce((sum, value) => sum + value, 0)
  const retrievalRounds = samples.filter((sample) => phaseRunRequestsRead(sample.run)).length
  const contextTokens = totalRequestCalls === 0 ? undefined : totalInputTokens / totalRequestCalls
  const averageModelCalls = average(modelCalls)
  const latencyMs = totalRequestCalls === 0 ? undefined : totalLatencyMs / totalRequestCalls
  return {
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(averageModelCalls === undefined ? {} : { modelCalls: averageModelCalls }),
    ...(hitTokens + missTokens === 0 ? {} : { kvRate: hitTokens / (hitTokens + missTokens) }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(samples.length === 0 ? {} : { retrievalRounds }),
  }
}

function phaseRunRequestsRead(run: PhaseRunSnapshot): boolean {
  if (typeof run.result !== "object" || run.result === null) return false
  return (run.result as Record<string, unknown>).outcome === "request_read"
}

type PhaseUsageValues = Readonly<{
  modelCalls?: number
  inputTokens?: number
  outputTokens?: number
  lastRequestInputTokens?: number
  latencyMs?: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
}>

function readPhaseUsage(value: unknown): PhaseUsageValues {
  if (typeof value !== "object" || value === null) return {}
  const usage = value as Record<string, unknown>
  return {
    ...(isNumber(usage.modelCalls) ? { modelCalls: usage.modelCalls } : {}),
    ...(isNumber(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(isNumber(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
    ...(isNumber(usage.lastRequestInputTokens) ? { lastRequestInputTokens: usage.lastRequestInputTokens } : {}),
    ...(isNumber(usage.latencyMs) ? { latencyMs: usage.latencyMs } : {}),
    ...(isNumber(usage.cacheHitInputTokens) ? { cacheHitInputTokens: usage.cacheHitInputTokens } : {}),
    ...(isNumber(usage.cacheMissInputTokens) ? { cacheMissInputTokens: usage.cacheMissInputTokens } : {}),
  }
}

export type TaskTokenMetrics = Readonly<{
  kvRate?: number
  totalTokens?: number
  currentContextTokens?: number
}>

/** Aggregate phase-run usage for the right-rail world summary. */
export function summarizeTaskTokenMetrics(task: TaskSnapshot | undefined): TaskTokenMetrics {
  const runs = task?.phaseRuns ?? []
  if (runs.length === 0) return {}
  let inputTokens = 0
  let outputTokens = 0
  let hitTokens = 0
  let missTokens = 0
  let currentContextTokens: number | undefined
  for (const run of runs) {
    const usage = readPhaseUsage(run.usage)
    if (isNumber(usage.inputTokens)) inputTokens += usage.inputTokens
    if (isNumber(usage.outputTokens)) outputTokens += usage.outputTokens
    if (isNumber(usage.cacheHitInputTokens)) hitTokens += usage.cacheHitInputTokens
    if (isNumber(usage.cacheMissInputTokens)) missTokens += usage.cacheMissInputTokens
    const requestContext = usage.lastRequestInputTokens ?? usage.inputTokens
    if (isNumber(requestContext)) currentContextTokens = requestContext
  }
  const totalTokens = inputTokens + outputTokens
  return {
    ...(hitTokens + missTokens === 0 ? {} : { kvRate: hitTokens / (hitTokens + missTokens) }),
    ...(totalTokens === 0 ? {} : { totalTokens }),
    ...(currentContextTokens === undefined ? {} : { currentContextTokens }),
  }
}

/** Map synopsis discuss stream usage into right-rail token metrics. */
export function summarizeSynopsisStreamTokenMetrics(
  stream: SynopsisConversationStreamSnapshot | undefined,
): TaskTokenMetrics {
  return summarizeSynopsisUsageTokenMetrics(stream?.usage)
}

/** Map synopsis usage payload (stream or send result) into token metrics. */
export function summarizeSynopsisUsageTokenMetrics(
  usage: SynopsisConversationStreamSnapshot["usage"] | undefined,
): TaskTokenMetrics {
  if (usage === undefined) return {}
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const hitTokens = usage.cacheHitInputTokens ?? 0
  const missTokens = usage.cacheMissInputTokens ?? 0
  const totalTokens = inputTokens + outputTokens
  const currentContextTokens = usage.lastRequestInputTokens
    ?? (inputTokens > 0 ? inputTokens : undefined)
  return {
    ...(hitTokens + missTokens === 0
      ? {}
      : { kvRate: hitTokens / (hitTokens + missTokens) }),
    ...(totalTokens === 0 ? {} : { totalTokens }),
    ...(currentContextTokens === undefined ? {} : { currentContextTokens }),
  }
}

function formatContextWindow(current: number | undefined, maximum: number | undefined): string {
  const left = current === undefined ? "—" : formatCompactMetric(current)
  const right = maximum === undefined || maximum <= 0 ? "—" : formatCompactMetric(maximum)
  return `${left} / ${right}`
}

function phaseElapsedMs(run: PhaseRunSnapshot): number | undefined {
  return run.finishedAtMs === undefined ? undefined : Math.max(0, run.finishedAtMs - run.startedAtMs)
}

function isNumber(value: unknown): value is number {
  return value !== undefined && Number.isFinite(value)
}

function formatCompactMetric(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatPhaseDuration(valueMs: number): string {
  if (valueMs < 1000) return `${String(Math.round(valueMs))}ms`
  return `${(valueMs / 1000).toFixed(1)}s`
}

function CapacityRunDetails({ rewriteCount, complete }: { rewriteCount: number; complete: boolean }): React.JSX.Element {
  return <div className="phase-details capacity-run-details">
    <details>
      <summary className="sub-panel-summary">运行检查</summary>
      <p>{complete ? `机械容量检查已完成，局部重构 ${String(rewriteCount)} 轮。` : "等待候选结构后执行机械入度、出度检查。"}</p>
    </details>
  </div>
}

function PhasePending({ latestStatus }: { latestStatus: string | undefined }): React.JSX.Element {
  if (latestStatus === "running") {
    return <p className="phase-empty">已向模型发起请求，等待 AI 返回思考记录与正式输出。</p>
  }
  return <p className="phase-empty">尚未进入该阶段；进入后会先显示请求态，返回后再展开 AI 思考与 AI 输出。</p>
}

function PhaseDetails({ result }: { result: unknown }): React.JSX.Element {
  const value = typeof result === "object" && result !== null ? result as Record<string, unknown> : {}
  const artifact = typeof value.artifact === "object" && value.artifact !== null
    ? value.artifact as Record<string, unknown>
    : undefined
  const continuityAdvice = Array.isArray(artifact?.continuityAdvice)
    ? artifact.continuityAdvice
    : []
  const modelReasoning = typeof value.modelReasoning === "string" && value.modelReasoning.trim().length > 0
    ? value.modelReasoning
    : "该模型未返回可展示的思考内容。"
  const reasoningLabel = value.modelReasoningKind === "provider_summary" ? "AI 思考摘要" : "AI 思考"
  const { modelReasoning: _modelReasoning, modelReasoningKind: _modelReasoningKind, ...structuredOutput } = value
  const output = value.rawModelOutput ?? (typeof result === "object" && result !== null ? structuredOutput : result)
  return <div className="phase-details">
    <p className="phase-note">展开后可查看该阶段的模型思考记录与正式输出，默认折叠，避免占满右侧面板。</p>
    {continuityAdvice.length === 0 ? null : <ContinuityAdvicePanel advice={continuityAdvice} />}
    <details>
      <summary className="sub-panel-summary">{reasoningLabel}</summary>
      <div className="phase-reasoning-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{modelReasoning}</ReactMarkdown></div>
    </details>
    <details>
      <summary className="sub-panel-summary">AI 输出</summary>
      <pre>{typeof output === "string" ? output : formatJson(output, "暂无输出")}</pre>
    </details>
  </div>
}

function ContinuityAdvicePanel({ advice }: { advice: readonly unknown[] }): React.JSX.Element {
  return <details className="continuity-advice">
    <summary className="sub-panel-summary">连续性建议</summary>
    <div className="continuity-advice-list">{advice.map((item, index) => {
      const value = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}
      const evidenceRefs = Array.isArray(value.evidenceRefs)
        ? value.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
        : []
      return <article className="continuity-advice-item" key={typeof value.claimRef === "string" ? value.claimRef : index}>
        {typeof value.proseExcerpt === "string" ? <blockquote>{value.proseExcerpt}</blockquote> : null}
        <p><strong>{continuityVerdictLabel(value.verdict)}</strong>{typeof value.summary === "string" ? ` · ${value.summary}` : ""}</p>
        {evidenceRefs.length === 0 ? null : <p><small>依据：{evidenceRefs.join("、")}</small></p>}
        {typeof value.suggestedDirection === "string" ? <p>建议：{value.suggestedDirection}</p> : null}
      </article>
    })}</div>
  </details>
}

function continuityVerdictLabel(verdict: unknown): string {
  if (verdict === "pass") return "一致"
  if (verdict === "conflict") return "冲突"
  return "不确定"
}

function formatJson(value: unknown, fallback: string): string {
  return JSON.stringify(value, null, 2) || fallback
}

function EvolutionPanel(): React.JSX.Element {
  return <div className="evolution-panel">
    <div className="evolution-time"><small>当前世界时间</small><strong>随已提交章节推进</strong></div>
    <div className="evolution-entry"><GitBranch size={16} /><div><strong>当前没有可展示的演化投影</strong><p>后台不会为制造宏大感而补齐所有事实。出现与当前任务相关、可追溯的自主变化后，将在此显示影响路径和认知边界。</p></div></div>
    <div className="evolution-entry muted"><GitBranch size={16} /><div><strong>显示逻辑</strong><p>这里不是事件列表，而是世界已到达、可追溯、可回写的自治变化投影。</p></div></div>
  </div>
}
