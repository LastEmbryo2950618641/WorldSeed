import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2, RefreshCw, RotateCcw, X } from "lucide-react"
import type { ChapterReviewRevisionPayload, GraphRevisionTask } from "@worldseed/contracts"
import { invokeBackend, type OpenProject } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"

const statuses: Record<string, string> = {
  pending: "待同步", running: "同步中", completed: "已完成", failed: "待重试",
  cancelled: "已取消", interrupted: "已中断", retired: "已撤销",
}
const activityLabels = { waiting: "等待模型响应", thinking: "模型思考中", responding: "正在接收结果", repairing: "正在修正输出" }

function elapsedText(startedAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
  return seconds < 60 ? `${String(seconds)} 秒` : `${String(Math.floor(seconds / 60))} 分 ${String(seconds % 60)} 秒`
}
const phaseLabels: Record<string, string> = {
  interpret: "理解章节修订", rule_assembly: "装配规则", source_retrieval: "检索资料",
  emergence_planning: "规划内容", emergence_review: "审查内容", dependency_audit: "分析依赖与影响",
  graph_governance: "准备修订与证据", graph_structure_plan: "生成图变更",
  graph_capacity_rewrite: "重构局部结构", graph_spacetime_settlement: "结算时空与历史",
  graph_retrieval_design: "更新查询索引", graph_governance_review: "独立审核与查询验证",
  settlement_review: "审核结算", frontier_settlement: "更新推演前沿", commit_review: "校验并提交",
}

export function GraphRevisionTasksPanel({ project, model, onChanged }: {
  project: OpenProject | undefined
  model?: ChapterReviewRevisionPayload["model"]
  onChanged?: (() => Promise<void>) | undefined
}): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly GraphRevisionTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [pending, setPending] = useState<Record<string, string>>({})
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const operations = useRef(new Set<string>())
  useEffect(() => {
    const current = ++generation.current
    setTasks([])
    setLoading(true)
    setError(undefined)
    setLoadError(undefined)
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = project === undefined ? [] : await invokeBackend<readonly GraphRevisionTask[]>("chapter.graphRevision.list", project)
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

  const act = async (task: GraphRevisionTask, action: "cancel" | "retry"): Promise<void> => {
    if (project === undefined || operations.current.has(task.revisionTaskId)) return
    const current = generation.current
    operations.current.add(task.revisionTaskId)
    setPending((previous) => ({ ...previous, [task.revisionTaskId]: action }))
    setError(undefined)
    try {
      await invokeBackend(`chapter.graphRevision.${action}`, {
        ...project, revisionTaskId: task.revisionTaskId,
        ...(action === "retry" && model !== undefined ? { model } : {}),
      })
      if (generation.current !== current) return
      setRefresh((value) => value + 1)
      await onChanged?.()
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      operations.current.delete(task.revisionTaskId)
      setPending((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== task.revisionTaskId)))
    }
  }
  return <section className="graph-revision-panel" aria-label="图修订任务" data-testid="graph-revision-panel">
    <header className="graph-revision-heading">
      <strong>图修订任务 <span>{tasks.length}</span></strong>
      <UiTooltip label="刷新任务"><button type="button" aria-label="刷新图修订任务" onClick={() => { setRefresh((value) => value + 1) }}><RefreshCw size={15} /></button></UiTooltip>
    </header>
    {error === undefined ? null : <p role="alert" className="graph-revision-error">{error}</p>}
    {loadError === undefined ? null : <p role="alert" className="graph-revision-error">{loadError}</p>}
    {loading && tasks.length === 0 ? <p className="graph-revision-empty">正在读取任务…</p> : null}
    {!loading && tasks.length === 0 ? <p className="graph-revision-empty">{project === undefined ? "请先打开项目" : "暂无图修订任务"}</p> : null}
    {tasks.map((task) => {
      const busy = pending[task.revisionTaskId]
      const { progress } = task
      const activity = task.status === "running" ? task.activity : undefined
      const current = progress.completed + Number(task.status === "running" && progress.phases.some((phase) => phase.status === "running"))
      return <article className="graph-revision-task" key={task.revisionTaskId} data-testid="graph-revision-task">
        <div className="graph-revision-title"><strong>{task.heading}</strong><span className={`graph-revision-status is-${task.status}`}>{statuses[task.status] ?? task.status}</span></div>
        <div className="graph-revision-progress" aria-live="polite">
          {task.status === "running" ? <Loader2 size={14} className="graph-revision-spinner" /> : task.status === "completed" ? <CheckCircle2 size={14} /> : null}
          <span>{task.status === "completed" ? "同步完成" : phaseLabels[progress.phase ?? ""] ?? "等待图同步"}…（{current}/{progress.total ?? "待定"}）</span>
        </div>
        {progress.total !== null && progress.total > 0 ? <progress aria-label={`${task.heading}同步进度`} max={progress.total} value={current} /> : null}
        {activity === undefined ? null : <div className="graph-revision-activity" role="status">
          <span>{activityLabels[activity.stage]} · 第 {activity.attempt} 次请求</span>
          <span>本阶段已用 {elapsedText(activity.startedAtMs)} · {activity.reasoningCharacters + activity.contentCharacters === 0 ? `等待数据 ${elapsedText(activity.lastActivityAtMs)}` : `最近响应 ${elapsedText(activity.lastActivityAtMs)}前`}</span>
          {activity.reasoningCharacters + activity.contentCharacters === 0 ? null : <span>已接收思考 {activity.reasoningCharacters.toLocaleString("zh-CN")} 字符 · 结果 {activity.contentCharacters.toLocaleString("zh-CN")} 字符</span>}
        </div>}
        {task.blocksTurn ? <p className="graph-revision-blocker">世界图尚未同步，暂不能开始新推演</p> : null}
        {task.error === undefined ? null : <p className="graph-revision-error">{task.error}</p>}
        {progress.phases.length > 0 ? <details><summary>阶段记录</summary><ol>{progress.phases.map((phase) => <li key={phase.phase}><span>{phaseLabels[phase.phase] ?? phase.phase}</span><span>{phase.status === "completed" ? "完成" : phase.status === "running" ? (activity?.phase === phase.phase ? `${activityLabels[activity.stage]} · 第 ${String(activity.attempt)} 次请求` : task.status === "running" ? "进行中" : "已停止") : phase.status === "cancelled" ? "已取消" : "未完成"}{phase.attempt > 1 ? ` · 阶段第 ${String(phase.attempt)} 次` : ""}</span></li>)}</ol></details> : null}
        <footer><time dateTime={new Date(task.updatedAtMs).toISOString()}>{new Date(task.updatedAtMs).toLocaleString("zh-CN", { hour12: false })}</time><div>
          <button type="button" disabled={!task.canCancel || busy !== undefined} onClick={() => { void act(task, "cancel") }}><X size={14} />{busy === "cancel" ? "取消中" : "取消"}</button>
          <button type="button" disabled={!task.canRetry || busy !== undefined} onClick={() => { void act(task, "retry") }}><RotateCcw size={14} />{busy === "retry" ? "提交中" : "重试"}</button>
        </div></footer>
      </article>
    })}
  </section>
}
