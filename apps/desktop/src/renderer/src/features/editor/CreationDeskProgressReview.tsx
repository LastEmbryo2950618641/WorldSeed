import { CheckCircle2, CircleDashed, Target, XCircle } from "lucide-react"
import type { ReviewableGoalProgress } from "./creation-desk-goals.js"

type ReviewStatus = "achieved" | "partial" | "missed"

type Props = Readonly<{
  items: readonly ReviewableGoalProgress[]
  busy?: boolean
  onReview(
    goalId: string,
    chapterSequence: number,
    status: ReviewStatus,
    summary: string,
  ): Promise<void>
  onClose?(): void
  compact?: boolean
}>

const STATUS_LABELS: Record<ReviewStatus, string> = {
  achieved: "已达成",
  partial: "部分达成",
  missed: "未达成",
}

export function CreationDeskProgressReview(props: Props): React.JSX.Element | null {
  if (props.items.length === 0) return null

  return <section
    className={`creation-desk-progress-review${props.compact === true ? " compact" : ""}`}
    data-testid="creation-desk-progress-review"
  >
    <header className="creation-desk-progress-review-header">
      <div>
        <Target size={14} aria-hidden="true" />
        <h3>章后目标复盘</h3>
        <span>{props.items.length} 条待确认</span>
      </div>
      {props.onClose === undefined
        ? null
        : <button type="button" className="muted" onClick={props.onClose}>稍后</button>}
    </header>
    <p className="creation-desk-progress-review-hint">
      对照本章正文，确认各目标锁定预期的达成情况。复盘结果会进入下一章讨论上下文。
    </p>
    <div className="creation-desk-progress-review-list">
      {props.items.map((item) => <ReviewCard
        key={item.progress.progressId}
        item={item}
        busy={props.busy === true}
        onReview={props.onReview}
      />)}
    </div>
  </section>
}

function ReviewCard(props: Readonly<{
  item: ReviewableGoalProgress
  busy: boolean
  onReview(
    goalId: string,
    chapterSequence: number,
    status: ReviewStatus,
    summary: string,
  ): Promise<void>
}>): React.JSX.Element {
  const { goal, progress } = props.item
  return <article className="creation-desk-progress-review-card" data-testid="creation-desk-progress-review-card">
    <div className="creation-desk-progress-review-card-meta">
      第 {progress.chapterSequence} 章
    </div>
    <h4>{goal.content}</h4>
    <p>{progress.summary}</p>
    <div className="creation-desk-progress-review-actions">
      <button
        type="button"
        data-testid="creation-desk-review-achieved"
        disabled={props.busy}
        onClick={() => { void props.onReview(goal.goalId, progress.chapterSequence, "achieved", progress.summary); }}
      >
        <CheckCircle2 size={13} aria-hidden="true" />{STATUS_LABELS.achieved}
      </button>
      <button
        type="button"
        data-testid="creation-desk-review-partial"
        disabled={props.busy}
        onClick={() => { void props.onReview(goal.goalId, progress.chapterSequence, "partial", progress.summary); }}
      >
        <CircleDashed size={13} aria-hidden="true" />{STATUS_LABELS.partial}
      </button>
      <button
        type="button"
        className="danger"
        data-testid="creation-desk-review-missed"
        disabled={props.busy}
        onClick={() => { void props.onReview(goal.goalId, progress.chapterSequence, "missed", progress.summary); }}
      >
        <XCircle size={13} aria-hidden="true" />{STATUS_LABELS.missed}
      </button>
    </div>
  </article>
}
