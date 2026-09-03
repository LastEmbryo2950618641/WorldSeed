import { z } from "zod"

import { idSchema } from "./ids.js"

export const deductionGoalLifecycleSchema = z.enum(["active", "completed", "removed"])
export type DeductionGoalLifecycle = z.infer<typeof deductionGoalLifecycleSchema>

export const deductionGoalSourceSchema = z.enum(["user", "agent"])
export type DeductionGoalSource = z.infer<typeof deductionGoalSourceSchema>

/** Narrative taxonomy on the goal itself (not GoalProposalKind). */
export const deductionGoalNarrativeKindSchema = z.enum(["general", "foreshadow", "climax"])
export type DeductionGoalNarrativeKind = z.infer<typeof deductionGoalNarrativeKindSchema>

/** Time horizon for climax / foreshadow commitments. */
export const deductionGoalScaleSchema = z.enum(["short", "medium", "long"])
export type DeductionGoalScale = z.infer<typeof deductionGoalScaleSchema>

export const goalProgressStatusSchema = z.enum([
  "planned",
  "achieved",
  "partial",
  "missed",
  "superseded",
])
export type GoalProgressStatus = z.infer<typeof goalProgressStatusSchema>

export const goalProgressSourceSchema = z.enum(["synopsis_discuss", "turn_review", "user"])
export type GoalProgressSource = z.infer<typeof goalProgressSourceSchema>

export const goalProposalKindSchema = z.enum([
  "create",
  "update_content",
  "complete",
  "remove",
  "set_chapter_progress",
])
export type GoalProposalKind = z.infer<typeof goalProposalKindSchema>

export const goalProposalStatusSchema = z.enum(["pending", "approved", "rejected"])
export type GoalProposalStatus = z.infer<typeof goalProposalStatusSchema>

const optionalChapterSequenceSchema = z.number().int().positive().optional()

export const deductionGoalSchema = z.object({
  goalId: idSchema,
  projectId: idSchema,
  content: z.string().min(1).max(2_000),
  source: deductionGoalSourceSchema,
  lifecycle: deductionGoalLifecycleSchema,
  narrativeKind: deductionGoalNarrativeKindSchema.default("general"),
  scale: deductionGoalScaleSchema.default("short"),
  plantChapterSequence: optionalChapterSequenceSchema,
  payoffChapterSequence: optionalChapterSequenceSchema,
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().optional(),
  removedAtMs: z.number().int().nonnegative().optional(),
  removedBy: z.enum(["user", "agent"]).optional(),
}).superRefine((goal, context) => {
  if (
    goal.plantChapterSequence !== undefined
    && goal.payoffChapterSequence !== undefined
    && goal.plantChapterSequence > goal.payoffChapterSequence
  ) {
    context.addIssue({
      code: "custom",
      message: "plantChapterSequence must be ≤ payoffChapterSequence",
      path: ["plantChapterSequence"],
    })
  }
})
export type DeductionGoal = z.infer<typeof deductionGoalSchema>

export const deductionGoalProgressSchema = z.object({
  progressId: idSchema,
  projectId: idSchema,
  goalId: idSchema,
  chapterSequence: z.number().int().positive(),
  chapterId: z.string().min(1).optional(),
  summary: z.string().max(4_000),
  status: goalProgressStatusSchema,
  source: goalProgressSourceSchema,
  lockedAtMs: z.number().int().nonnegative().optional(),
  recordedAtMs: z.number().int().nonnegative(),
})
export type DeductionGoalProgress = z.infer<typeof deductionGoalProgressSchema>

export const goalProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    content: z.string().min(1).max(2_000),
    narrativeKind: deductionGoalNarrativeKindSchema.optional(),
    scale: deductionGoalScaleSchema.optional(),
    plantChapterSequence: optionalChapterSequenceSchema,
    payoffChapterSequence: optionalChapterSequenceSchema,
  }).superRefine((payload, context) => {
    if (
      payload.plantChapterSequence !== undefined
      && payload.payoffChapterSequence !== undefined
      && payload.plantChapterSequence > payload.payoffChapterSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "plantChapterSequence must be ≤ payoffChapterSequence",
        path: ["plantChapterSequence"],
      })
    }
  }),
  z.object({
    kind: z.literal("update_content"),
    goalId: idSchema,
    content: z.string().min(1).max(2_000).optional(),
    narrativeKind: deductionGoalNarrativeKindSchema.optional(),
    scale: deductionGoalScaleSchema.optional(),
    plantChapterSequence: optionalChapterSequenceSchema,
    payoffChapterSequence: optionalChapterSequenceSchema,
  }).superRefine((payload, context) => {
    const hasTaxonomy = payload.narrativeKind !== undefined
      || payload.scale !== undefined
      || payload.plantChapterSequence !== undefined
      || payload.payoffChapterSequence !== undefined
    if ((payload.content === undefined || payload.content.trim().length === 0) && !hasTaxonomy) {
      context.addIssue({
        code: "custom",
        message: "content or taxonomy fields required for update_content",
        path: ["content"],
      })
    }
    if (
      payload.plantChapterSequence !== undefined
      && payload.payoffChapterSequence !== undefined
      && payload.plantChapterSequence > payload.payoffChapterSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "plantChapterSequence must be ≤ payoffChapterSequence",
        path: ["plantChapterSequence"],
      })
    }
  }),
  z.object({
    kind: z.literal("complete"),
    goalId: idSchema,
  }),
  z.object({
    kind: z.literal("remove"),
    goalId: idSchema,
    reason: z.string().max(1_000).optional(),
  }),
  z.object({
    kind: z.literal("set_chapter_progress"),
    goalId: idSchema,
    chapterSequence: z.number().int().positive(),
    summary: z.string().min(1).max(4_000),
  }),
])
export type GoalProposalPayload = z.infer<typeof goalProposalPayloadSchema>

export const deductionGoalProposalSchema = z.object({
  proposalId: idSchema,
  projectId: idSchema,
  kind: goalProposalKindSchema,
  goalId: idSchema.optional(),
  payload: goalProposalPayloadSchema,
  status: goalProposalStatusSchema,
  sourceMessageId: idSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().optional(),
})
export type DeductionGoalProposal = z.infer<typeof deductionGoalProposalSchema>

export const deductionGoalsSnapshotSchema = z.object({
  projectId: idSchema,
  goals: z.array(deductionGoalSchema),
  progress: z.array(deductionGoalProgressSchema),
  pendingProposals: z.array(deductionGoalProposalSchema),
  updatedAtMs: z.number().int().nonnegative(),
})
export type DeductionGoalsSnapshot = z.infer<typeof deductionGoalsSnapshotSchema>

export const turnDeductionGoalBundleSchema = z.object({
  chapterSequence: z.number().int().positive(),
  activeGoals: z.array(deductionGoalSchema),
  chapterProgress: z.array(deductionGoalProgressSchema),
})
export type TurnDeductionGoalBundle = z.infer<typeof turnDeductionGoalBundleSchema>

export const deductionGoalReconcileIssueSchema = z.object({
  code: z.enum([
    "missing_chapter_progress",
    "pending_proposals",
    "synopsis_goal_mismatch",
  ]),
  severity: z.enum(["warning", "blocking"]),
  message: z.string().min(1),
  goalId: idSchema.optional(),
})
export type DeductionGoalReconcileIssue = z.infer<typeof deductionGoalReconcileIssueSchema>

export const deductionGoalReconcileResultSchema = z.object({
  warnings: z.array(deductionGoalReconcileIssueSchema),
  blocking: z.array(deductionGoalReconcileIssueSchema),
})
export type DeductionGoalReconcileResult = z.infer<typeof deductionGoalReconcileResultSchema>

/** Legacy localStorage prototype shape for one-shot import. */
export const deductionGoalsLegacyImportItemSchema = z.object({
  goalId: z.string().min(1),
  content: z.string().min(1),
  source: deductionGoalSourceSchema,
  status: z.enum(["active", "completed", "pending"]),
  createdAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().optional(),
})
export type DeductionGoalsLegacyImportItem = z.infer<typeof deductionGoalsLegacyImportItemSchema>

export const DEFAULT_CHAPTER_GOAL_CONTEXT_CAP = 24

/** Whether an active goal should appear in chapter-scoped UI / inject. */
export function isGoalRelevantToChapter(
  goal: Readonly<{
    lifecycle: DeductionGoalLifecycle
    plantChapterSequence?: number | undefined
    payoffChapterSequence?: number | undefined
  }>,
  chapterSequence: number,
): boolean {
  if (goal.lifecycle !== "active") return false
  const plant = goal.plantChapterSequence
  const payoff = goal.payoffChapterSequence
  if (plant === undefined && payoff === undefined) return true
  if (plant !== undefined && payoff !== undefined) {
    return chapterSequence >= plant && chapterSequence <= payoff
  }
  if (plant !== undefined) return chapterSequence >= plant
  return chapterSequence <= (payoff as number)
}

function goalChapterDistance(
  goal: Readonly<{
    plantChapterSequence?: number | undefined
    payoffChapterSequence?: number | undefined
  }>,
  chapterSequence: number,
): number {
  const plant = goal.plantChapterSequence
  const payoff = goal.payoffChapterSequence
  if (plant !== undefined && payoff !== undefined) {
    if (chapterSequence < plant) return plant - chapterSequence
    if (chapterSequence > payoff) return chapterSequence - payoff
    return 0
  }
  if (plant !== undefined) return Math.max(0, plant - chapterSequence)
  if (payoff !== undefined) return Math.max(0, chapterSequence - payoff)
  return 0
}

/** Filter + rank active goals for discuss/turn context (long-novel safe). */
export function selectGoalsForChapterContext(
  goals: readonly DeductionGoal[],
  chapterSequence: number,
  maxCount = DEFAULT_CHAPTER_GOAL_CONTEXT_CAP,
): readonly DeductionGoal[] {
  return [...goals]
    .filter((goal) => isGoalRelevantToChapter(goal, chapterSequence))
    .sort((left, right) => {
      const distance = goalChapterDistance(left, chapterSequence) - goalChapterDistance(right, chapterSequence)
      if (distance !== 0) return distance
      const kindRank = (kind: DeductionGoalNarrativeKind): number => (
        kind === "climax" ? 0 : kind === "foreshadow" ? 1 : 2
      )
      const kindDiff = kindRank(left.narrativeKind) - kindRank(right.narrativeKind)
      if (kindDiff !== 0) return kindDiff
      return left.createdAtMs - right.createdAtMs
    })
    .slice(0, Math.max(1, maxCount))
}

/** Expand-panel title for chapter situation block. */
export function chapterSituationSectionTitle(
  narrativeKind: DeductionGoalNarrativeKind,
  chapterSequence: number,
): string {
  if (narrativeKind === "foreshadow") return `第 ${String(chapterSequence)} 章收束情况`
  if (narrativeKind === "climax") return `第 ${String(chapterSequence)} 章推进情况`
  return `第 ${String(chapterSequence)} 章完成情况`
}

/** Empty-state hint under the chapter situation block. */
export function chapterSituationEmptyHint(
  narrativeKind: DeductionGoalNarrativeKind,
): string {
  if (narrativeKind === "foreshadow") {
    return "尚未填写本章收束预期；可在「…」菜单中编辑。埋→推→收写在摘要里，未回收勿标已收束。"
  }
  if (narrativeKind === "climax") {
    return "尚未填写本章推进预期；可在「…」菜单中编辑。峰值才标已爆发；褪去用后续章「在升温/褪去」摘要。"
  }
  return "尚未填写本章预期；可在「…」菜单中编辑本章预期。"
}

/**
 * Label for a progress.status value, interpreted by narrativeKind.
 * Form-adjacent `planned` stays neutral; outcome labels diverge by kind.
 */
export function labelForGoalProgressStatus(
  status: GoalProgressStatus,
  narrativeKind: DeductionGoalNarrativeKind = "general",
): string {
  if (status === "superseded") return "已取代"
  if (status === "planned") return "预期"
  if (narrativeKind === "foreshadow") {
    if (status === "achieved") return "已收束"
    if (status === "partial") return "有推进、未收"
    if (status === "missed") return "未收/错过窗口"
  }
  if (narrativeKind === "climax") {
    if (status === "achieved") return "已爆发"
    if (status === "partial") return "在升温"
    if (status === "missed") return "未爆发"
  }
  if (status === "achieved") return "已达成"
  if (status === "partial") return "部分达成"
  if (status === "missed") return "未达成"
  return status
}

export type GoalRowChipKind =
  | "empty"
  | "planned"
  | "locked"
  | "review"
  | "achieved"
  | "partial"
  | "missed"
  | "completed"
  | "pending_agent"

/** List/chip labels: form states are shared; outcome/review states map by kind. */
export function labelForGoalRowChip(
  chipKind: GoalRowChipKind,
  narrativeKind: DeductionGoalNarrativeKind = "general",
): string {
  if (chipKind === "empty") return "未填写"
  if (chipKind === "planned") return "已填写"
  if (chipKind === "locked") return "已锁定"
  if (chipKind === "completed") return "已完成"
  if (chipKind === "pending_agent") return "待采纳"
  if (chipKind === "review") {
    if (narrativeKind === "foreshadow") return "待核对收束"
    if (narrativeKind === "climax") return "待复盘推进"
    return "待复盘"
  }
  if (chipKind === "achieved" || chipKind === "partial" || chipKind === "missed") {
    return labelForGoalProgressStatus(chipKind, narrativeKind)
  }
  return chipKind
}

/** Menu/action label for editing this chapter's situation row. */
export function editChapterSituationLabel(
  narrativeKind: DeductionGoalNarrativeKind,
): string {
  if (narrativeKind === "foreshadow") return "编辑本章收束预期"
  if (narrativeKind === "climax") return "编辑本章推进预期"
  return "编辑本章预期"
}
