import type {
  DeductionGoal,
  DeductionGoalProgress,
  DeductionGoalProposal,
  DeductionGoalsSnapshot,
} from "@worldseed/contracts"
import {
  isGoalRelevantToChapter,
  labelForGoalProgressStatus,
  labelForGoalRowChip,
} from "@worldseed/contracts"

export const CREATION_DESK_GOALS_PAGE_SIZE = 8

const LEGACY_STORAGE_PREFIX = "worldseed.creationDeskGoals."

export function listActiveGoals(goals: readonly DeductionGoal[]): readonly DeductionGoal[] {
  return goals.filter((goal) => goal.lifecycle === "active")
}

export function listChapterRelevantGoals(
  goals: readonly DeductionGoal[],
  chapterSequence: number,
): readonly DeductionGoal[] {
  return listActiveGoals(goals).filter((goal) => isGoalRelevantToChapter(goal, chapterSequence))
}

export function narrativeKindLabel(kind: DeductionGoal["narrativeKind"]): string {
  if (kind === "foreshadow") return "伏笔"
  if (kind === "climax") return "高潮"
  return "目标"
}

export function scaleLabel(scale: DeductionGoal["scale"]): string {
  if (scale === "medium") return "中"
  if (scale === "long") return "长"
  return "短"
}

export type GoalTaxonomyInput = Readonly<{
  narrativeKind?: DeductionGoal["narrativeKind"]
  scale?: DeductionGoal["scale"]
  plantChapterSequence?: number
  payoffChapterSequence?: number
}>

export function formatGoalTaxonomyChip(
  kind: DeductionGoal["narrativeKind"] | undefined,
  scale: DeductionGoal["scale"] | undefined,
): string | undefined {
  if (kind === undefined || kind === "general") {
    return scale === undefined || scale === "short" ? undefined : `目标·${scaleLabel(scale)}`
  }
  return `${narrativeKindLabel(kind)}·${scaleLabel(scale ?? "short")}`
}

export function listPendingProposals(
  proposals: readonly DeductionGoalProposal[],
): readonly DeductionGoalProposal[] {
  return proposals.filter((proposal) => proposal.status === "pending")
}

export function findChapterProgress(
  progress: readonly DeductionGoalProgress[],
  goalId: string,
  chapterSequence: number,
): DeductionGoalProgress | undefined {
  return progress.find((item) => item.goalId === goalId
    && item.chapterSequence === chapterSequence
    && item.status !== "superseded")
}

export type ReviewableGoalProgress = Readonly<{
  goal: DeductionGoal
  progress: DeductionGoalProgress
}>

/** Locked planned rows awaiting post-turn review (achieved / partial / missed). */
export function listReviewableProgress(
  goals: readonly DeductionGoal[],
  progress: readonly DeductionGoalProgress[],
  chapterSequence?: number,
): readonly ReviewableGoalProgress[] {
  const goalById = new Map(goals.map((goal) => [goal.goalId, goal] as const))
  const items: ReviewableGoalProgress[] = []
  for (const item of progress) {
    if (item.status !== "planned") continue
    if (item.lockedAtMs === undefined) continue
    if (chapterSequence !== undefined && item.chapterSequence !== chapterSequence) continue
    const goal = goalById.get(item.goalId)
    if (goal === undefined || goal.lifecycle === "removed") continue
    items.push({ goal, progress: item })
  }
  return items.sort((left, right) => left.progress.chapterSequence - right.progress.chapterSequence
    || left.goal.createdAtMs - right.goal.createdAtMs)
}

export function countPendingReviews(
  snapshot: DeductionGoalsSnapshot | undefined,
  chapterSequence?: number,
): number {
  if (snapshot === undefined) return 0
  return listReviewableProgress(snapshot.goals, snapshot.progress, chapterSequence).length
}

export function countFilledChapterProgress(
  goals: readonly DeductionGoal[],
  progress: readonly DeductionGoalProgress[],
  chapterSequence: number,
): Readonly<{ filled: number; total: number; unfilled: number }> {
  const active = listChapterRelevantGoals(goals, chapterSequence)
  let filled = 0
  for (const goal of active) {
    const item = findChapterProgress(progress, goal.goalId, chapterSequence)
    if (item !== undefined && item.summary.trim().length > 0) filled += 1
  }
  return {
    filled,
    total: active.length,
    unfilled: Math.max(0, active.length - filled),
  }
}

export function toolbarBadgeCount(
  snapshot: DeductionGoalsSnapshot | undefined,
  chapterSequence: number,
): number {
  if (snapshot === undefined) return 0
  const pending = listPendingProposals(snapshot.pendingProposals).length
  const { unfilled } = countFilledChapterProgress(snapshot.goals, snapshot.progress, chapterSequence)
  const reviews = countPendingReviews(snapshot, chapterSequence)
  return pending + unfilled + reviews
}

export function paginateGoals<T>(
  items: readonly T[],
  page: number,
  pageSize = CREATION_DESK_GOALS_PAGE_SIZE,
): Readonly<{ items: readonly T[]; page: number; totalPages: number }> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const start = (safePage - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
  }
}

/** All progress rows for one goal, newest chapter first within each sequence. */
export function listGoalProgressHistory(
  progress: readonly DeductionGoalProgress[],
  goalId: string,
): readonly DeductionGoalProgress[] {
  return [...progress]
    .filter((item) => item.goalId === goalId)
    .sort((left, right) => right.chapterSequence - left.chapterSequence
      || right.recordedAtMs - left.recordedAtMs)
}

export type GoalRowScope = "overview" | "chapter"

export type GoalRowStatus = Readonly<{
  kind: "empty" | "planned" | "locked" | "review" | "achieved" | "partial" | "missed" | "completed" | "pending_agent"
  label: string
}>

export function resolveGoalRowStatus(input: Readonly<{
  goal: DeductionGoal
  chapterProgress: DeductionGoalProgress | undefined
  scope: GoalRowScope
  reviewable: boolean
}>): GoalRowStatus {
  const kind = input.goal.narrativeKind
  if (input.scope === "overview") {
    if (input.goal.lifecycle === "completed") {
      return { kind: "completed", label: labelForGoalRowChip("completed", kind) }
    }
    return { kind: "planned", label: "进行中" }
  }
  if (input.reviewable) return { kind: "review", label: labelForGoalRowChip("review", kind) }
  const item = input.chapterProgress
  if (item === undefined || item.summary.trim().length === 0) {
    return { kind: "empty", label: labelForGoalRowChip("empty", kind) }
  }
  if (item.status === "achieved") return { kind: "achieved", label: labelForGoalRowChip("achieved", kind) }
  if (item.status === "partial") return { kind: "partial", label: labelForGoalRowChip("partial", kind) }
  if (item.status === "missed") return { kind: "missed", label: labelForGoalRowChip("missed", kind) }
  if (item.lockedAtMs !== undefined) return { kind: "locked", label: labelForGoalRowChip("locked", kind) }
  return { kind: "planned", label: labelForGoalRowChip("planned", kind) }
}

export function progressStatusLabel(
  status: DeductionGoalProgress["status"],
  narrativeKind: DeductionGoal["narrativeKind"] = "general",
): string {
  return labelForGoalProgressStatus(status, narrativeKind)
}

export type LegacyCreationDeskGoal = Readonly<{
  goalId: string
  content: string
  source: "user" | "agent"
  status: "active" | "completed" | "pending"
  createdAtMs: number
  completedAtMs?: number
}>

export function loadLegacyCreationDeskGoals(projectId: string | undefined): readonly LegacyCreationDeskGoal[] {
  if (projectId === undefined || typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(`${LEGACY_STORAGE_PREFIX}${projectId}`)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as { goals?: unknown }
    if (!Array.isArray(parsed.goals)) return []
    return parsed.goals.filter(isLegacyGoal)
  } catch {
    return []
  }
}

export function clearLegacyCreationDeskGoals(projectId: string | undefined): void {
  if (projectId === undefined || typeof window === "undefined") return
  window.localStorage.removeItem(`${LEGACY_STORAGE_PREFIX}${projectId}`)
}

function isLegacyGoal(value: unknown): value is LegacyCreationDeskGoal {
  if (typeof value !== "object" || value === null) return false
  const goal = value as Partial<LegacyCreationDeskGoal>
  return typeof goal.goalId === "string"
    && typeof goal.content === "string"
    && (goal.source === "user" || goal.source === "agent")
    && (goal.status === "active" || goal.status === "completed" || goal.status === "pending")
    && typeof goal.createdAtMs === "number"
}
