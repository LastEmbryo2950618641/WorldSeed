import { useEffect, useState } from "react"
import { Activity, Check, Circle, GitBranch, History, LoaderCircle, Network, Orbit } from "lucide-react"
import { aiPhaseValues, type ProjectSettings } from "@worldseed/contracts"

import type { GraphSlice, TaskSnapshot } from "../../api/client.js"
import { useWorkbenchStore, type RightTab } from "../../state/workbench-store.js"
import { WorldGraph } from "./WorldGraph.js"
import { HistoryPanel } from "./HistoryPanel.js"
import { RuntimeMonitor, TaskCheckpointDialog } from "./TaskCheckpointPrototype.js"

type Props = Readonly<{
  task: TaskSnapshot | undefined
  graphSlice: GraphSlice | undefined
  graphSettings?: ProjectSettings["graph"] | undefined
  executionSettings?: ProjectSettings["execution"] | undefined
  historyRetentionLimit?: number | null | undefined
  onOpenProjectSettings?(): void
  onResumeTask?(mode: "continue" | "retry_phase", resetMetricIds: readonly string[]): Promise<void>
  onPauseTask?(): Promise<void>
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
  semantic_review: "语义一致性复核",
  settlement_review: "结算资料返回路径",
  frontier_settlement: "结算演化前沿",
  commit_review: "最终提交审查",
  context_compaction: "压缩动态上下文",
  context_compaction_review: "复核压缩结果",
}

export function RightRail({ task, graphSlice, graphSettings, executionSettings, historyRetentionLimit = null, onOpenProjectSettings, onResumeTask, onPauseTask }: Props): React.JSX.Element {
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
      {tab === "process" ? <ProcessPanel task={task} executionSettings={executionSettings} onOpenCheckpoint={() => { setCheckpointOpen(true); }} /> : null}
      {tab === "graph" ? <WorldGraph slice={graphSlice} settings={graphSettings} /> : null}
      {tab === "evolution" ? <EvolutionPanel /> : null}
      {tab === "history" ? <HistoryPanel retentionLimit={historyRetentionLimit} taskRunning={task?.status === "running"} onOpenSettings={onOpenProjectSettings ?? (() => undefined)} onOpenCheckpoint={() => { setCheckpointOpen(true); }} /> : null}
    </div>
    <div className="world-summary"><span>世界时间 <strong>当前章节锚点</strong></span><span>图局部 <strong>{graphSlice === undefined ? "未读取" : `${String(graphSlice.nodes.length)} 节点 / ${String(graphSlice.links.length)} 连接`}</strong></span><span>任务状态 <strong>{task?.status ?? "未运行"}</strong></span></div>
  </aside>{checkpointOpen && task !== undefined ? <TaskCheckpointDialog
    task={task}
    {...(executionSettings === undefined ? {} : { executionLimits: executionSettings })}
    onClose={() => { setCheckpointOpen(false); }}
    onResume={onResumeTask ?? (() => Promise.reject(new Error("恢复接口尚未连接")))}
    onPause={onPauseTask ?? (() => Promise.reject(new Error("暂停接口尚未连接")))}
  /> : null}</>
}

function Tab({ id, tab, onChange, icon, label }: { id: RightTab; tab: RightTab; onChange: (tab: RightTab) => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return <button className={tab === id ? "active" : ""} onClick={() => { onChange(id); }}>{icon}{label}</button>
}

function ProcessPanel({ task, executionSettings, onOpenCheckpoint }: { task: TaskSnapshot | undefined; executionSettings?: ProjectSettings["execution"] | undefined; onOpenCheckpoint: () => void }): React.JSX.Element {
  return <div className="process-panel">
    <RuntimeMonitor task={task} {...(executionSettings === undefined ? {} : { executionLimits: executionSettings })} onOpenCheckpoint={onOpenCheckpoint} />
    <div className="phase-list">{aiPhaseValues.map((phase) => {
      const runs = task?.phaseRuns?.filter((run) => run.phase === phase) ?? []
      const latest = runs.at(-1)
      const isDone = latest?.status === "completed"
      const isCurrent = latest?.status === "running" || latest?.status === "failed"
      return <details className={`phase-detail ${isDone ? "done" : isCurrent ? "current" : ""}`} key={phase}>
        <summary className={`phase-row ${isDone ? "done" : isCurrent ? "current" : ""}`}>
          <span className="phase-icon">{isDone ? <Check size={13} /> : isCurrent ? <LoaderCircle size={13} /> : <Circle size={10} />}</span>
          <span><strong>{phase}</strong><small>{labels[phase]}</small></span>
          <em>{latest?.status === "failed" ? "失败" : isDone ? "已完成" : isCurrent ? "进行中" : "等待"}</em>
        </summary>
        {latest?.result === undefined ? <PhasePending latestStatus={latest?.status} /> : <PhaseDetails result={latest.result} />}
      </details>
    })}</div>
    {task?.error?.message === undefined ? null : <p className="task-error">{task.error.message}</p>}
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
