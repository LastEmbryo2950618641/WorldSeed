import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeftToLine,
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
  History,
  LoaderCircle,
  Pause,
  Save,
  Settings2,
} from "lucide-react"
import type { HistoryBranchSummary, HistoryEntrySummary } from "@worldseed/contracts"

import { UiTooltip } from "../../components/UiTooltip.js"

type HistoryFilter = "all" | "automatic" | "manual" | "paused"

type Props = Readonly<{
  entries: readonly HistoryEntrySummary[]
  branches: readonly HistoryBranchSummary[]
  activeBranchId?: string
  selectedEntryId?: string
  retentionLimit: number | null
  taskRunning: boolean
  loading?: boolean
  onOpenSettings: () => void
  onOpenCheckpoint?: () => void
  onSave(): Promise<void>
  onRestore(entryId: string): Promise<void>
  onContinueFrom(entryId: string): Promise<void>
  onReturnPreviousRound(): Promise<void>
}>

export function HistoryPanel({
  entries,
  branches,
  activeBranchId,
  selectedEntryId,
  retentionLimit,
  taskRunning,
  loading = false,
  onOpenSettings,
  onOpenCheckpoint,
  onSave,
  onRestore,
  onContinueFrom,
  onReturnPreviousRound,
}: Props): React.JSX.Element {
  const [branchId, setBranchId] = useState(activeBranchId ?? "")
  const [filter, setFilter] = useState<HistoryFilter>("all")
  const [selectedId, setSelectedId] = useState(selectedEntryId ?? entries[0]?.entryId ?? "")
  const [showDifference, setShowDifference] = useState(false)
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => { if (activeBranchId !== undefined) setBranchId(activeBranchId) }, [activeBranchId])
  useEffect(() => { if (selectedEntryId !== undefined) setSelectedId(selectedEntryId) }, [selectedEntryId])
  useEffect(() => {
    if (selectedId.length === 0 && entries[0] !== undefined) setSelectedId(entries[0].entryId)
  }, [entries, selectedId])

  const visibleEntries = useMemo(() => entries.filter((entry) => {
    if (branchId.length > 0 && entry.branchId !== branchId) return false
    if (filter === "all") return true
    if (filter === "paused") return entry.state === "paused_checkpoint"
    return entry.kind === filter
  }), [branchId, entries, filter])
  const selectedEntry = entries.find((entry) => entry.entryId === selectedId)

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (pendingAction !== undefined) return
    setPendingAction(key)
    setError(undefined)
    try {
      await action()
      setShowDifference(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingAction(undefined)
    }
  }

  return <div className="history-panel">
    <div className="history-toolbar">
      <button className="history-primary" type="button" disabled={loading || pendingAction !== undefined} onClick={() => { void run("save", onSave); }}>
        {pendingAction === "save" ? <LoaderCircle size={13} /> : <Save size={13} />}保存
      </button>
      <UiTooltip label="返回上一轮">
        <button type="button" aria-label="返回上一轮" disabled={taskRunning || loading || pendingAction !== undefined} onClick={() => { void run("previous", onReturnPreviousRound); }}><ArrowLeftToLine size={14} /></button>
      </UiTooltip>
      <label className="history-branch-select"><GitBranch size={13} /><select aria-label="当前世界线" value={branchId} disabled={branches.length === 0} onChange={(event) => { setBranchId(event.target.value); setShowDifference(false); }}>
        {branches.map((branch) => <option key={branch.branchId} value={branch.branchId}>{branch.name}</option>)}
      </select></label>
      <UiTooltip label="推演历史设置">
        <button type="button" aria-label="推演历史设置" onClick={onOpenSettings}><Settings2 size={14} /></button>
      </UiTooltip>
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
      {loading ? <div className="history-empty"><LoaderCircle size={18} /><span>正在读取推演历史</span></div> : null}
      {!loading && visibleEntries.map((entry) => {
        const selected = entry.entryId === selectedId
        const active = entry.entryId === selectedEntryId
        const paused = entry.state === "paused_checkpoint"
        return <button className={`history-entry ${selected ? "selected" : ""}`} type="button" key={entry.entryId} onClick={() => { setSelectedId(entry.entryId); setShowDifference(false); }}>
          <span className={`history-node ${paused ? "paused" : "complete"}`}>{paused ? <Pause size={10} /> : <Check size={10} />}</span>
          <span className="history-entry-content">
            <span className="history-entry-heading"><strong>{entry.name}</strong>{active ? <em>当前</em> : null}</span>
            <small>提交序列 {entry.committedSequence} · {formatTime(entry.completedAtMs ?? entry.createdAtMs)}</small>
            <p>{entry.note ?? (entry.kind === "automatic" ? "完整轮推演完成后自动保存。" : "用户手动保存的世界状态。")}</p>
            <span className="history-entry-meta"><i>{entry.kind === "automatic" ? "自动保存" : "手动保存"}</i><i>{paused ? "恢复后保持暂停" : entry.status === "ready" ? "可恢复" : entry.status}</i></span>
          </span>
          <ChevronRight size={13} />
        </button>
      })}
      {!loading && visibleEntries.length === 0 ? <div className="history-empty"><Clock3 size={18} /><span>当前筛选没有保存点</span></div> : null}
    </div>
    {error === undefined ? null : <p className="task-error">{error}</p>}
    {selectedEntry === undefined ? null : <div className="history-selection">
      <div><small>已选择</small><strong>{selectedEntry.name}</strong></div>
      <div className="history-selection-actions">
        <button type="button" onClick={() => { setShowDifference((value) => !value); }}>比较</button>
        {selectedEntry.state === "paused_checkpoint" ? <button type="button" onClick={onOpenCheckpoint}>查看检查点</button> : null}
        <button type="button" disabled={taskRunning || pendingAction !== undefined} onClick={() => { void run("restore", () => onRestore(selectedEntry.entryId)); }}>加载</button>
        <button className="history-continue" type="button" disabled={taskRunning || pendingAction !== undefined} onClick={() => { void run("continue", () => onContinueFrom(selectedEntry.entryId)); }}>从这里继续</button>
      </div>
      {showDifference ? <div className="history-difference"><span>相对当前状态</span><p>目标提交序列：{selectedEntry.committedSequence}</p><p>恢复范围：章节、世界图、Markdown、唯一模型上下文链与任务检查点</p></div> : null}
    </div>}
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

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}
