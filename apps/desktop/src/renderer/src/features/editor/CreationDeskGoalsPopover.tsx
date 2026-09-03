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
import {
  chapterSituationEmptyHint,
  chapterSituationSectionTitle,
  editChapterSituationLabel,
} from "@worldseed/contracts"

import { UiTooltip } from "../../components/UiTooltip.js"
import {
  findChapterProgress,
  formatGoalTaxonomyChip,
  listActiveGoals,
  listChapterRelevantGoals,
  listGoalProgressHistory,
  listPendingProposals,
  listReviewableProgress,
  narrativeKindLabel,
  progressStatusLabel,
  resolveGoalRowStatus,
  scaleLabel,
  type GoalRowScope,
  type GoalTaxonomyInput,
} from "./creation-desk-goals.js"

type Props = Readonly<{
  snapshot: DeductionGoalsSnapshot | undefined
  chapterSequence: number
  focusUnfilled?: boolean
  onClose(): void
  onAdd(content: string, taxonomy?: GoalTaxonomyInput): Promise<void>
  onUpdateGoal(goalId: string, patch: { content?: string } & GoalTaxonomyInput): Promise<void>
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

type TaxonomyDraft = Readonly<{
  narrativeKind: DeductionGoal["narrativeKind"]
  scale: DeductionGoal["scale"]
  plantChapterSequence: string
  payoffChapterSequence: string
}>

const defaultTaxonomyDraft = (): TaxonomyDraft => ({
  narrativeKind: "general",
  scale: "short",
  plantChapterSequence: "",
  payoffChapterSequence: "",
})

function parseChapterInput(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 1) return undefined
  return value
}

function taxonomyFromDraft(draft: TaxonomyDraft): GoalTaxonomyInput {
  const plant = parseChapterInput(draft.plantChapterSequence)
  const payoff = parseChapterInput(draft.payoffChapterSequence)
  return {
    narrativeKind: draft.narrativeKind,
    scale: draft.scale,
    ...(plant === undefined ? {} : { plantChapterSequence: plant }),
    ...(payoff === undefined ? {} : { payoffChapterSequence: payoff }),
  }
}

function draftFromGoal(goal: DeductionGoal): TaxonomyDraft {
  return {
    narrativeKind: goal.narrativeKind,
    scale: goal.scale,
    plantChapterSequence: goal.plantChapterSequence === undefined
      ? ""
      : String(goal.plantChapterSequence),
    payoffChapterSequence: goal.payoffChapterSequence === undefined
      ? ""
      : String(goal.payoffChapterSequence),
  }
}

export function CreationDeskGoalsPopover(props: Props): React.JSX.Element {
  const [scope, setScope] = useState<GoalRowScope>("chapter")
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState("")
  const [addTaxonomy, setAddTaxonomy] = useState<TaxonomyDraft>(defaultTaxonomyDraft)
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
    const items = scope === "chapter"
      ? [...listChapterRelevantGoals(goals, props.chapterSequence)]
      : [...listActiveGoals(goals)]
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
    const taxonomy = taxonomyFromDraft(addTaxonomy)
    setAddDraft("")
    setAddTaxonomy(defaultTaxonomyDraft())
    setAdding(false)
    void props.onAdd(content, taxonomy)
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
        <button type="button" className="creation-desk-goals-close" aria-label="关闭" onClick={props.onClose}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </header>

    {pending.length > 0
      ? <div className="creation-desk-goals-pending-header" data-testid="creation-desk-goals-pending-hint">
          <p className="creation-desk-goals-hint">
            Agent 建议 · 点✓采纳后写入目标库
          </p>
          <button
            type="button"
            className="creation-desk-goals-approve-all"
            data-testid="creation-desk-goals-approve-all"
            onClick={() => {
              void props.onApprove(pending.map((proposal) => proposal.proposalId))
            }}
          >
            <Check size={11} aria-hidden="true" />
            全部采纳
          </button>
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
        ? <p className="creation-desk-goals-empty" data-testid="creation-desk-goals-empty">
            {pending.length > 0
              ? "尚无已采纳目标"
              : "暂无目标。讨论戏核时由 Agent 提出伏笔/高潮，采纳后出现在此。"}
          </p>
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
            onUpdateGoal={(patch) => props.onUpdateGoal(goal.goalId, patch)}
            onSetProgress={(summary) => props.onSetProgress(goal.goalId, props.chapterSequence, summary)}
            onReview={(status, summary) => {
              void props.onReviewProgress(goal.goalId, props.chapterSequence, status, summary)
            }}
          />
        })}
    </div>

    {adding
      ? <div className="creation-desk-goals-add-panel" data-testid="creation-desk-goals-compose">
          <div className="creation-desk-goals-add-row">
            <input
              value={addDraft}
              autoFocus
              placeholder="手动补一条目标…"
              onChange={(event) => { setAddDraft(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  submitAdd()
                }
                if (event.key === "Escape") {
                  setAdding(false)
                  setAddDraft("")
                  setAddTaxonomy(defaultTaxonomyDraft())
                }
              }}
            />
            <button type="button" disabled={addDraft.trim().length === 0} onClick={submitAdd}>添加</button>
          </div>
          <GoalTaxonomyFields
            draft={addTaxonomy}
            onChange={setAddTaxonomy}
          />
        </div>
      : <div className="creation-desk-goals-secondary-actions">
          <button
            type="button"
            className="creation-desk-goals-manual-add"
            data-testid="creation-desk-goals-add-trigger"
            onClick={() => { setAdding(true); }}
          >
            <Plus size={10} aria-hidden="true" />
            手动添加（次要）
          </button>
        </div>}
  </div>
}

function GoalTaxonomyFields(props: Readonly<{
  draft: TaxonomyDraft
  onChange(next: TaxonomyDraft): void
}>): React.JSX.Element {
  const showWindow = props.draft.narrativeKind === "foreshadow" || props.draft.narrativeKind === "climax"
  return <div className="creation-desk-goals-taxonomy-row" data-testid="creation-desk-goals-taxonomy">
    <select
      aria-label="目标类型"
      value={props.draft.narrativeKind}
      onChange={(event) => {
        props.onChange({
          ...props.draft,
          narrativeKind: event.target.value as DeductionGoal["narrativeKind"],
        })
      }}
    >
      <option value="general">目标</option>
      <option value="foreshadow">伏笔</option>
      <option value="climax">高潮</option>
    </select>
    <select
      aria-label="尺度"
      value={props.draft.scale}
      onChange={(event) => {
        props.onChange({
          ...props.draft,
          scale: event.target.value as DeductionGoal["scale"],
        })
      }}
    >
      <option value="short">短</option>
      <option value="medium">中</option>
      <option value="long">长</option>
    </select>
    {showWindow
      ? <>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            aria-label="起势章"
            placeholder="起势章"
            value={props.draft.plantChapterSequence}
            onChange={(event) => {
              props.onChange({ ...props.draft, plantChapterSequence: event.target.value })
            }}
          />
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            aria-label="兑现章"
            placeholder="兑现章"
            value={props.draft.payoffChapterSequence}
            onChange={(event) => {
              props.onChange({ ...props.draft, payoffChapterSequence: event.target.value })
            }}
          />
        </>
      : null}
  </div>
}

function CompactProposalRow(props: Readonly<{
  proposal: DeductionGoalProposal
  onApprove(): void
  onReject(): void
}>): React.JSX.Element {
  const body = props.proposal.payload.kind === "create" || props.proposal.payload.kind === "update_content"
    ? props.proposal.payload.content
    : props.proposal.payload.kind === "set_chapter_progress"
      ? props.proposal.payload.summary
      : (props.proposal.goalId ?? "Agent 建议")
  const chip = props.proposal.payload.kind === "create" || props.proposal.payload.kind === "update_content"
    ? formatGoalTaxonomyChip(props.proposal.payload.narrativeKind, props.proposal.payload.scale)
    : undefined
  return <div className="creation-desk-goal-row pending" data-testid="creation-desk-goal-pending">
    <AlertCircle size={11} className="creation-desk-goal-status-icon pending" aria-hidden="true" />
    <span className="creation-desk-goal-row-text is-label" title={body}>
      {chip === undefined ? null : <span className="creation-desk-goal-taxonomy" aria-hidden="true">{chip}</span>}
      {body}
    </span>
    <button type="button" className="creation-desk-goals-icon-button" aria-label="采纳" title="采纳" onClick={props.onApprove}>
      <Check size={12} aria-hidden="true" />
    </button>
    <button type="button" className="creation-desk-goals-icon-button muted" aria-label="忽略" title="忽略" onClick={props.onReject}>
      <X size={12} aria-hidden="true" />
    </button>
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
  onUpdateGoal(patch: { content?: string } & GoalTaxonomyInput): Promise<void>
  onSetProgress(summary: string): Promise<void>
  onReview(status: "achieved" | "partial" | "missed", summary: string): void
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [draft, setDraft] = useState(props.goal.content)
  const [taxonomyDraft, setTaxonomyDraft] = useState<TaxonomyDraft>(() => draftFromGoal(props.goal))
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

  const beginEdit = (): void => {
    setDraft(editChapter ? (props.chapterProgress?.summary ?? "") : props.goal.content)
    setTaxonomyDraft(draftFromGoal(props.goal))
    setExpanded(true)
    setEditing(true)
  }

  const saveEdit = (): void => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    if (editChapter) {
      void props.onSetProgress(trimmed)
      return
    }
    const taxonomy = taxonomyFromDraft(taxonomyDraft)
    const contentChanged = trimmed !== props.goal.content
    const taxonomyChanged = taxonomy.narrativeKind !== props.goal.narrativeKind
      || taxonomy.scale !== props.goal.scale
      || taxonomy.plantChapterSequence !== props.goal.plantChapterSequence
      || taxonomy.payoffChapterSequence !== props.goal.payoffChapterSequence
    if (!contentChanged && !taxonomyChanged) return
    void props.onUpdateGoal({
      ...(contentChanged ? { content: trimmed } : {}),
      ...(taxonomyChanged ? taxonomy : {}),
    })
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setDraft(editChapter ? (props.chapterProgress?.summary ?? props.goal.content) : props.goal.content)
    setTaxonomyDraft(draftFromGoal(props.goal))
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

  return <div className={`creation-desk-goal-row-wrap${expanded ? " is-expanded" : ""}`} data-testid="creation-desk-goal-active">
    <div className="creation-desk-goal-row" ref={rowRef}>
      <GoalStatusIcon status={status.kind} reviewable={props.reviewable} />
      <button
        type="button"
        className="creation-desk-goal-row-text"
        title={`${status.label} · ${displayText}`}
        aria-expanded={expanded}
        onClick={() => {
          if (editing) return
          setExpanded((value) => !value)
        }}
      >
        <span className={`creation-desk-goal-status-chip status-${status.kind}`} aria-label={status.label}>
          {status.label}
        </span>
        <span className="creation-desk-goal-taxonomy" aria-hidden="true">
          {narrativeKindLabel(props.goal.narrativeKind)}
          {props.goal.narrativeKind === "general" ? null : `·${scaleLabel(props.goal.scale)}`}
        </span>
        {displayText}
      </button>
      <CollapsibleRowActions open={actionsOpen} onToggle={() => { setActionsOpen((open) => !open); }}>
        {props.reviewable
          ? <>
              <UiTooltip label={progressStatusLabel("achieved", props.goal.narrativeKind)}>
                <button
                  type="button"
                  className="creation-desk-goals-icon-button"
                  data-testid="creation-desk-review-achieved"
                  aria-label={progressStatusLabel("achieved", props.goal.narrativeKind)}
                  onClick={() => {
                    setActionsOpen(false)
                    props.onReview("achieved", props.reviewSummary ?? props.chapterProgress?.summary ?? "")
                  }}
                >
                  <CheckCircle2 size={12} aria-hidden="true" />
                </button>
              </UiTooltip>
              <UiTooltip label={progressStatusLabel("partial", props.goal.narrativeKind)}>
                <button
                  type="button"
                  className="creation-desk-goals-icon-button"
                  data-testid="creation-desk-review-partial"
                  aria-label={progressStatusLabel("partial", props.goal.narrativeKind)}
                  onClick={() => {
                    setActionsOpen(false)
                    props.onReview("partial", props.reviewSummary ?? props.chapterProgress?.summary ?? "")
                  }}
                >
                  <CircleDashed size={12} aria-hidden="true" />
                </button>
              </UiTooltip>
              <UiTooltip label={progressStatusLabel("missed", props.goal.narrativeKind)}>
                <button
                  type="button"
                  className="creation-desk-goals-icon-button danger"
                  data-testid="creation-desk-review-missed"
                  aria-label={progressStatusLabel("missed", props.goal.narrativeKind)}
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
              <UiTooltip label={editChapter ? editChapterSituationLabel(props.goal.narrativeKind) : "编辑目标"}>
                <button
                  type="button"
                  className="creation-desk-goals-icon-button"
                  aria-label={editChapter ? editChapterSituationLabel(props.goal.narrativeKind) : "编辑目标"}
                  onClick={() => {
                    setActionsOpen(false)
                    beginEdit()
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
              <UiTooltip label={
                props.goal.narrativeKind === "foreshadow"
                  ? "历史收束情况"
                  : props.goal.narrativeKind === "climax"
                    ? "历史推进情况"
                    : "历史完成情况"
              }>
                <button
                  type="button"
                  className={`creation-desk-goals-icon-button${props.historyOpen ? " active" : ""}`}
                  data-testid="creation-desk-goal-history-trigger"
                  aria-label={
                    props.goal.narrativeKind === "foreshadow"
                      ? "历史收束情况"
                      : props.goal.narrativeKind === "climax"
                        ? "历史推进情况"
                        : "历史完成情况"
                  }
                  aria-expanded={props.historyOpen}
                  onClick={props.onToggleHistory}
                >
                  <History size={12} aria-hidden="true" />
                </button>
              </UiTooltip>
            </>}
      </CollapsibleRowActions>
    </div>
    {expanded
      ? <div className="creation-desk-goal-expand" data-testid="creation-desk-goal-expand">
          {editing
            ? <>
                <textarea
                  className="creation-desk-goal-expand-editor"
                  value={draft}
                  autoFocus
                  rows={3}
                  onChange={(event) => { setDraft(event.target.value); }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      cancelEdit()
                    }
                  }}
                />
                {editChapter
                  ? null
                  : <GoalTaxonomyFields draft={taxonomyDraft} onChange={setTaxonomyDraft} />}
                <div className="creation-desk-goal-expand-actions">
                  <button type="button" className="creation-desk-goals-taxonomy-save" onClick={saveEdit}>
                    保存
                  </button>
                  <button type="button" className="creation-desk-goals-inline-confirm muted" onClick={cancelEdit}>
                    取消
                  </button>
                </div>
              </>
            : <>
                <p className="creation-desk-goal-expand-body">{props.goal.content}</p>
                <dl className="creation-desk-goal-expand-meta">
                  <div>
                    <dt>类型</dt>
                    <dd>{narrativeKindLabel(props.goal.narrativeKind)}</dd>
                  </div>
                  <div>
                    <dt>尺度</dt>
                    <dd>{scaleLabel(props.goal.scale)}</dd>
                  </div>
                  {props.goal.plantChapterSequence === undefined
                    ? null
                    : <div>
                        <dt>起势章</dt>
                        <dd>第 {props.goal.plantChapterSequence} 章</dd>
                      </div>}
                  {props.goal.payoffChapterSequence === undefined
                    ? null
                    : <div>
                        <dt>兑现章</dt>
                        <dd>第 {props.goal.payoffChapterSequence} 章</dd>
                      </div>}
                </dl>
                <div className="creation-desk-goal-progress" data-testid="creation-desk-goal-progress">
                  <div className="creation-desk-goal-progress-label">
                    <span>{chapterSituationSectionTitle(props.goal.narrativeKind, props.chapterSequence)}</span>
                    <span className={`creation-desk-goal-status-chip status-${status.kind}`}>
                      {status.label}
                    </span>
                    {props.chapterProgress?.lockedAtMs === undefined
                      ? null
                      : <span className="creation-desk-goal-locked">已锁定</span>}
                  </div>
                  {props.chapterProgress !== undefined && props.chapterProgress.summary.trim().length > 0
                    ? <p className="creation-desk-goal-progress-summary">
                        {progressStatusLabel(props.chapterProgress.status, props.goal.narrativeKind)}
                        {" · "}
                        {props.chapterProgress.summary}
                      </p>
                    : <p className="creation-desk-goal-progress-summary empty">
                        {chapterSituationEmptyHint(props.goal.narrativeKind)}
                      </p>}
                </div>
              </>}
        </div>
      : null}
    {props.historyOpen
      ? <div className="creation-desk-goal-history" data-testid="creation-desk-goal-history">
          {props.history.length === 0
            ? <p className="creation-desk-goals-empty">暂无历史记录</p>
            : props.history.map((item) => <div key={item.progressId} className="creation-desk-goal-history-row">
                <span className="creation-desk-goal-history-chapter">第 {item.chapterSequence} 章</span>
                <span className={`creation-desk-goal-history-status status-${item.status}`}>
                  {progressStatusLabel(item.status, props.goal.narrativeKind)}
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
