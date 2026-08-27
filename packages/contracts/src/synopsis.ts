import { z } from "zod"

import {
  deductionGoalProposalSchema,
  deductionGoalReconcileResultSchema,
  turnDeductionGoalBundleSchema,
} from "./deduction-goals.js"
import { idSchema } from "./ids.js"

export const chapterSynopsisSourceSchema = z.enum(["synopsis_file", "conversation", "turn_input"])
export type ChapterSynopsisSource = z.infer<typeof chapterSynopsisSourceSchema>

export const synopsisConversationChoiceSchema = z.object({
  label: z.string().min(1),
  action: z.enum(["start_turn", "continue_discuss"]),
})
export type SynopsisConversationChoice = z.infer<typeof synopsisConversationChoiceSchema>

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
  choices: z.array(synopsisConversationChoiceSchema).optional(),
  createdAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationMessage = z.infer<typeof synopsisConversationMessageSchema>

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
