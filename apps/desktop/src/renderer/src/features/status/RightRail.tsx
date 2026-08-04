import { Activity, Check, Circle, GitBranch, LoaderCircle, Network, Orbit } from "lucide-react"
import { aiPhaseValues } from "@worldseed/contracts"

import type { GraphSlice, TaskSnapshot } from "../../api/client.js"
import { useWorkbenchStore, type RightTab } from "../../state/workbench-store.js"
import { WorldGraph } from "./WorldGraph.js"

type Props = Readonly<{ task: TaskSnapshot | undefined; graphSlice: GraphSlice | undefined }>

const labels: Record<string, string> = {
  interpret: "理解用户输入",
  rule_assembly: "装配规则快照",
  source_retrieval: "选择性读取资料",
  emergence_planning: "规划内容出现",
  emergence_review: "审查出现依据",
  draft: "撰写正文",
  chapter_naming: "生成章节标题",
  dependency_audit: "检查依赖闭合",
  graph_governance: "治理世界图",
  semantic_review: "语义一致性复核",
  settlement_review: "结算资料返回路径",
  frontier_settlement: "结算演化前沿",
  commit_review: "最终提交审查",
}

export function RightRail({ task, graphSlice }: Props): React.JSX.Element {
  const tab = useWorkbenchStore((state) => state.rightTab)
  const setTab = useWorkbenchStore((state) => state.setRightTab)
  return <aside className="right-rail">
    <div className="right-tabs">
      <Tab id="process" tab={tab} onChange={setTab} icon={<Activity size={15} />} label="流程" />
      <Tab id="graph" tab={tab} onChange={setTab} icon={<Network size={15} />} label="世界图" />
      <Tab id="evolution" tab={tab} onChange={setTab} icon={<Orbit size={15} />} label="自洽演化" />
    </div>
    <div className="right-content">
      {tab === "process" ? <ProcessPanel task={task} /> : tab === "graph" ? <WorldGraph slice={graphSlice} /> : <EvolutionPanel />}
    </div>
    <div className="world-summary"><span>世界时间 <strong>当前章节锚点</strong></span><span>图局部 <strong>{graphSlice === undefined ? "未读取" : `${String(graphSlice.nodes.length)} 节点 / ${String(graphSlice.links.length)} 连接`}</strong></span><span>任务状态 <strong>{task?.status ?? "未运行"}</strong></span></div>
  </aside>
}

function Tab({ id, tab, onChange, icon, label }: { id: RightTab; tab: RightTab; onChange: (tab: RightTab) => void; icon: React.ReactNode; label: string }): React.JSX.Element {
  return <button className={tab === id ? "active" : ""} onClick={() => { onChange(id); }}>{icon}{label}</button>
}

function ProcessPanel({ task }: { task: TaskSnapshot | undefined }): React.JSX.Element {
  const completed = task?.status === "completed"
  const currentIndex = completed ? aiPhaseValues.length - 1 : Math.max(-1, aiPhaseValues.indexOf(task?.lastPhase as never))
  const result = task?.result
  return <div className="process-panel">
    <div className="usage-grid">
      <span><small>模型调用</small><strong>{result?.modelCalls ?? "-"}</strong></span>
      <span><small>输入 Token</small><strong>{result?.inputTokens.toLocaleString() ?? "-"}</strong></span>
      <span><small>输出 Token</small><strong>{result?.outputTokens.toLocaleString() ?? "-"}</strong></span>
      <span><small>KV 命中率</small><strong>{result?.kvCacheHitRate === undefined ? "不可用" : `${String(Math.round(result.kvCacheHitRate * 100))}%`}</strong></span>
    </div>
    <div className="phase-list">{aiPhaseValues.map((phase, index) => {
      const isDone = completed || index < currentIndex
      const isCurrent = !completed && index === currentIndex
      return <div className={`phase-row ${isDone ? "done" : isCurrent ? "current" : ""}`} key={phase}>
        <span className="phase-icon">{isDone ? <Check size={13} /> : isCurrent ? <LoaderCircle size={13} /> : <Circle size={10} />}</span>
        <span><strong>{phase}</strong><small>{labels[phase]}</small></span>
        <em>{isDone ? "已完成" : isCurrent ? "进行中" : "等待"}</em>
      </div>
    })}</div>
    {task?.error?.message === undefined ? null : <p className="task-error">{task.error.message}</p>}
  </div>
}

function EvolutionPanel(): React.JSX.Element {
  return <div className="evolution-panel">
    <div className="evolution-time"><small>当前世界时间</small><strong>随已提交章节推进</strong></div>
    <div className="evolution-entry"><GitBranch size={16} /><div><strong>当前没有可展示的演化投影</strong><p>后台不会为制造宏大感而补齐所有事实。出现与当前任务相关、可追溯的自主变化后，将在此显示影响路径和认知边界。</p></div></div>
  </div>
}
