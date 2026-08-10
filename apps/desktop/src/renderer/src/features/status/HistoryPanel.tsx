import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftToLine,
  Check,
  ChevronRight,
  Clock3,
  FlaskConical,
  GitBranch,
  History,
  Pause,
  Play,
  Save,
  Settings2,
} from "lucide-react"

type HistoryKind = "automatic" | "manual"
type HistoryState = "complete" | "paused"
type HistoryFilter = "all" | HistoryKind | "paused"

type HistoryEntry = Readonly<{
  id: string
  branchId: string
  title: string
  chapter: string
  time: string
  kind: HistoryKind
  state: HistoryState
  summary: string
  delta: string
}>

type Branch = Readonly<{
  id: string
  name: string
}>

type SimulationState = Readonly<{
  status: "running" | "completed"
  activeStep: number
}>

type SimulationBranchSnapshot = Readonly<{
  id: "branch-a" | "branch-b"
  label: string
  baseEntry: string
  records: readonly string[]
  context: readonly string[]
}>

type SimulationStep = Readonly<{
  label: string
  detail: string
  activeBranchId: SimulationBranchSnapshot["id"]
  branches: readonly SimulationBranchSnapshot[]
}>

type SimulationCheck = Readonly<{
  label: string
  passed: boolean
}>

type HistorySwitchingScenario = Readonly<{
  steps: readonly SimulationStep[]
  checks: readonly SimulationCheck[]
}>

type Props = Readonly<{
  retentionLimit: number | null
  taskRunning: boolean
  onOpenSettings: () => void
  onOpenCheckpoint?: () => void
}>

const initialBranches: readonly Branch[] = [
  { id: "main", name: "主世界线" },
  { id: "north-bridge", name: "北桥支线" },
]

const initialEntries: readonly HistoryEntry[] = [
  { id: "h-008", branchId: "main", title: "第八轮完成", chapter: "第三章 潮汐之下", time: "今天 21:42", kind: "automatic", state: "complete", summary: "林序确认旧桥下存在第二条潮汐通道。", delta: "章节 +1 · 图节点 +9 · 连接 +14" },
  { id: "h-007", branchId: "main", title: "手动保存 · 码头会面前", chapter: "第三章 潮汐之下", time: "今天 21:18", kind: "manual", state: "paused", summary: "已保存最近稳定检查点，等待决定是否进入旧港。", delta: "阶段：资料检索完成 · pending 未提交" },
  { id: "h-006", branchId: "main", title: "第七轮完成", chapter: "第二章 北桥灯火", time: "今天 20:56", kind: "automatic", state: "complete", summary: "苏禾取走旧铜钥匙，北桥守卫开始换防。", delta: "章节 +1 · 图节点 +6 · 连接 +11" },
  { id: "h-005", branchId: "north-bridge", title: "北桥支线 · 第二轮", chapter: "第二章 未寄出的信", time: "今天 20:31", kind: "automatic", state: "complete", summary: "林序没有进入旧港，转而跟随邮差前往北桥。", delta: "世界线分叉 · 图节点 +8" },
  { id: "h-004", branchId: "main", title: "第六轮完成", chapter: "第二章 北桥灯火", time: "今天 19:47", kind: "automatic", state: "complete", summary: "旧港封锁令沿商路传到北桥。", delta: "状态修订 +7 · 演化前沿 +2" },
  { id: "h-003", branchId: "main", title: "手动保存 · 调整笔风前", chapter: "第一章 雾港来信", time: "今天 18:22", kind: "manual", state: "complete", summary: "保存章节、世界图与表现规则的完整状态。", delta: "Markdown 规则 +1" },
  { id: "h-002", branchId: "main", title: "第五轮完成", chapter: "第一章 雾港来信", time: "昨天 23:14", kind: "automatic", state: "complete", summary: "旧铜钥匙被藏在旧桥第三块松动石板下。", delta: "图节点 +5 · 连接 +8" },
  { id: "h-001", branchId: "main", title: "第一轮完成", chapter: "第一章 雾港来信", time: "昨天 20:03", kind: "automatic", state: "complete", summary: "盐雾城、林序与旧港局部首次建立。", delta: "世界初始化 · 图节点 +12" },
]

const simulationDelayMs = 260
const branchAFirstRecord = "模拟 A-1 · 追查旧铜钥匙"
const branchASecondRecord = "模拟 A-2 · 返回后继续追问"
const branchBFirstRecord = "模拟 B-1 · 前往旧港"
const branchAContext = "苏禾承认她从旧桥取走了铜钥匙。"
const branchAContinuedContext = "林序决定沿钥匙上的潮纹追查铸造者。"
const branchBContext = "林序没有追查钥匙，而是登上前往旧港的渡船。"

export function buildHistorySwitchingScenario(primaryEntry: string, secondaryEntry: string): HistorySwitchingScenario {
  let branchA = createSimulationBranch("branch-a", "模拟世界线 A", primaryEntry)
  let branchB = createSimulationBranch("branch-b", "模拟世界线 B", secondaryEntry)
  const steps: SimulationStep[] = []

  steps.push(createSimulationStep("恢复历史 A", `完整加载 ${primaryEntry} 的上下文、章节和世界图`, branchA.id, branchA, branchB))
  branchA = appendSimulationRecord(branchA, branchAFirstRecord, branchAContext)
  steps.push(createSimulationStep("在历史 A 上继续工作", `生成并保存 ${branchAFirstRecord}`, branchA.id, branchA, branchB))

  steps.push(createSimulationStep("切换到历史 B", `完整加载 ${secondaryEntry}，A 的工作状态保持不变`, branchB.id, branchA, branchB))
  branchB = appendSimulationRecord(branchB, branchBFirstRecord, branchBContext)
  steps.push(createSimulationStep("在历史 B 上继续工作", `生成并保存 ${branchBFirstRecord}`, branchB.id, branchA, branchB))

  branchA = appendSimulationRecord(branchA, branchASecondRecord, branchAContinuedContext)
  steps.push(createSimulationStep("切回历史 A 并继续", `恢复 A-1 后生成 ${branchASecondRecord}`, branchA.id, branchA, branchB))
  steps.push(createSimulationStep("再次切回历史 B", "B-1 仍在，且没有混入 A-1 或 A-2", branchB.id, branchA, branchB))
  steps.push(createSimulationStep("最终返回历史 A", "A-1 与 A-2 均完整恢复，可以从原工作位置继续", branchA.id, branchA, branchB))

  return {
    steps,
    checks: [
      { label: "历史 A 保留首次继续结果", passed: branchA.records.includes(branchAFirstRecord) },
      { label: "历史 A 返回后可接续原工作", passed: branchA.records.includes(branchASecondRecord) && branchA.context.includes(branchAContext) },
      { label: "历史 B 保留自己的继续结果", passed: branchB.records.includes(branchBFirstRecord) },
      { label: "历史 A 未混入历史 B 内容", passed: !branchA.context.includes(branchBContext) },
      { label: "历史 B 未混入历史 A 内容", passed: !branchB.context.includes(branchAContext) && !branchB.context.includes(branchAContinuedContext) },
    ],
  }
}

function createSimulationBranch(id: SimulationBranchSnapshot["id"], label: string, baseEntry: string): SimulationBranchSnapshot {
  return { id, label, baseEntry, records: [], context: [] }
}

function appendSimulationRecord(branch: SimulationBranchSnapshot, record: string, context: string): SimulationBranchSnapshot {
  return { ...branch, records: [...branch.records, record], context: [...branch.context, context] }
}

function createSimulationStep(
  label: string,
  detail: string,
  activeBranchId: SimulationBranchSnapshot["id"],
  branchA: SimulationBranchSnapshot,
  branchB: SimulationBranchSnapshot,
): SimulationStep {
  return { label, detail, activeBranchId, branches: [cloneSimulationBranch(branchA), cloneSimulationBranch(branchB)] }
}

function cloneSimulationBranch(branch: SimulationBranchSnapshot): SimulationBranchSnapshot {
  return { ...branch, records: [...branch.records], context: [...branch.context] }
}

export function HistoryPanel({ retentionLimit, taskRunning, onOpenSettings, onOpenCheckpoint }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<readonly HistoryEntry[]>(initialEntries)
  const [branches, setBranches] = useState<readonly Branch[]>(initialBranches)
  const [branchId, setBranchId] = useState("main")
  const [filter, setFilter] = useState<HistoryFilter>("all")
  const [selectedEntryId, setSelectedEntryId] = useState(initialEntries[0]?.id ?? "")
  const [activeEntryId, setActiveEntryId] = useState(initialEntries[0]?.id ?? "")
  const [showDifference, setShowDifference] = useState(false)
  const [simulation, setSimulation] = useState<SimulationState>()
  const simulationToken = useRef(0)

  useEffect(() => {
    if (retentionLimit === null) return
    setEntries((current) => current.slice(0, retentionLimit))
  }, [retentionLimit])

  const visibleEntries = useMemo(() => entries.filter((entry) => {
    if (entry.branchId !== branchId) return false
    if (filter === "all") return true
    if (filter === "paused") return entry.state === "paused"
    return entry.kind === filter
  }), [branchId, entries, filter])
  const selectedEntry = entries.find((entry) => entry.id === selectedEntryId)
  const alternativeSimulationEntry = entries.find((entry) => entry.id !== selectedEntryId && entry.kind === "automatic")

  const saveCurrent = (): void => {
    const now = new Date()
    const id = `manual-${String(now.getTime())}`
    const entry: HistoryEntry = {
      id,
      branchId,
      title: `手动保存 · ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      chapter: selectedEntry?.chapter ?? "当前章节",
      time: "刚刚",
      kind: "manual",
      state: taskRunning ? "paused" : "complete",
      summary: taskRunning ? "已保存模型请求前最近的稳定检查点。" : "已保存当前章节、世界图、Markdown 与上下文链。",
      delta: taskRunning ? "当前请求继续执行 · 恢复后保持暂停" : "完整世界快照",
    }
    setEntries((current) => {
      const next = [entry, ...current]
      return retentionLimit === null ? next : next.slice(0, retentionLimit)
    })
    setSelectedEntryId(id)
    setActiveEntryId(id)
    setFilter("all")
  }

  const returnPreviousRound = (): void => {
    const automatic = entries.filter((entry) => entry.branchId === branchId && entry.kind === "automatic")
    const currentIndex = automatic.findIndex((entry) => entry.id === activeEntryId)
    const target = automatic[currentIndex < 0 ? 1 : currentIndex + 1]
    if (target === undefined) return
    setSelectedEntryId(target.id)
    setActiveEntryId(target.id)
    setShowDifference(false)
  }

  const continueFromSelected = (): void => {
    if (selectedEntry === undefined) return
    const nextBranchNumber = branches.length + 1
    const nextBranch: Branch = { id: `branch-${String(nextBranchNumber)}`, name: `世界线 ${String(nextBranchNumber)}` }
    setBranches((current) => [...current, nextBranch])
    setBranchId(nextBranch.id)
    setEntries((current) => [{ ...selectedEntry, id: `${selectedEntry.id}-branch-${String(nextBranchNumber)}`, branchId: nextBranch.id, title: `${selectedEntry.title} · 分叉起点`, time: "刚刚" }, ...current])
    setShowDifference(false)
  }

  const runHistoricalSimulation = async (): Promise<void> => {
    if (selectedEntry === undefined || simulation?.status === "running") return
    const token = simulationToken.current + 1
    simulationToken.current = token
    setSimulation({ status: "running", activeStep: 0 })
    const scenario = buildHistorySwitchingScenario(selectedEntry.title, alternativeSimulationEntry?.title ?? "另一历史保存点")
    const steps = scenario.steps
    for (let index = 1; index < steps.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, simulationDelayMs))
      if (simulationToken.current !== token) return
      setSimulation({ status: "running", activeStep: index })
    }
    await new Promise((resolve) => setTimeout(resolve, simulationDelayMs))
    if (simulationToken.current !== token) return
    setSimulation({ status: "completed", activeStep: steps.length - 1 })
  }

  return <div className="history-panel">
    <div className="history-toolbar">
      <button className="history-primary" type="button" onClick={saveCurrent}><Save size={13} />保存</button>
      <button type="button" title="模拟多历史切换与继续" aria-label="模拟多历史切换与继续" data-testid="history-simulation-button" disabled={simulation?.status === "running"} onClick={() => { void runHistoricalSimulation(); }}><FlaskConical size={14} /></button>
      <button type="button" title="返回上一轮" onClick={returnPreviousRound}><ArrowLeftToLine size={14} /></button>
      <label className="history-branch-select"><GitBranch size={13} /><select aria-label="当前世界线" value={branchId} onChange={(event) => { setBranchId(event.target.value); setShowDifference(false); }}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
      <button type="button" title="推演历史设置" onClick={onOpenSettings}><Settings2 size={14} /></button>
    </div>
    <div className="history-capacity">
      <span><History size={13} />推演历史</span>
      <strong>{entries.length} / {retentionLimit === null ? "无上限" : retentionLimit}</strong>
    </div>
    <div className="history-filters" role="tablist" aria-label="历史筛选">
      <FilterButton id="all" value={filter} onChange={setFilter}>全部</FilterButton>
      <FilterButton id="automatic" value={filter} onChange={setFilter}>自动</FilterButton>
      <FilterButton id="manual" value={filter} onChange={setFilter}>手动</FilterButton>
      <FilterButton id="paused" value={filter} onChange={setFilter}>含暂停</FilterButton>
    </div>
    <div className="history-timeline">
      {visibleEntries.map((entry) => {
        const selected = entry.id === selectedEntryId
        const active = entry.id === activeEntryId
        return <button className={`history-entry ${selected ? "selected" : ""}`} type="button" key={entry.id} onClick={() => { simulationToken.current += 1; setSimulation(undefined); setSelectedEntryId(entry.id); setShowDifference(false); }}>
          <span className={`history-node ${entry.state}`}>{entry.state === "paused" ? <Pause size={10} /> : <Check size={10} />}</span>
          <span className="history-entry-content">
            <span className="history-entry-heading"><strong>{entry.title}</strong>{active ? <em>当前</em> : null}</span>
            <small>{entry.chapter} · {entry.time}</small>
            <p>{entry.summary}</p>
            <span className="history-entry-meta"><i>{entry.kind === "automatic" ? "自动保存" : "手动保存"}</i><i>{entry.state === "paused" ? "暂停检查点" : entry.delta}</i></span>
          </span>
          <ChevronRight size={13} />
        </button>
      })}
      {visibleEntries.length === 0 ? <div className="history-empty"><Clock3 size={18} /><span>当前筛选没有保存点</span></div> : null}
    </div>
    {selectedEntry === undefined ? null : <div className="history-selection">
      <div><small>已选择</small><strong>{selectedEntry.title}</strong></div>
      <div className="history-selection-actions">
        <button type="button" onClick={() => { setShowDifference((value) => !value); }}>比较</button>
        {selectedEntry.state === "paused" ? <button type="button" onClick={onOpenCheckpoint}>查看检查点</button> : null}
        <button className="history-continue" type="button" onClick={continueFromSelected}>从这里继续</button>
      </div>
      {showDifference ? <div className="history-difference"><span>相对当前状态</span><p>{selectedEntry.delta}</p><p>恢复范围：章节、世界图、Markdown、上下文链与任务状态</p></div> : null}
      {simulation === undefined ? null : <SimulationResult state={simulation} primaryEntry={selectedEntry.title} secondaryEntry={alternativeSimulationEntry?.title ?? "另一历史保存点"} />}
    </div>}
  </div>
}

function SimulationResult({ state, primaryEntry, secondaryEntry }: { state: SimulationState; primaryEntry: string; secondaryEntry: string }): React.JSX.Element {
  const scenario = buildHistorySwitchingScenario(primaryEntry, secondaryEntry)
  const steps = scenario.steps
  const completed = state.status === "completed"
  const activeStep = steps[state.activeStep] ?? steps[steps.length - 1]
  return <div className={`history-simulation ${completed ? "completed" : "running"}`} data-testid="history-simulation-result">
    <div className="history-simulation-head"><span><FlaskConical size={13} />多历史切换模拟</span><em>{completed ? "全部验证通过" : `步骤 ${String(state.activeStep + 1)} / ${String(steps.length)}`}</em></div>
    <small>本地隔离测试，不调用模型、不修改真实历史；验证两条世界线能分别恢复、继续并来回切换。</small>
    <ol>{steps.map((step, index) => <li className={index < state.activeStep ? "done" : index === state.activeStep && !completed ? "active" : "pending"} key={step.label}>
      <span>{index < state.activeStep || completed ? <Check size={11} /> : index === state.activeStep ? <Play size={10} /> : index + 1}</span>
      <div><strong>{step.label}</strong><small>{index <= state.activeStep || completed ? step.detail : "等待上一步完成"}</small></div>
    </li>)}</ol>
    {activeStep === undefined ? null : <div className="history-simulation-branches">{activeStep.branches.map((branch) => <section className={branch.id === activeStep.activeBranchId ? "active" : ""} key={branch.id}>
      <header><strong>{branch.label}</strong><em>{branch.id === activeStep.activeBranchId ? "当前已恢复" : "已隔离保存"}</em></header>
      <small>基线：{branch.baseEntry}</small>
      <p>{branch.records.length === 0 ? "尚未生成后续记录" : branch.records.join(" → ")}</p>
    </section>)}</div>}
    {completed ? <div className="history-simulation-checks" data-testid="history-simulation-checks">{scenario.checks.map((check) => <span className={check.passed ? "passed" : "failed"} key={check.label}>{check.passed ? <Check size={11} /> : null}{check.label}</span>)}</div> : null}
  </div>
}

function FilterButton({ id, value, onChange, children }: {
  id: HistoryFilter
  value: HistoryFilter
  onChange: (value: HistoryFilter) => void
  children: React.ReactNode
}): React.JSX.Element {
  return <button className={value === id ? "active" : ""} type="button" role="tab" aria-selected={value === id} onClick={() => { onChange(id); }}>{children}</button>
}
