import { useEffect, useState } from "react"
import { Activity, Check, Circle, GitBranch, History, LoaderCircle, Network, Orbit } from "lucide-react"
import { aiPhaseValues, type HistoryOverview, type ProjectSettings, type ResettableRuntimeMetricId } from "@worldseed/contracts"

import type { GraphSlice, TaskSnapshot } from "../../api/client.js"
import { useWorkbenchStore, type RightTab } from "../../state/workbench-store.js"
import { WorldGraph } from "./WorldGraph.js"
import { HistoryPanel } from "./HistoryPanel.js"
import { RuntimeMonitor, TaskCheckpointDialog } from "./TaskCheckpointPrototype.js"

type Props = Readonly<{
  task: TaskSnapshot | undefined
  graphSlice: GraphSlice | undefined
  graphSettings?: ProjectSettings["graph"] | undefined
  historyRetentionLimit?: number | null | undefined
  history?: HistoryOverview | undefined
  historyLoading?: boolean | undefined
  onOpenProjectSettings?(): void
  onResumeTask?(mode: "continue" | "retry_phase"): Promise<void>
  onResetTaskMetrics?(metricIds: readonly ResettableRuntimeMetricId[]): Promise<void>
  onPauseTask?(): Promise<void>
  onSaveHistory?(): Promise<void>
  onRestoreHistory?(entryId: string): Promise<void>
  onContinueFromHistory?(entryId: string): Promise<void>
  onReturnPreviousRound?(): Promise<void>
}>

const labels: Record<string, string> = {
  interpret: "理解用户输入",
  rule_assembly: "装配规则快照",
  source_retrieval: "选择性读取资料",
  emergence_planning: "规划内容出现",
  emergence_review: "审查出现依据",
  draft: "撰写正文",
  chapter_naming: "生成章节标题",
  dependency_audit: "检查依赖闭合",
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

export function RightRail({ task, graphSlice, graphSettings, historyRetentionLimit = null, history, historyLoading, onOpenProjectSettings, onResumeTask, onResetTaskMetrics, onPauseTask, onSaveHistory, onRestoreHistory, onContinueFromHistory, onReturnPreviousRound }: Props): React.JSX.Element {
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const tab = useWorkbenchStore((state) => state.rightTab)
  const setTab = useWorkbenchStore((state) => state.setRightTab)
  useEffect(() => {
    if (task?.status === "awaiting_user_decision") setCheckpointOpen(true)
  }, [task?.status])
  return <><aside className="right-rail">
    <div className="right-tabs">
      <Tab id="process" tab={tab} onChange={setTab} icon={<Activity size={15} />} label="流程" />
      <Tab id="graph" tab={tab} onChange={setTab} icon={<Network size={15} />} label="世界图" />
      <Tab id="evolution" tab={tab} onChange={setTab} icon={<Orbit size={15} />} label="自洽演化" />
      <Tab id="history" tab={tab} onChange={setTab} icon={<History size={15} />} label="历史" />
    </div>
    <div className="right-content">
      {tab === "process" ? <ProcessPanel task={task} onOpenCheckpoint={() => { setCheckpointOpen(true); }} onResetMetrics={onResetTaskMetrics} /> : null}
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
    <div className="world-summary"><span>世界时间 <strong>当前章节锚点</strong></span><span>图局部 <strong>{graphSlice === undefined ? "未读取" : `${String(graphSlice.nodes.length)} 节点 / ${String(graphSlice.links.length)} 连接`}</strong></span><span>任务状态 <strong>{task?.status ?? "未运行"}</strong></span></div>
  </aside>{checkpointOpen && task !== undefined ? <TaskCheckpointDialog
    task={task}
    onClose={() => { setCheckpointOpen(false); }}
    onResume={onResumeTask ?? (() => Promise.reject(new Error("恢复接口尚未连接")))}
    onResetMetrics={onResetTaskMetrics ?? (() => Promise.reject(new Error("指标重置接口尚未连接")))}
    onPause={onPauseTask ?? (() => Promise.reject(new Error("暂停接口尚未连接")))}
  /> : null}</>
}

function Tab({ id, tab, onChange, icon, label }: { id: RightTab; tab: RightTab; onChange: (tab: RightTab) => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return <button className={tab === id ? "active" : ""} onClick={() => { onChange(id); }}>{icon}{label}</button>
}

function ProcessPanel({ task, onOpenCheckpoint, onResetMetrics }: { task: TaskSnapshot | undefined; onOpenCheckpoint: () => void; onResetMetrics?: ((metricIds: readonly ResettableRuntimeMetricId[]) => Promise<void>) | undefined }): React.JSX.Element {
  return <div className="process-panel">
    <RuntimeMonitor task={task} onOpenCheckpoint={onOpenCheckpoint} onResetMetrics={onResetMetrics} />
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
          <span className="phase-icon">{isDone ? <Check size={13} /> : isCurrent ? <LoaderCircle size={13} /> : <Circle size={10} />}</span>
          <span><strong>{phase}</strong><small>{labels[phase]}</small></span>
          <em>{latest?.status === "failed" ? "失败" : isDone ? "已完成" : isCurrent ? "进行中" : "等待"}</em>
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
      <span className="phase-icon">{done ? <Check size={13} /> : active === undefined ? <Circle size={10} /> : <LoaderCircle size={13} />}</span>
      <span><strong>graph_governance</strong><small>分步治理世界图</small></span>
      <em>{done ? "已完成" : runs.length === 0 ? "等待" : "进行中"}</em>
    </summary>
    <div className="governance-step-list">{steps.map((step) => {
      const phaseRuns = step.kind === "ai" ? runs.filter((run) => run.phase === step.id) : []
      const latest = phaseRuns.at(-1)
      const mechanicalComplete = step.id === "graph_capacity_assessment"
        ? completed.has("graph_structure_plan")
        : completed.has("graph_structure_plan") && (capacityRuns.length === 0 || completed.has("graph_capacity_rewrite"))
      const stepDone = step.kind === "mechanical" ? mechanicalComplete : latest?.status === "completed"
      const stepCurrent = latest?.status === "running" || latest?.status === "failed"
      const skipped = step.id === "graph_capacity_rewrite" && completed.has("graph_spacetime_settlement") && capacityRuns.length === 0
      return <details className={`governance-step ${stepDone ? "done" : stepCurrent ? "current" : ""}`} key={step.id}>
        <summary>
          <span>{stepDone ? <Check size={12} /> : stepCurrent ? <LoaderCircle size={12} /> : <Circle size={9} />}</span>
          <strong>{step.label}</strong>
          <em>{skipped ? "未触发" : stepDone ? "已完成" : stepCurrent ? "进行中" : "等待"}</em>
        </summary>
        {step.kind === "mechanical"
          ? <CapacityRunDetails rewriteCount={capacityRuns.length} complete={mechanicalComplete} />
          : latest?.result === undefined ? <PhasePending latestStatus={latest?.status} /> : <PhaseDetails result={latest.result} />}
      </details>
    })}</div>
  </details>
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
    return <p className="phase-empty">已向模型发起请求，等待 AI 返回结构化思考与输出。</p>
  }
  return <p className="phase-empty">尚未进入该阶段；进入后会先显示请求态，返回后再展开 AI 思考与 AI 输出。</p>
}

function PhaseDetails({ result }: { result: unknown }): React.JSX.Element {
  const value = typeof result === "object" && result !== null ? result as Record<string, unknown> : {}
  const thought = {
    modelReasoning: value.modelReasoning,
    reason: value.reason,
    selfReview: value.selfReview,
    requestedReads: value.requestedReads,
    unresolvedDependencies: value.unresolvedDependencies,
  }
  const output = value.rawModelOutput ?? value.artifact ?? value
  return <div className="phase-details">
    <p className="phase-note">展开后可查看该阶段的 AI 思考摘要与原始输出，默认折叠，避免占满右侧面板。</p>
    <details>
      <summary className="sub-panel-summary">AI 思考</summary>
      <pre>{formatJson(thought, "暂无结构化思考结果")}</pre>
    </details>
    <details>
      <summary className="sub-panel-summary">AI 输出</summary>
      <pre>{typeof output === "string" ? output : formatJson(output, "暂无输出")}</pre>
    </details>
  </div>
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
