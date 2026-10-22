import type { DeductionGoal, DeductionGoalProgress } from "@worldseed/contracts"

import { findChapterProgress, listActiveGoals } from "./creation-desk-goals.js"
import type { DiscussFocusChapterOption } from "./synopsis-path.js"

export function isHookScheduleIncomplete(goal: Readonly<{
  narrativeKind: DeductionGoal["narrativeKind"]
  plantChapterSequence?: number
  payoffChapterSequence?: number
}>): boolean {
  if (goal.narrativeKind !== "foreshadow" && goal.narrativeKind !== "climax") return false
  return goal.plantChapterSequence === undefined || goal.payoffChapterSequence === undefined
}

export type VolumeHookRole = "plant" | "payoff" | "window"

export type VolumeChapterHookItem = Readonly<{
  goalId: string
  content: string
  narrativeKind: DeductionGoal["narrativeKind"]
  scale: DeductionGoal["scale"]
  roles: readonly VolumeHookRole[]
  incompleteSchedule: boolean
  plantChapterSequence?: number
  payoffChapterSequence?: number
  progressStatus?: DeductionGoalProgress["status"]
}>

export type VolumeHookStatusCounts = Readonly<{
  incompleteSchedule: number
  completeSchedule: number
  planned: number
  partial: number
  achieved: number
  missed: number
  noProgress: number
}>

export type VolumeChapterHookSummary = Readonly<{
  chapterSequence: number
  chapterLabel: string
  plantCount: number
  payoffCount: number
  hookCount: number
  statusCounts: VolumeHookStatusCounts
  hooks: readonly VolumeChapterHookItem[]
}>

export type VolumeHookDensityReport = Readonly<{
  chapterRows: readonly VolumeChapterHookSummary[]
  totals: Readonly<{
    hookCount: number
    plantCount: number
    payoffCount: number
    incompleteSchedule: number
    completeSchedule: number
  }>
  densityWarning?: string
}>

function listActiveHooks(goals: readonly DeductionGoal[]): readonly DeductionGoal[] {
  return listActiveGoals(goals).filter((goal) => (
    goal.narrativeKind === "foreshadow" || goal.narrativeKind === "climax"
  ))
}

function rolesForChapter(goal: DeductionGoal, chapterSequence: number): VolumeHookRole[] {
  const roles: VolumeHookRole[] = []
  if (goal.plantChapterSequence === chapterSequence) roles.push("plant")
  if (goal.payoffChapterSequence === chapterSequence) roles.push("payoff")
  if (roles.length > 0) return roles
  const plant = goal.plantChapterSequence
  const payoff = goal.payoffChapterSequence
  if (plant !== undefined && payoff !== undefined) {
    if (chapterSequence > plant && chapterSequence < payoff) roles.push("window")
  } else if (plant !== undefined && chapterSequence > plant) {
    roles.push("window")
  } else if (payoff !== undefined && chapterSequence < payoff && plant === undefined) {
    roles.push("window")
  }
  return roles
}

function emptyStatusCounts(): VolumeHookStatusCounts {
  return {
    incompleteSchedule: 0,
    completeSchedule: 0,
    planned: 0,
    partial: 0,
    achieved: 0,
    missed: 0,
    noProgress: 0,
  }
}

function bumpStatus(
  counts: VolumeHookStatusCounts,
  incomplete: boolean,
  progressStatus: DeductionGoalProgress["status"] | undefined,
): VolumeHookStatusCounts {
  const next = { ...counts }
  if (incomplete) next.incompleteSchedule += 1
  else next.completeSchedule += 1
  if (progressStatus === "planned") next.planned += 1
  else if (progressStatus === "partial") next.partial += 1
  else if (progressStatus === "achieved") next.achieved += 1
  else if (progressStatus === "missed") next.missed += 1
  else next.noProgress += 1
  return next
}

/** Per-chapter hook density for a volume: plants, payoffs, status mix, and concrete hooks. */
export function buildVolumeHookDensityReport(
  chapters: readonly DiscussFocusChapterOption[],
  goals: readonly DeductionGoal[],
  progress: readonly DeductionGoalProgress[] = [],
): VolumeHookDensityReport {
  const hooks = listActiveHooks(goals)
  const sortedChapters = [...chapters].sort((left, right) => left.sequence - right.sequence)
  const chapterRows: VolumeChapterHookSummary[] = sortedChapters.map((chapter) => {
    const items: VolumeChapterHookItem[] = []
    let plantCount = 0
    let payoffCount = 0
    let statusCounts = emptyStatusCounts()
    for (const goal of hooks) {
      const roles = rolesForChapter(goal, chapter.sequence)
      if (roles.length === 0) continue
      if (roles.includes("plant")) plantCount += 1
      if (roles.includes("payoff")) payoffCount += 1
      const incomplete = isHookScheduleIncomplete(goal)
      const chapterProgress = findChapterProgress(progress, goal.goalId, chapter.sequence)
      const progressStatus = chapterProgress?.status === "superseded"
        ? undefined
        : chapterProgress?.status
      statusCounts = bumpStatus(statusCounts, incomplete, progressStatus)
      items.push({
        goalId: goal.goalId,
        content: goal.content,
        narrativeKind: goal.narrativeKind,
        scale: goal.scale,
        roles,
        incompleteSchedule: incomplete,
        ...(goal.plantChapterSequence === undefined ? {} : { plantChapterSequence: goal.plantChapterSequence }),
        ...(goal.payoffChapterSequence === undefined ? {} : { payoffChapterSequence: goal.payoffChapterSequence }),
        ...(progressStatus === undefined ? {} : { progressStatus }),
      })
    }
    items.sort((left, right) => {
      const rank = (roles: readonly VolumeHookRole[]): number => (
        roles.includes("payoff") ? 0 : roles.includes("plant") ? 1 : 2
      )
      const roleDiff = rank(left.roles) - rank(right.roles)
      if (roleDiff !== 0) return roleDiff
      return left.goalId.localeCompare(right.goalId)
    })
    return {
      chapterSequence: chapter.sequence,
      chapterLabel: chapter.label,
      plantCount,
      payoffCount,
      hookCount: items.length,
      statusCounts,
      hooks: items,
    }
  })

  const volumeSequences = new Set(sortedChapters.map((chapter) => chapter.sequence))
  const volumeHooks = hooks.filter((goal) => (
    (goal.plantChapterSequence !== undefined && volumeSequences.has(goal.plantChapterSequence))
    || (goal.payoffChapterSequence !== undefined && volumeSequences.has(goal.payoffChapterSequence))
    || chapterRows.some((row) => row.hooks.some((item) => item.goalId === goal.goalId))
  ))
  const totals = {
    hookCount: volumeHooks.length,
    plantCount: chapterRows.reduce((sum, row) => sum + row.plantCount, 0),
    payoffCount: chapterRows.reduce((sum, row) => sum + row.payoffCount, 0),
    incompleteSchedule: volumeHooks.filter((goal) => isHookScheduleIncomplete(goal)).length,
    completeSchedule: volumeHooks.filter((goal) => !isHookScheduleIncomplete(goal)).length,
  }

  const densityWarning = detectHookDensityWarning(chapterRows, totals)
  return {
    chapterRows,
    totals,
    ...(densityWarning === undefined ? {} : { densityWarning }),
  }
}

export function detectHookDensityWarning(
  chapterRows: readonly VolumeChapterHookSummary[],
  totals: VolumeHookDensityReport["totals"],
): string | undefined {
  let plantOnlyStreak = 0
  let maxPlantOnlyStreak = 0
  for (const row of chapterRows) {
    if (row.plantCount > 0 && row.payoffCount === 0) {
      plantOnlyStreak += 1
      maxPlantOnlyStreak = Math.max(maxPlantOnlyStreak, plantOnlyStreak)
    } else {
      plantOnlyStreak = 0
    }
  }
  if (maxPlantOnlyStreak >= 3) {
    return `连续 ${String(maxPlantOnlyStreak)} 章只埋未收，钩子密度失衡，建议安排兑现，避免一直铺垫。`
  }
  if (totals.plantCount >= 3 && totals.payoffCount === 0) {
    return "本卷已埋多枚钩子但尚无兑现安排，注意控制铺垫节奏。"
  }
  if (totals.incompleteSchedule > 0 && totals.incompleteSchedule >= Math.max(2, totals.hookCount - 1)) {
    return "多数钩子时限不完整；能确定的请补齐兑现章，不确定的可暂留空并在后续讨论收束。"
  }
  return undefined
}

export function hookRoleLabel(role: VolumeHookRole): string {
  if (role === "plant") return "埋"
  if (role === "payoff") return "收"
  return "推"
}
