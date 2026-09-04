import { z } from "zod"

import {
  deductionGoalProposalSchema,
  deductionGoalReconcileResultSchema,
  goalProposalPayloadSchema,
  turnDeductionGoalBundleSchema,
} from "./deduction-goals.js"
import { idSchema } from "./ids.js"

export const chapterSynopsisSourceSchema = z.enum([
  "synopsis_file",
  "outline_file",
  "conversation",
  "turn_input",
])
export type ChapterSynopsisSource = z.infer<typeof chapterSynopsisSourceSchema>

export const synopsisConversationChoiceSchema = z.object({
  label: z.string().min(1),
  action: z.enum([
    "start_turn",
    "continue_discuss",
    "promote_staging",
    "confirm_arc_plan",
    "confirm_synopsis",
  ]),
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
  /** Digest of last Agent-written outline markdown; used to detect user hand-edits. */
  lastOutlineAgentDigest: z.string().min(1).optional(),
  turnBootstrapInput: z.string().optional(),
  synopsisConfirmedAtMs: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "completed"]),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationSession = z.infer<typeof synopsisConversationSessionSchema>

export const synopsisConversationStreamSearchSchema = z.object({
  query: z.string().min(1),
  status: z.enum(["running", "completed", "failed"]),
  resultSummary: z.string().optional(),
  asOfChapterSequence: z.number().int().positive().optional(),
  temporalRole: z.enum(["as_of", "current"]).optional(),
  /** 0=bootstrap；1..=各次 request_read 批。缺省=旧消息扁平列表。 */
  round: z.number().int().nonnegative().optional(),
})
export type SynopsisConversationStreamSearch = z.infer<typeof synopsisConversationStreamSearchSchema>

export const synopsisConversationThinkingRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  text: z.string(),
})
export type SynopsisConversationThinkingRound = z.infer<typeof synopsisConversationThinkingRoundSchema>

export const synopsisConversationStreamEditKindSchema = z.enum([
  "synopsis",
  "outline",
  "body_edits",
  "staging",
  "arc_plan",
  "presentation",
])
export type SynopsisConversationStreamEditKind = z.infer<typeof synopsisConversationStreamEditKindSchema>

export const synopsisConversationStreamEditSchema = z.object({
  path: z.string().min(1),
  kind: synopsisConversationStreamEditKindSchema,
  status: z.enum(["running", "completed", "failed"]),
  summary: z.string().max(500).optional(),
  opsApplied: z.number().int().nonnegative().optional(),
  opsAttempted: z.number().int().nonnegative().optional(),
})
export type SynopsisConversationStreamEdit = z.infer<typeof synopsisConversationStreamEditSchema>

export const synopsisConversationMessageSchema = z.object({
  messageId: idSchema,
  sessionId: idSchema,
  projectId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  reasoningContent: z.string().optional(),
  thinkingRounds: z.array(synopsisConversationThinkingRoundSchema).optional(),
  searching: z.array(synopsisConversationStreamSearchSchema).optional(),
  editing: z.array(synopsisConversationStreamEditSchema).optional(),
  choices: z.array(synopsisConversationChoiceSchema).optional(),
  hidden: z.boolean().optional(),
  createdAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationMessage = z.infer<typeof synopsisConversationMessageSchema>

export const synopsisConversationStreamUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheHitInputTokens: z.number().int().nonnegative().optional(),
  cacheMissInputTokens: z.number().int().nonnegative().optional(),
  lastRequestInputTokens: z.number().int().nonnegative().optional(),
})
export type SynopsisConversationStreamUsage = z.infer<typeof synopsisConversationStreamUsageSchema>

export const synopsisConversationBudgetAdvisorySchema = z.object({
  message: z.string().min(1),
  callsUsed: z.number().int().nonnegative(),
  softLimit: z.number().int().positive(),
})
export type SynopsisConversationBudgetAdvisory = z.infer<typeof synopsisConversationBudgetAdvisorySchema>

export const synopsisConversationStreamSnapshotSchema = z.object({
  sessionId: idSchema.optional(),
  status: z.enum(["idle", "running", "completed", "failed"]),
  thinking: z.string().default(""),
  thinkingRounds: z.array(synopsisConversationThinkingRoundSchema).default([]),
  content: z.string().default(""),
  searching: z.array(synopsisConversationStreamSearchSchema).default([]),
  editing: z.array(synopsisConversationStreamEditSchema).default([]),
  usage: synopsisConversationStreamUsageSchema.optional(),
  budgetAdvisory: synopsisConversationBudgetAdvisorySchema.optional(),
  error: z.string().optional(),
  updatedAtMs: z.number().int().nonnegative(),
})
export type SynopsisConversationStreamSnapshot = z.infer<typeof synopsisConversationStreamSnapshotSchema>

export const synopsisConversationListResultSchema = z.object({
  session: synopsisConversationSessionSchema.optional(),
  messages: z.array(synopsisConversationMessageSchema),
  usage: synopsisConversationStreamUsageSchema.optional(),
})
export type SynopsisConversationListResult = z.infer<typeof synopsisConversationListResultSchema>

export const synopsisConversationStartResultSchema = z.object({
  session: synopsisConversationSessionSchema,
  messages: z.array(synopsisConversationMessageSchema),
  usage: synopsisConversationStreamUsageSchema.optional(),
})
export type SynopsisConversationStartResult = z.infer<typeof synopsisConversationStartResultSchema>

export const synopsisConversationSendResultSchema = z.object({
  session: synopsisConversationSessionSchema,
  messages: z.array(synopsisConversationMessageSchema),
  pendingProposals: z.array(deductionGoalProposalSchema).optional(),
  pendingStagingPromotes: z.array(synopsisStagingPromoteProposalSchema).optional(),
  budgetAdvisory: synopsisConversationBudgetAdvisorySchema.optional(),
  usage: synopsisConversationStreamUsageSchema.optional(),
  /** Set when the discuss agent renamed the project/work display name. */
  workDisplayName: z.string().trim().min(1).max(200).optional(),
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
