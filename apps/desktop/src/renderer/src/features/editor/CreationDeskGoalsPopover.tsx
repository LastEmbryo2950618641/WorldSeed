import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock3,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat2,
  Target,
  X,
  XCircle,
} from "lucide-react"
import type {
  DeductionGoal,
  DeductionGoalProgress,
  DeductionGoalProposal,
  DeductionGoalsSnapshot,
} from "@worldseed/contracts"

import { UiTooltip } from "../../components/UiTooltip.js"
import {
  findChapterProgress,
  listActiveGoals,
  listGoalProgressHistory,
  listPendingProposals,
  listReviewableProgress,
  progressStatusLabel,
  resolveGoalRowStatus,
  type GoalRowScope,
} from "./creation-desk-goals.js"

type Props = Readonly<{
  snapshot: DeductionGoalsSnapshot | undefined
  chapterSequence: number
  focusUnfilled?: boolean
  onClose(): void
  onAdd(content: string): Promise<void>
  onUpdateContent(goalId: string, content: string): Promise<void>
  onComplete(goalId: string): Promise<void>
  onRemove(goalId: string): Promise<void>
  onSetProgress(goalId: string, chapterSequence: number, summary: string): Promise<void>
  onReviewProgress(
    goalId: string,
    chapterSequence: number,
    status: "achieved" | "partial" | "missed",
    summary: string,
  ): Promise<void>
  onApprove(proposalIds: readonly string[]): Promise<void>
  onReject(proposalIds: readonly string[]): Promise<void>
}>

export function CreationDeskGoalsPopover(props: Props): React.JSX.Element {
  const [scope, setScope] = useState<GoalRowScope>("overview")
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState("")
  const [historyGoalId, setHistoryGoalId] = useState<string>()
  const [confirmRemoveGoalId, setConfirmRemoveGoalId] = useState<string>()

  const goals = props.snapshot?.goals ?? []
  const progress = props.snapshot?.progress ?? []
  const pending = useMemo(
    () => listPendingProposals(props.snapshot?.pendingProposals ?? []),
    [props.snapshot?.pendingProposals],
  )
  const reviewable = useMemo(
    () => listReviewableProgress(goals, progress, props.chapterSequence),
    [goals, progress, props.chapterSequence],
  )
  const reviewableGoalIds = useMemo(
    () => new Set(reviewable.map((item) => item.goal.goalId)),
    [reviewable],
  )
  const activeGoals = useMemo(() => {
    const items = [...listActiveGoals(goals)]
    if (props.focusUnfilled !== true || scope !== "chapter") return items
    return items.sort((left, right) => {
      const leftFilled = (findChapterProgress(progress, left.goalId, props.chapterSequence)?.summary.trim().length ?? 0) > 0
      const rightFilled = (findChapterProgress(progress, right.goalId, props.chapterSequence)?.summary.trim().length ?? 0) > 0
      return Number(leftFilled) - Number(rightFilled)
    })
  }, [goals, progress, props.chapterSequence, props.focusUnfilled, scope])

  const submitAdd = (): void => {
    const content = addDraft.trim()
    if (content.length === 0) return
    setAddDraft("")
    setAdding(false)
    void props.onAdd(content)
  }

  return <div className="creation-desk-goals-popover creation-desk-goals-popover-compact" data-testid="creation-desk-goals-popover" role="dialog" aria-label="推演目标">
    <header className="creation-desk-goals-popover-header creation-desk-goals-compact-header">
      <div className="creation-desk-goals-popover-title">
        <Target size={11} aria-hidden="true" />
        <span>推演目标</span>
        <span className="creation-desk-goals-chapter-label">第 {props.chapterSequence} 章</span>
      </div>
      <div className="creation-desk-goals-compact-toolbar">
        <UiTooltip label={scope === "overview" ? "切换为本章目标" : "切换为全部目标"}>
          <button
            type="button"
            className={`creation-desk-goals-icon-button${scope === "chapter" ? " active" : ""}`}
            data-testid="creation-desk-goals-scope-toggle"
            aria-label={scope === "overview" ? "切换为本章目标" : "切换为全部目标"}
            onClick={() => { setScope((current) => current === "overview" ? "chapter" : "overview"); }}
          >
            <Repeat2 size={11} aria-hidden="true" />
          </button>
        </UiTooltip>
        <UiTooltip label="添加目标">
          <button
            type="button"
            className="creation-desk-goals-icon-button"
            data-testid="creation-desk-goals-add-trigger"
            aria-label="添加目标"
            onClick={() => { setAdding((open) => !open); }}
          >
            <Plus size={11} aria-hidden="true" />
          </button>
        </UiTooltip>
        <button type="button" className="creation-desk-goals-close" aria-label="关闭" onClick={props.onClose}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </header>

    {adding
      ? <div className="creation-desk-goals-add-row" data-testid="creation-desk-goals-compose">
          <input
            value={addDraft}
            autoFocus
            placeholder="输入新目标…"
            onChange={(event) => { setAddDraft(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submitAdd()
              }
              if (event.key === "Escape") {
                setAdding(false)
                setAddDraft("")
              }
            }}
          />
          <button type="button" disabled={addDraft.trim().length === 0} onClick={submitAdd}>添加</button>
        </div>
      : null}

    <div className="creation-desk-goals-list creation-desk-goals-compact-list" data-testid="creation-desk-goals-active-list">
      {pending.length > 0
        ? <section className="creation-desk-goals-compact-section" data-testid="creation-desk-goals-pending-section">
            {pending.map((proposal) => <CompactProposalRow
              key={proposal.proposalId}
              proposal={proposal}
              onApprove={() => { void props.onApprove([proposal.proposalId]); }}
              onReject={() => { void props.onReject([proposal.proposalId]); }}
            />)}
          </section>
        : null}
      {activeGoals.length === 0
        ? <p className="creation-desk-goals-empty">暂无进行中的目标</p>
        : activeGoals.map((goal) => {
          const chapterProgress = findChapterProgress(progress, goal.goalId, props.chapterSequence)
          const reviewableItem = reviewable.find((item) => item.goal.goalId === goal.goalId)
          return <CompactGoalRow
            key={goal.goalId}
            goal={goal}
            scope={scope}
            chapterSequence={props.chapterSequence}
            chapterProgress={chapterProgress}
            reviewable={reviewableGoalIds.has(goal.goalId)}
            reviewSummary={reviewableItem?.progress.summary}
            historyOpen={historyGoalId === goal.goalId}
            confirmRemove={confirmRemoveGoalId === goal.goalId}
            history={listGoalProgressHistory(progress, goal.goalId)}
            onToggleHistory={() => {
              setHistoryGoalId((current) => current === goal.goalId ? undefined : goal.goalId)
            }}
            onRequestRemove={() => { setConfirmRemoveGoalId(goal.goalId); }}
            onCancelRemove={() => { setConfirmRemoveGoalId(undefined); }}
            onConfirmRemove={() => {
              setConfirmRemoveGoalId(undefined)
              void props.onRemove(goal.goalId)
            }}
            onUpdateContent={(content) => { void props.onUpdateContent(goal.goalId, content); }}
            onSetProgress={(summary) => { void props.onSetProgress(goal.goalId, props.chapterSequence, summary); }}
            onReview={(status, summary) => {
              void props.onReviewProgress(goal.goalId, props.chapterSequence, status, summary)
            }}
          />
        })}
    </div>
  </div>
}

function CompactProposalRow(props: Readonly<{
  proposal: DeductionGoalProposal
  onApprove(): void
  onReject(): void
}>): React.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false)
  const body = props.proposal.payload.kind === "create" || props.proposal.payload.kind === "update_content"
    ? props.proposal.payload.content
    : props.proposal.payload.kind === "set_chapter_progress"
      ? props.proposal.payload.summary
      : (props.proposal.goalId ?? "Agent 建议")
  return <div className="creation-desk-goal-row pending" data-testid="creation-desk-goal-pending">
    <AlertCircle size={11} className="creation-desk-goal-status-icon pending" aria-hidden="true" />
    <span className="creation-desk-goal-row-text is-label" title={body}>{body}</span>
    <CollapsibleRowActions open={actionsOpen} onToggle={() => { setActionsOpen((open) => !open); }}>
      <button type="button" className="creation-desk-goals-icon-button" aria-label="采纳" onClick={props.onApprove}>
        <Check size={12} aria-hidden="true" />
      </button>
      <button type="button" className="creation-desk-goals-icon-button muted" aria-label="忽略" onClick={props.onReject}>
        <X size={12} aria-hidden="true" />
      </button>
    </CollapsibleRowActions>
  </div>
}

function CompactGoalRow(props: Readonly<{
  goal: DeductionGoal
  scope: GoalRowScope
  chapterSequence: number
  chapterProgress: DeductionGoalProgress | undefined
  reviewable: boolean
  reviewSummary: string | undefined
  historyOpen: boolean
  confirmRemove: boolean
  history: readonly DeductionGoalProgress[]
  onToggleHistory(): void
  onRequestRemove(): void
  onCancelRemove(): void
  onConfirmRemove(): void
  onUpdateContent(content: string): Promise<void>
  onSetProgress(summary: string): Promise<void>
  onReview(status: "achieved" | "partial" | "missed", summary: string): void
}>): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [draft, setDraft] = useState(props.goal.content)
  const rowRef = useRef<HTMLDivElement>(null)
  const status = resolveGoalRowStatus({
    goal: props.goal,
    chapterProgress: props.chapterProgress,
    scope: props.scope,
    reviewable: props.reviewable,
  })
  const displayText = props.scope === "chapter"
    ? (props.chapterProgress?.summary.trim() || props.goal.content)
    : props.goal.content
  const editChapter = props.scope === "chapter"
    && props.chapterProgress?.lockedAtMs === undefined
    && !props.reviewable

  const saveEdit = (): void => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    if (editChapter) {
      void props.onSetProgress(trimmed)
      return
    }
    if (trimmed !== props.goal.content) void props.onUpdateContent(trimmed)
  }

  useEffect(() => {
    if (props.confirmRemove) setActionsOpen(true)
  }, [props.confirmRemove])

  useEffect(() => {
    if (!actionsOpen) return
    const close = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && rowRef.current?.contains(target)) return
      setActionsOpen(false)
    }
    window.addEventListener("mousedown", close)
    return () => { window.removeEventListener("mousedown", close) }
  }, [actionsOpen])

  return <div className="creation-desk-goal-row-wrap" data-testid="creation-desk-goal-active">
    <div className="creation-desk-goal-row" ref={rowRef}>
      <GoalStatusIcon status={status.kind} reviewable={props.reviewable} />
      {editing
        ? <input
            className="creation-desk-goal-row-input"
            value={draft}
            autoFocus
            onChange={(event) => { setDraft(event.target.value); }}
            onBlur={saveEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                saveEdit()
              }
              if (event.key === "Escape") {
                setEditing(false)
                setDraft(editChapter ? (props.chapterProgress?.summary ?? props.goal.content) : props.goal.content)
              }
            }}
          />
        : <button
            type="button"
            className="creation-desk-goal-row-text"
            title={displayText}
            onClick={() => {
              setDraft(editChapter ? (props.chapterProgress?.summary ?? "") : props.goal.content)
              setEditing(true)
            }}
          >
            {displayText}
          </button>}
      {editing
        ? null
        : <CollapsibleRowActions open={actionsOpen} onToggle={() => { setActionsOpen((open) => !open); }}>
            {props.reviewable
              ? <>
                  <UiTooltip label="已达成">
                    <button
                      type="button"
                      className="creation-desk-goals-icon-button"
                      data-testid="creation-desk-review-achieved"
                      aria-label="已达成"
                      onClick={() => {
                        setActionsOpen(false)
                        props.onReview("achieved", props.reviewSummary ?? props.chapterProgress?.summary ?? "")
                      }}
                    >
                      <CheckCircle2 size={12} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                  <UiTooltip label="部分达成">
                    <button
                      type="button"
                      className="creation-desk-goals-icon-button"
                      data-testid="creation-desk-review-partial"
                      aria-label="部分达成"
                      onClick={() => {
                        setActionsOpen(false)
                        props.onReview("partial", props.reviewSummary ?? props.chapterProgress?.summary ?? "")
                      }}
                    >
                      <CircleDashed size={12} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                  <UiTooltip label="未达成">
                    <button
                      type="button"
                      className="creation-desk-goals-icon-button danger"
                      data-testid="creation-desk-review-missed"
                      aria-label="未达成"
                      onClick={() => {
                        setActionsOpen(false)
                        props.onReview("missed", props.reviewSummary ?? props.chapterProgress?.summary ?? "")
                      }}
                    >
                      <XCircle size={12} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                </>
              : <>
                  <UiTooltip label={editChapter ? "编辑本章预期" : "编辑目标"}>
                    <button
                      type="button"
                      className="creation-desk-goals-icon-button"
                      aria-label={editChapter ? "编辑本章预期" : "编辑目标"}
                      onClick={() => {
                        setActionsOpen(false)
                        setDraft(editChapter ? (props.chapterProgress?.summary ?? "") : props.goal.content)
                        setEditing(true)
                      }}
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                  {props.confirmRemove
                    ? <>
                        <button type="button" className="creation-desk-goals-inline-confirm danger" onClick={props.onConfirmRemove}>删</button>
                        <button type="button" className="creation-desk-goals-inline-confirm muted" onClick={props.onCancelRemove}>否</button>
                      </>
                    : <UiTooltip label="删除目标">
                        <button
                          type="button"
                          className="creation-desk-goals-icon-button muted"
                          aria-label="删除目标"
                          onClick={props.onRequestRemove}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </UiTooltip>}
                  <UiTooltip label="历史完成情况">
                    <button
                      type="button"
                      className={`creation-desk-goals-icon-button${props.historyOpen ? " active" : ""}`}
                      data-testid="creation-desk-goal-history-trigger"
                      aria-label="历史完成情况"
                      aria-expanded={props.historyOpen}
                      onClick={props.onToggleHistory}
                    >
                      <History size={12} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                </>}
          </CollapsibleRowActions>}
    </div>
    {props.historyOpen
      ? <div className="creation-desk-goal-history" data-testid="creation-desk-goal-history">
          {props.history.length === 0
            ? <p className="creation-desk-goals-empty">暂无历史记录</p>
            : props.history.map((item) => <div key={item.progressId} className="creation-desk-goal-history-row">
                <span className="creation-desk-goal-history-chapter">第 {item.chapterSequence} 章</span>
                <span className={`creation-desk-goal-history-status status-${item.status}`}>
                  {progressStatusLabel(item.status)}
                </span>
                <span className="creation-desk-goal-history-summary" title={item.summary}>{item.summary}</span>
              </div>)}
        </div>
      : null}
  </div>
}

function GoalStatusIcon(props: Readonly<{ status: ReturnType<typeof resolveGoalRowStatus>["kind"]; reviewable: boolean }>): React.JSX.Element {
  const className = `creation-desk-goal-status-icon status-${props.status}`
  if (props.status === "achieved" || props.status === "completed") {
    return <CheckCircle2 size={11} className={className} aria-hidden="true" />
  }
  if (props.status === "partial") {
    return <CircleDashed size={11} className={className} aria-hidden="true" />
  }
  if (props.status === "missed") {
    return <XCircle size={11} className={className} aria-hidden="true" />
  }
  if (props.status === "locked" || props.status === "review") {
    return <Lock size={11} className={className} aria-hidden="true" />
  }
  if (props.status === "planned") {
    return <Clock3 size={11} className={className} aria-hidden="true" />
  }
  return <Circle size={11} className={className} aria-hidden="true" />
}

function CollapsibleRowActions(props: Readonly<{
  open: boolean
  onToggle(): void
  children: React.ReactNode
}>): React.JSX.Element {
  return <div className="creation-desk-goal-row-actions-shell">
    <UiTooltip label={props.open ? "收起操作" : "展开操作"}>
      <button
        type="button"
        className={`creation-desk-goals-icon-button creation-desk-goal-row-actions-toggle${props.open ? " active" : ""}`}
        data-testid="creation-desk-goal-row-actions-toggle"
        aria-label={props.open ? "收起操作" : "展开操作"}
        aria-expanded={props.open}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggle()
        }}
      >
        <MoreHorizontal size={12} aria-hidden="true" />
      </button>
    </UiTooltip>
    <div className={`creation-desk-goal-row-actions${props.open ? " is-open" : ""}`}>
      {props.children}
    </div>
  </div>
}
