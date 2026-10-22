import { useEffect, useRef, useState } from "react"
import { AlertCircle, Check, CheckCircle2, Circle, Loader2, RefreshCw, RotateCcw, X } from "lucide-react"
import type { DeductionTask, ResettableRuntimeMetricId } from "@worldseed/contracts"
import { invokeBackend, type OpenProject, type TaskSnapshot } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"
import { PhaseIoDetails, PhaseIoPending } from "./phase-io-details.js"
import { RuntimeMonitor } from "./TaskCheckpointPrototype.js"

const statuses: Record<string, string> = {
  created: "已创建",
  running: "推演中",
  waiting_for_model: "等待模型",
  waiting_for_read: "等待读取",
  waiting_for_review: "等待审查",
  paused: "已暂停",
  awaiting_user_decision: "待处理",
  committing: "提交中",
  needs_revision: "需修订",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

const phaseLabels: Record<string, string> = {
  interpret: "理解用户输入",
  rule_assembly: "装配规则快照",
  source_retrieval: "选择性检索资料",
  emergence_planning: "规划内容出现",
  emergence_review: "审查出现依据",
  draft: "生成新草稿",
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

function formatPanelError(message: string): string {
  if (!message.includes("invalid_value") && !message.includes("turn.list")) return message
  return "正文推演任务列表接口尚未加载（turn.list）。请重启应用后再试。"
}

type PhaseVisualKind = "done" | "failed" | "running" | "idle"

function phaseVisual(status: string): { kind: PhaseVisualKind; css: string } {
  if (status === "completed") return { kind: "done", css: "done" }
  if (status === "failed" || status === "cancelled") return { kind: "failed", css: "failed" }
  if (status === "running") return { kind: "running", css: "current" }
  return { kind: "idle", css: "" }
}

function PhaseStatusIcon({ state }: { state: PhaseVisualKind }): React.JSX.Element {
  if (state === "done") return <Check size={13} />
  if (state === "failed") return <AlertCircle size={13} aria-label="失败" />
  if (state === "running") return <span className="phase-spinner" aria-hidden="true" />
  return <Circle size={10} />
}

function DeductionStageRecord({
  task,
  project,
  onResetMetrics,
}: {
  task: DeductionTask
  project: OpenProject | undefined
  onResetMetrics?: ((metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>) | undefined
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>()
  useEffect(() => {
    if (project === undefined) {
      setSnapshot(undefined)
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await invokeBackend<TaskSnapshot>("turn.status", { taskId: task.taskId })
        if (!disposed) setSnapshot(next)
      } catch {
        if (!disposed) setSnapshot(undefined)
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll() }, 1500)
      }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [project?.projectId, project?.workspaceRootRef, task.taskId])

  return <div className="graph-revision-stage-record" data-testid="deduction-stage-record">
    <RuntimeMonitor task={snapshot} onResetMetrics={onResetMetrics} />
    <div className="phase-list">
      {task.progress.phases.map((phase) => {
        const visual = phaseVisual(phase.status)
        const runs = snapshot?.phaseRuns?.filter((run) => run.phase === phase.phase) ?? []
        const latest = runs.at(-1)
        const label = phaseLabels[phase.phase] ?? phase.phase
        return <details className={`phase-detail ${visual.css}`} key={phase.phase}>
          <summary className={`phase-row ${visual.css}`}>
            <span className="phase-icon" aria-hidden="true"><PhaseStatusIcon state={visual.kind} /></span>
            <span className="phase-row-copy"><strong>{label}</strong></span>
          </summary>
          {latest?.result === undefined
            ? <PhaseIoPending latestStatus={latest?.status ?? phase.status} visualKind={visual.kind} />
            : <PhaseIoDetails result={latest.result} />}
        </details>
      })}
    </div>
  </div>
}

export function DeductionTasksPanel({
  project,
  onResetMetrics,
  onChanged,
}: {
  project: OpenProject | undefined
  onResetMetrics?: ((metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>) | undefined
  onChanged?: (() => Promise<void>) | undefined
}): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly DeductionTask[]>([])
  const [loading, setLoading] = useState(project !== undefined)
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [pending, setPending] = useState<Record<string, string>>({})
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const operations = useRef(new Set<string>())

  useEffect(() => {
    const current = ++generation.current
    setTasks([])
    setError(undefined)
    setLoadError(undefined)
    if (project === undefined) {
      setLoading(false)
      return
    }
    setLoading(true)
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await invokeBackend<readonly DeductionTask[]>("turn.list", project)
        if (!disposed && generation.current === current) { setTasks(next); setLoadError(undefined) }
      } catch (cause) {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(() => { void poll() }, 1500) }
      }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [project?.projectId, project?.workspaceRootRef, refresh])

  const act = async (task: DeductionTask, action: "cancel" | "retry"): Promise<void> => {
    if (project === undefined || operations.current.has(task.taskId)) return
    const current = generation.current
    operations.current.add(task.taskId)
    setPending((previous) => ({ ...previous, [task.taskId]: action }))
    setError(undefined)
    try {
      if (action === "cancel") {
        await invokeBackend("turn.cancel", { taskId: task.taskId })
      } else {
        await invokeBackend("turn.resume", { taskId: task.taskId, mode: "continue" })
      }
      if (generation.current !== current) return
      setRefresh((value) => value + 1)
      await onChanged?.()
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      operations.current.delete(task.taskId)
      setPending((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== task.taskId)))
    }
  }

  return <section className="graph-revision-panel" aria-label="正文推演任务" data-testid="deduction-tasks-panel">
    <header className="graph-revision-heading">
      <strong>正文推演任务 <span>{tasks.length}</span></strong>
      <UiTooltip label="刷新任务"><button type="button" aria-label="刷新正文推演任务" onClick={() => { setRefresh((value) => value + 1) }}><RefreshCw size={15} /></button></UiTooltip>
    </header>
    {error === undefined ? null : <p role="alert" className="graph-revision-error">{formatPanelError(error)}</p>}
    {loadError === undefined ? null : <p role="alert" className="graph-revision-error">{formatPanelError(loadError)}</p>}
    {loading && tasks.length === 0 ? <p className="graph-revision-empty">正在读取任务…</p> : null}
    {!loading && tasks.length === 0 ? <p className="graph-revision-empty">{project === undefined ? "请先打开项目" : "暂无正文推演任务"}</p> : null}
    {tasks.map((task) => {
      const busy = pending[task.taskId]
      const { progress } = task
      const current = progress.completed + Number(
        (task.status === "running" || task.status === "waiting_for_model" || task.status === "waiting_for_read")
        && progress.phases.some((phase) => phase.status === "running"),
      )
      const phaseLabel = phaseLabels[progress.phase ?? ""] ?? "等待推演"
      const running = task.status === "running" || task.status === "waiting_for_model" || task.status === "waiting_for_read" || task.status === "committing"
      return <article className="graph-revision-task" key={task.taskId} data-testid="deduction-task">
        <div className="graph-revision-title">
          <strong>{task.heading}</strong>
          <span className={`graph-revision-status is-${task.status === "completed" ? "completed" : running ? "running" : task.status}`}>{statuses[task.status] ?? task.status}</span>
        </div>
        <div className="graph-revision-progress" aria-live="polite">
          {running ? <Loader2 size={14} className="graph-revision-spinner" /> : task.status === "completed" ? <CheckCircle2 size={14} /> : null}
          <span>{task.status === "completed" ? "推演完成" : phaseLabel}…（{current}/{progress.total ?? "待定"}）</span>
        </div>
        {progress.total !== null && progress.total > 0 ? <progress aria-label={`${task.heading}推演进度`} max={progress.total} value={current} /> : null}
        {task.error === undefined ? null : <p className="graph-revision-error">{task.error}</p>}
        {progress.phases.length > 0 ? <details className="graph-revision-stages">
          <summary>阶段记录</summary>
          <DeductionStageRecord task={task} project={project} onResetMetrics={onResetMetrics} />
        </details> : null}
        <footer>
          <time dateTime={new Date(task.updatedAtMs).toISOString()}>{new Date(task.updatedAtMs).toLocaleString("zh-CN", { hour12: false })}</time>
          <div>
            <button type="button" disabled={!task.canCancel || busy !== undefined} onClick={() => { void act(task, "cancel") }}>
              <X size={12} aria-hidden="true" />{busy === "cancel" ? "取消中" : "取消"}
            </button>
            <button type="button" disabled={!task.canRetry || busy !== undefined} onClick={() => { void act(task, "retry") }}>
              <RotateCcw size={12} aria-hidden="true" />{busy === "retry" ? "提交中" : "重试"}
            </button>
          </div>
        </footer>
      </article>
    })}
  </section>
}
