import { z } from "zod"

import { idSchema } from "./ids.js"

export const chapterRevisionStatusSchema = z.enum([
  "editing",
  "reviewing",
  "ready_to_submit",
  "committing_content",
  "content_committed",
  "chapter_published",
  "chapter_registered",
  "graph_sync_pending",
  "graph_sync_running",
  "completed",
  "retired",
  "failed",
  "awaiting_user_decision",
])
export type ChapterRevisionStatus = z.infer<typeof chapterRevisionStatusSchema>

export const chapterGraphSyncStatusSchema = z.enum(["not_started", "pending", "running", "completed", "failed"])
export type ChapterGraphSyncStatus = z.infer<typeof chapterGraphSyncStatusSchema>

export const chapterRevisionFinalizationStatusSchema = z.enum([
  "prepared",
  "content_committed",
  "chapter_published",
  "chapter_registered",
  "graph_sync_pending",
  "graph_sync_running",
  "completed",
])
export type ChapterRevisionFinalizationStatus = z.infer<typeof chapterRevisionFinalizationStatusSchema>

export const chapterRevisionFinalizationSchema = z.object({
  finalizationId: idSchema,
  revisionTaskId: idSchema,
  status: chapterRevisionFinalizationStatusSchema,
  graphSyncTaskId: idSchema.optional(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type ChapterRevisionFinalization = z.infer<typeof chapterRevisionFinalizationSchema>

export const chapterRevisionSubmissionModeSchema = z.enum(["direct", "reviewed"])
export type ChapterRevisionSubmissionMode = z.infer<typeof chapterRevisionSubmissionModeSchema>

export const chapterRevisionDecisionReasonSchema = z.enum(["user_forced_edit", "user_reviewed_edit"])
export type ChapterRevisionDecisionReason = z.infer<typeof chapterRevisionDecisionReasonSchema>

export const chapterSummarySchema = z.object({
  chapterId: z.string().min(1),
  sourceId: z.string().min(1),
  heading: z.string().min(1),
  publishPath: z.string().min(1),
  digest: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
})
export type ChapterSummary = z.infer<typeof chapterSummarySchema>

export const chapterReadResultSchema = chapterSummarySchema.extend({ content: z.string(), body: z.string() })
export type ChapterReadResult = z.infer<typeof chapterReadResultSchema>

export const revisionIssueSchema = z.object({
  location: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(["suggestion", "notice"]),
  evidenceRefs: z.array(z.string().min(1)),
  description: z.string().min(1),
  impact: z.string().min(1),
  suggestion: z.string().min(1),
  requiresGraphSync: z.boolean(),
  affectsLaterChapters: z.boolean(),
})
export type RevisionIssue = z.infer<typeof revisionIssueSchema>

export const chapterRevisionReviewSchema = z.object({
  reviewId: idSchema,
  revisionTaskId: idSchema,
  proposedSourceId: z.string().min(1),
  contentDigest: z.string().min(1),
  issues: z.array(revisionIssueSchema),
  recommendation: z.enum(["no_issue", "review_suggested", "material_conflict"]),
  createdAtMs: z.number().int().nonnegative(),
})
export type ChapterRevisionReview = z.infer<typeof chapterRevisionReviewSchema>

export const chapterRevisionSchema = z.object({
  revisionTaskId: idSchema,
  projectId: idSchema,
  chapterId: z.string().min(1),
  baseSourceId: z.string().min(1),
  proposedSourceId: z.string().min(1),
  predecessorSourceId: z.string().min(1).optional(),
  heading: z.string().min(1),
  contentDigest: z.string().min(1),
  submissionMode: chapterRevisionSubmissionModeSchema.optional(),
  decision: z.enum(["pending", "submit", "abandon"]),
  review: chapterRevisionReviewSchema.optional(),
  graphSyncStatus: chapterGraphSyncStatusSchema,
  graphSyncTaskId: idSchema.optional(),
  finalization: chapterRevisionFinalizationSchema.optional(),
  status: chapterRevisionStatusSchema,
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type ChapterRevision = z.infer<typeof chapterRevisionSchema>

export const chapterRevisionReadResultSchema = chapterRevisionSchema.extend({ proposedContent: z.string(), proposedBody: z.string() })
export type ChapterRevisionReadResult = z.infer<typeof chapterRevisionReadResultSchema>

export const chapterRevisionDecisionSchema = z.object({
  decisionId: idSchema,
  revisionTaskId: idSchema,
  proposedSourceId: z.string().min(1),
  contentDigest: z.string().min(1),
  mode: chapterRevisionSubmissionModeSchema,
  action: z.enum(["submit", "abandon"]),
  forced: z.boolean(),
  reason: chapterRevisionDecisionReasonSchema,
  reviewId: idSchema.optional(),
  note: z.string().max(4_000).optional(),
  createdAtMs: z.number().int().nonnegative(),
})
export type ChapterRevisionDecision = z.infer<typeof chapterRevisionDecisionSchema>
