import { z } from "zod"

import {
  deductionGoalProposalSchema,
  deductionGoalReconcileResultSchema,
  goalProposalPayloadSchema,
  turnDeductionGoalBundleSchema,
} from "./deduction-goals.js"
import { idSchema } from "./ids.js"

export const chapterSynopsisSourceSchema = z.enum(["synopsis_file", "conversation", "turn_input"])
export type ChapterSynopsisSource = z.infer<typeof chapterSynopsisSourceSchema>

export const synopsisConversationChoiceSchema = z.object({
  label: z.string().min(1),
  action: z.enum(["start_turn", "continue_discuss", "promote_staging", "confirm_arc_plan"]),
})
export type SynopsisConversationChoice = z.infer<typeof synopsisConversationChoiceSchema>

export const turnMonitorPhaseSnapshotSchema = z.object({
  phase: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().max(500),
  artifactRef: z.string().min(1).optional(),
  finishedAtMs: z.number().int().nonnegative().optional(),
})
export type TurnMonitorPhaseSnapshot = z.infer<typeof turnMonitorPhaseSnapshotSchema>

export const turnHandoffBriefSchema = z.object({
  taskId: idSchema,
  chapterSequence: z.number().int().positive(),
  chapterPath: z.string().min(1),
  chapterHeading: z.string().min(1),
  bodyDigest: z.string().min(1).max(4_000),
  outlineNotes: z.array(z.string().min(1).max(500)).max(20),
  createdAtMs: z.number().int().nonnegative(),
})
export type TurnHandoffBrief = z.infer<typeof turnHandoffBriefSchema>

const stagingSettingsRelativePathSchema = z.string().regex(/^设定集\/[^/][^\n]*\.md$/u)

export const synopsisStagingPromoteWriteSchema = z.object({
  entryId: z.string().min(1),
  relativePath: stagingSettingsRelativePathSchema,
  markdown: z.string().min(1),
  readmeEntry: z.string().max(500).optional(),
  mode: z.enum(["create", "update"]),
})
export type SynopsisStagingPromoteWrite = z.infer<typeof synopsisStagingPromoteWriteSchema>

export const synopsisStagingPromoteStatusSchema = z.enum(["pending", "approved", "rejected"])
export type SynopsisStagingPromoteStatus = z.infer<typeof synopsisStagingPromoteStatusSchema>

export const synopsisStagingPromoteProposalSchema = z.object({
  proposalId: idSchema,
  projectId: idSchema,
  sessionId: idSchema,
  status: synopsisStagingPromoteStatusSchema,
  settingsWrites: z.array(synopsisStagingPromoteWriteSchema).min(1).max(30),
  goalProposals: z.array(z.object({
    payload: goalProposalPayloadSchema,
    reason: z.string().max(1_000).optional(),
  })).optional(),
  reason: z.string().max(1_000).optional(),
  sourceMessageId: idSchema.optional(),
  createdAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().optional(),
})
export type SynopsisStagingPromoteProposal = z.infer<typeof synopsisStagingPromoteProposalSchema>

export const synopsisStagingPromoteListResultSchema = z.object({
  proposals: z.array(synopsisStagingPromoteProposalSchema),
})
export type SynopsisStagingPromoteListResult = z.infer<typeof synopsisStagingPromoteListResultSchema>

export const synopsisConversationSessionSchema = z.object({
  sessionId: idSchema,
  projectId: idSchema,
  chapterSequence: z.number().int().positive(),
  synopsisPath: z.string().min(1),
  title: z.string().min(1),
  lastAgentDigest: z.string().min(1).optional(),
  turnBootstrapInput: z.string().optional(),
  status: z.enum(["active", "completed"]),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationSession = z.infer<typeof synopsisConversationSessionSchema>

export const synopsisConversationMessageSchema = z.object({
  messageId: idSchema,
  sessionId: idSchema,
  projectId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  reasoningContent: z.string().optional(),
  searching: z.array(z.object({
    query: z.string().min(1),
    status: z.enum(["running", "completed", "failed"]),
    resultSummary: z.string().optional(),
  })).optional(),
  choices: z.array(synopsisConversationChoiceSchema).optional(),
  hidden: z.boolean().optional(),
  createdAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationMessage = z.infer<typeof synopsisConversationMessageSchema>

export const synopsisConversationStreamSearchSchema = z.object({
  query: z.string().min(1),
  status: z.enum(["running", "completed", "failed"]),
  resultSummary: z.string().optional(),
})
export type SynopsisConversationStreamSearch = z.infer<typeof synopsisConversationStreamSearchSchema>

export const synopsisConversationStreamSnapshotSchema = z.object({
  sessionId: idSchema.optional(),
  status: z.enum(["idle", "running", "completed", "failed"]),
  thinking: z.string().default(""),
  content: z.string().default(""),
  searching: z.array(synopsisConversationStreamSearchSchema).default([]),
  error: z.string().optional(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationStreamSnapshot = z.infer<typeof synopsisConversationStreamSnapshotSchema>

export const synopsisConversationListResultSchema = z.object({
  session: synopsisConversationSessionSchema.optional(),
  messages: z.array(synopsisConversationMessageSchema),
})
export type SynopsisConversationListResult = z.infer<typeof synopsisConversationListResultSchema>

export const synopsisConversationStartResultSchema = z.object({
  session: synopsisConversationSessionSchema,
  messages: z.array(synopsisConversationMessageSchema),
})
export type SynopsisConversationStartResult = z.infer<typeof synopsisConversationStartResultSchema>

export const synopsisConversationSendResultSchema = z.object({
  session: synopsisConversationSessionSchema,
  messages: z.array(synopsisConversationMessageSchema),
  pendingProposals: z.array(deductionGoalProposalSchema).optional(),
  pendingStagingPromotes: z.array(synopsisStagingPromoteProposalSchema).optional(),
})
export type SynopsisConversationSendResult = z.infer<typeof synopsisConversationSendResultSchema>

export const synopsisResolveTurnInputResultSchema = z.object({
  chapterSequence: z.number().int().positive(),
  userInput: z.string(),
  source: chapterSynopsisSourceSchema,
  synopsisPath: z.string().min(1).optional(),
  deductionGoalBundle: turnDeductionGoalBundleSchema.optional(),
  reconcile: deductionGoalReconcileResultSchema.optional(),
})
export type SynopsisResolveTurnInputResult = z.infer<typeof synopsisResolveTurnInputResultSchema>

export const synopsisBeginTurnResultSchema = z.object({
  taskId: idSchema,
  chapterSequence: z.number().int().positive(),
  userInput: z.string(),
  source: chapterSynopsisSourceSchema,
  synopsisPath: z.string().min(1).optional(),
  deductionGoalBundle: turnDeductionGoalBundleSchema,
  reconcile: deductionGoalReconcileResultSchema,
})
export type SynopsisBeginTurnResult = z.infer<typeof synopsisBeginTurnResultSchema>

export const chapterSynopsisSchema = z.object({
  chapterId: z.string().min(1),
  chapterSequence: z.number().int().positive(),
  chapterPath: z.string().min(1),
  synopsisMarkdown: z.string(),
  source: chapterSynopsisSourceSchema,
  originalSynopsisPath: z.string().min(1).optional(),
  turnBootstrapInput: z.string().optional(),
  linkedAtMs: z.number().int().nonnegative(),
})
export type ChapterSynopsis = z.infer<typeof chapterSynopsisSchema>
