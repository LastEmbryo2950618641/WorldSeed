import { z } from "zod"

import { idSchema } from "./ids.js"
import { modelContextMessageSchema } from "./model-context.js"

export const historyEntryKindSchema = z.enum(["automatic", "manual"])
export type HistoryEntryKind = z.infer<typeof historyEntryKindSchema>

export const historyEntryStateSchema = z.enum(["complete_world", "paused_checkpoint"])
export type HistoryEntryState = z.infer<typeof historyEntryStateSchema>

export const historyEntryStatusSchema = z.enum(["preparing", "ready", "failed"])
export type HistoryEntryStatus = z.infer<typeof historyEntryStatusSchema>

export const historyBranchStatusSchema = z.enum(["active", "archived"])
export type HistoryBranchStatus = z.infer<typeof historyBranchStatusSchema>

export const historyEntrySummarySchema = z.object({
  entryId: idSchema,
  projectId: idSchema,
  branchId: idSchema,
  parentEntryId: idSchema.optional(),
  kind: historyEntryKindSchema,
  state: historyEntryStateSchema,
  status: historyEntryStatusSchema,
  name: z.string().trim().min(1).max(200),
  note: z.string().max(4_000).optional(),
  committedSequence: z.number().int().nonnegative(),
  taskId: idSchema.optional(),
  checkpointId: idSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().optional(),
})
export type HistoryEntrySummary = z.infer<typeof historyEntrySummarySchema>

export const historyBranchSummarySchema = z.object({
  branchId: idSchema,
  projectId: idSchema,
  parentBranchId: idSchema.optional(),
  forkEntryId: idSchema.optional(),
  name: z.string().trim().min(1).max(200),
  status: historyBranchStatusSchema,
  worldHeadEntryId: idSchema.optional(),
  historyHeadEntryId: idSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type HistoryBranchSummary = z.infer<typeof historyBranchSummarySchema>

export const historyCheckoutResultSchema = z.object({
  entry: historyEntrySummarySchema,
  branch: historyBranchSummarySchema,
  activeGeneration: z.number().int().nonnegative(),
  graphAnchorIds: z.array(z.string().min(1)),
  restoredTaskId: idSchema.optional(),
})
export type HistoryCheckoutResult = z.infer<typeof historyCheckoutResultSchema>

export const historyOverviewSchema = z.object({
  entries: z.array(historyEntrySummarySchema),
  branches: z.array(historyBranchSummarySchema),
  activeBranchId: idSchema.optional(),
  selectedEntryId: idSchema.optional(),
  graphAnchorIds: z.array(z.string().min(1)).default([]),
})
export type HistoryOverview = z.infer<typeof historyOverviewSchema>

const graphHeadSchema = z.object({
  objectId: z.string().min(1),
  revisionId: z.string().min(1),
  sourceScopeId: idSchema,
  visibility: z.enum(["pending", "committed", "retired"]),
  effectiveAtMs: z.number().int().nonnegative(),
  digest: z.string().min(1),
})

const documentHeadSchema = z.object({
  chapterId: z.string().min(1),
  documentVersionId: z.string().min(1),
  scopeId: idSchema,
})

const canonicalChapterSchema = z.object({
  messageId: idSchema,
  taskId: idSchema,
  turnId: idSchema,
  contextId: idSchema,
  sourceId: z.string().min(1),
  chapterSequence: z.number().int().positive(),
  chapterPath: z.string().min(1),
  chapterHeading: z.string().min(1),
  contentRef: z.string().min(1),
  contentDigest: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
})

const workspaceHistoryFileSchema = z.object({
  relativePath: z.string().min(1),
  digest: z.string().min(1),
  size: z.number().int().nonnegative(),
  gitPath: z.string().min(1),
})

export const historyManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: idSchema,
  entryId: idSchema,
  branchId: idSchema,
  parentEntryId: idSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  committedSequence: z.number().int().nonnegative(),
  activeGeneration: z.number().int().nonnegative(),
  activeScopeIds: z.array(idSchema),
  nodeHeads: z.array(graphHeadSchema),
  linkHeads: z.array(graphHeadSchema),
  documentHeads: z.array(documentHeadSchema),
  canonicalChapters: z.array(canonicalChapterSchema).optional(),
  modelContext: z.object({
    chainId: idSchema,
    messages: z.array(modelContextMessageSchema),
    hiddenMessages: z.array(z.object({
      messageId: idSchema,
      hiddenAtMs: z.number().int().nonnegative(),
    }).strict()).optional(),
  }).optional(),
  taskCheckpointId: idSchema.optional(),
  workspace: z.array(workspaceHistoryFileSchema),
  baseRulesDigest: z.string().min(1),
  digest: z.string().min(1),
})
export type HistoryManifest = z.infer<typeof historyManifestSchema>

export const historyRetentionPreviewSchema = z.object({
  retentionLimit: z.number().int().positive().max(100_000).nullable(),
  currentCount: z.number().int().nonnegative(),
  deleteCount: z.number().int().nonnegative(),
  oldestDeletedAtMs: z.number().int().nonnegative().optional(),
  newestDeletedAtMs: z.number().int().nonnegative().optional(),
  affectedBranchIds: z.array(idSchema),
})
export type HistoryRetentionPreview = z.infer<typeof historyRetentionPreviewSchema>
