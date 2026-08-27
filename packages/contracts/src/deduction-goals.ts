import { z } from "zod"

import { idSchema } from "./ids.js"

export const deductionGoalLifecycleSchema = z.enum(["active", "completed", "removed"])
export type DeductionGoalLifecycle = z.infer<typeof deductionGoalLifecycleSchema>

export const deductionGoalSourceSchema = z.enum(["user", "agent"])
export type DeductionGoalSource = z.infer<typeof deductionGoalSourceSchema>

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

export const deductionGoalSchema = z.object({
  goalId: idSchema,
  projectId: idSchema,
  content: z.string().min(1).max(2_000),
  source: deductionGoalSourceSchema,
  lifecycle: deductionGoalLifecycleSchema,
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().optional(),
  removedAtMs: z.number().int().nonnegative().optional(),
  removedBy: z.enum(["user", "agent"]).optional(),
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
  }),
  z.object({
    kind: z.literal("update_content"),
    goalId: idSchema,
    content: z.string().min(1).max(2_000),
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
