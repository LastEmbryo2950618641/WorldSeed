import { z } from "zod"

import { projectSettingsSchema } from "./project-settings.js"

import { idSchema } from "./ids.js"
import { graphObjectIdSchema } from "./persistent-id.js"
import { resettableRuntimeMetricIdSchema } from "./runtime-metrics.js"

export const modelApiProtocolSchema = z.enum(["openai_chat_completions", "openai_responses"])
export const modelReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
export const deepSeekReasoningEffortSchema = modelReasoningEffortSchema
export const modelServiceTierSchema = z.enum(["auto", "default", "flex", "priority", "fast"])

export const modelSelectionSchema = z.object({
  baseUrl: z.url(),
  model: z.string().trim().min(1).max(200),
  credentialRef: z.string().trim().min(1).max(300),
  apiProtocol: modelApiProtocolSchema.default("openai_chat_completions"),
  contextWindowTokens: z.number().int().positive().max(2_000_000).default(1_000_000),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  thinkingModeEnabled: z.boolean().default(true),
  reasoningEffort: deepSeekReasoningEffortSchema.default("high"),
  jsonModeEnabled: z.boolean().default(false),
  disableResponseStorage: z.boolean().default(true),
  serviceTier: modelServiceTierSchema.default("auto"),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const projectCreatePayloadSchema = z.object({
  projectId: idSchema,
  displayName: z.string().trim().min(1).max(200),
  workspaceRootRef: z.string().min(1),
})
export type ProjectCreatePayload = z.infer<typeof projectCreatePayloadSchema>

export const projectWorkspacePayloadSchema = z.object({
  workspaceRootRef: z.string().min(1),
})
export type ProjectWorkspacePayload = z.infer<typeof projectWorkspacePayloadSchema>

export const projectSettingsReadPayloadSchema = projectWorkspacePayloadSchema.extend({
  projectId: idSchema,
})
export const projectSettingsSavePayloadSchema = projectSettingsReadPayloadSchema.extend({
  settings: projectSettingsSchema,
})
export type ProjectSettingsReadPayload = z.infer<typeof projectSettingsReadPayloadSchema>
export type ProjectSettingsSavePayload = z.infer<typeof projectSettingsSavePayloadSchema>
export const turnRecoverableTasksPayloadSchema = projectSettingsReadPayloadSchema
export type TurnRecoverableTasksPayload = z.infer<typeof turnRecoverableTasksPayloadSchema>

export const turnStartPayloadSchema = z.object({
  projectId: idSchema,
  workspaceRootRef: z.string().min(1),
  userInput: z.string().trim().min(1),
  chapterSequence: z.number().int().positive(),
  presentation: z.object({
    descriptionRulePath: z.string().trim().min(1).optional(),
    proseStyleRulePath: z.string().trim().min(1).optional(),
    minimumWordCount: z.number().int().positive().default(2000),
    maximumWordCount: z.number().int().positive().default(3000),
  }).refine(
    (value) => value.minimumWordCount <= value.maximumWordCount,
    { message: "Minimum word count must not exceed maximum word count" },
  ).optional(),
  model: modelSelectionSchema.optional(),
  maxModelCalls: z.number().int().positive().optional(),
  allowWorkspaceChapterReads: z.boolean().default(true),
})
export type TurnStartPayload = z.infer<typeof turnStartPayloadSchema>

const worldTaskPayloadBaseSchema = projectSettingsReadPayloadSchema.extend({
  model: modelSelectionSchema.optional(),
  maxModelCalls: z.number().int().positive().optional(),
  deadlineMs: z.number().int().positive().optional(),
  maxRetrievalRounds: z.number().int().positive().optional(),
})

export const worldQueryPayloadSchema = worldTaskPayloadBaseSchema.extend({
  question: z.string().trim().min(1),
  allowWorkspaceChapterReads: z.boolean().default(false),
})
export type WorldQueryPayload = z.infer<typeof worldQueryPayloadSchema>

export const worldEvolvePayloadSchema = worldTaskPayloadBaseSchema.extend({
  instruction: z.string().trim().min(1).default("扫描已提交世界前沿，选择能够自然推进的局部自主演化；不发布章节正文。"),
})
export type WorldEvolvePayload = z.infer<typeof worldEvolvePayloadSchema>

export const taskPayloadSchema = z.object({
  taskId: idSchema,
})
export type TaskPayload = z.infer<typeof taskPayloadSchema>

export const resettableMetricSchema = resettableRuntimeMetricIdSchema
export type ResettableMetric = z.infer<typeof resettableRuntimeMetricIdSchema>

export const turnMetricsResetPayloadSchema = taskPayloadSchema.extend({
  metricIds: z.array(resettableRuntimeMetricIdSchema).min(1).max(4).refine(
    (metricIds) => new Set(metricIds).size === metricIds.length,
    { message: "Runtime metric IDs must be unique" },
  ),
})
export type TurnMetricsResetPayload = z.infer<typeof turnMetricsResetPayloadSchema>

export const turnResumePayloadSchema = taskPayloadSchema.extend({
  mode: z.enum(["continue", "retry_phase"]).default("continue"),
  resetMetricIds: z.array(resettableMetricSchema).default([]),
  model: turnStartPayloadSchema.shape.model,
  maxModelCalls: z.number().int().positive().optional(),
  deadlineMs: z.number().int().positive().optional(),
  maxRetrievalRounds: z.number().int().positive().optional(),
})
export type TurnResumePayload = z.infer<typeof turnResumePayloadSchema>

const historyOperationSchema = projectSettingsReadPayloadSchema.extend({
  operationId: idSchema,
})

export const historyListPayloadSchema = projectSettingsReadPayloadSchema
export const historyBranchesPayloadSchema = projectSettingsReadPayloadSchema
export const historySaveManualPayloadSchema = historyOperationSchema.extend({
  name: z.string().trim().min(1).max(200),
  note: z.string().max(4_000).optional(),
})
export const historyEntryOperationPayloadSchema = historyOperationSchema.extend({
  entryId: idSchema,
})
export const historyReturnPreviousRoundPayloadSchema = historyOperationSchema
export const historyRetentionPreviewPayloadSchema = projectSettingsReadPayloadSchema.extend({
  retentionLimit: z.number().int().positive().max(100_000).nullable(),
})
export type HistorySaveManualPayload = z.infer<typeof historySaveManualPayloadSchema>
export type HistoryEntryOperationPayload = z.infer<typeof historyEntryOperationPayloadSchema>
export type HistoryReturnPreviousRoundPayload = z.infer<typeof historyReturnPreviousRoundPayloadSchema>
export type HistoryRetentionPreviewPayload = z.infer<typeof historyRetentionPreviewPayloadSchema>

export const workspaceReadPayloadSchema = z.object({
  projectId: idSchema,
  workspaceRootRef: z.string().min(1),
  relativePath: z.string().min(1),
})
export type WorkspaceReadPayload = z.infer<typeof workspaceReadPayloadSchema>

export const workspaceSavePayloadSchema = workspaceReadPayloadSchema.extend({ content: z.string() })
export type WorkspaceSavePayload = z.infer<typeof workspaceSavePayloadSchema>

export const modelListPayloadSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().trim().min(1).max(4096),
})
export type ModelListPayload = z.infer<typeof modelListPayloadSchema>

export const modelCatalogRequestSchema = z.object({
  baseUrl: z.url(),
  credentialRef: z.string().trim().min(1).max(300),
  apiKey: z.string().max(4096).optional(),
})
export type ModelCatalogRequest = z.infer<typeof modelCatalogRequestSchema>

export const modelDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  ownedBy: z.string().trim().min(1).optional(),
})
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>

export const modelListResultSchema = z.object({
  models: z.array(modelDescriptorSchema),
})
export type ModelListResult = z.infer<typeof modelListResultSchema>

export const modelProfileIdSchema = z.string().trim().min(1).max(200)
export const modelProfileSchema = z.object({
  id: modelProfileIdSchema,
  name: z.string().trim().min(1).max(200),
  baseUrl: z.url(),
  model: z.string().trim().min(1).max(200),
  credentialRef: z.string().trim().min(1).max(300),
  apiProtocol: modelApiProtocolSchema.default("openai_chat_completions"),
  contextWindowTokens: z.number().int().positive().max(2_000_000).default(1_000_000),
  thinkingModeEnabled: z.boolean().default(true),
  reasoningEffort: deepSeekReasoningEffortSchema.default("high"),
  jsonModeEnabled: z.boolean().default(false),
  disableResponseStorage: z.boolean().default(true),
  serviceTier: modelServiceTierSchema.default("auto"),
})
export type ModelProfile = z.infer<typeof modelProfileSchema>

export const modelProfileDraftSchema = modelProfileSchema.extend({
  apiKey: z.string().max(4096),
  hasApiKey: z.boolean(),
})
export const modelProfilesDraftSavePayloadSchema = z.object({
  profiles: z.array(modelProfileDraftSchema).min(1).max(50),
  activeProfileId: modelProfileIdSchema,
}).superRefine((value, context) => {
  if (!value.profiles.some((profile) => profile.id === value.activeProfileId)) {
    context.addIssue({ code: "custom", path: ["activeProfileId"], message: "Active model profile does not exist" })
  }
})
export type ModelProfileDraft = z.infer<typeof modelProfileDraftSchema>
export type ModelProfilesDraftSavePayload = z.infer<typeof modelProfilesDraftSavePayloadSchema>

export const modelProfilesReadPayloadSchema = z.object({})
export const modelProfilesSavePayloadSchema = z.object({
  profiles: z.array(modelProfileSchema).min(1).max(50),
  activeProfileId: modelProfileIdSchema,
}).superRefine((value, context) => {
  if (!value.profiles.some((profile) => profile.id === value.activeProfileId)) {
    context.addIssue({ code: "custom", path: ["activeProfileId"], message: "Active model profile does not exist" })
  }
})
export type ModelProfilesSavePayload = z.infer<typeof modelProfilesSavePayloadSchema>
export type ModelProfilesReadResult = Readonly<{
  profiles: readonly ModelProfile[]
  activeProfileId: string
}>

export const GRAPH_NEIGHBORHOOD_MAX_ANCHORS = 64
export const GRAPH_NEIGHBORHOOD_MAX_REQUEST_ANCHORS = 4_000

export const graphNeighborhoodPayloadSchema = z.object({
  projectId: idSchema,
  workspaceRootRef: z.string().min(1),
  anchorIds: z.array(graphObjectIdSchema).min(1).max(GRAPH_NEIGHBORHOOD_MAX_REQUEST_ANCHORS),
  anchorOffset: z.number().int().nonnegative().default(0),
  direction: z.enum(["out", "in", "both"]).default("both"),
  maxDepth: z.number().int().min(1).max(8).default(2),
  maxNodes: z.number().int().min(1).max(2_000).default(48),
  maxLinks: z.number().int().min(1).max(4_000).default(96),
})
export type GraphNeighborhoodPayload = z.infer<typeof graphNeighborhoodPayloadSchema>

export const backendPayloadSchemas = {
  "project.create": projectCreatePayloadSchema,
  "project.open": projectWorkspacePayloadSchema,
  "project.validate": projectWorkspacePayloadSchema,
  "project.settings.read": projectSettingsReadPayloadSchema,
  "project.settings.save": projectSettingsSavePayloadSchema,
  "workspace.list": projectWorkspacePayloadSchema,
  "workspace.read": workspaceReadPayloadSchema,
  "workspace.save": workspaceSavePayloadSchema,
  "model.list": modelListPayloadSchema,
  "model.profiles.read": modelProfilesReadPayloadSchema,
  "model.profiles.save": modelProfilesSavePayloadSchema,
  "graph.neighborhood": graphNeighborhoodPayloadSchema,
  "turn.start": turnStartPayloadSchema,
  "turn.resume": turnResumePayloadSchema,
  "turn.recoverable.list": turnRecoverableTasksPayloadSchema,
  "turn.pause": taskPayloadSchema,
  "turn.cancel": taskPayloadSchema,
  "turn.status": taskPayloadSchema,
  "turn.metrics.reset": turnMetricsResetPayloadSchema,
  "world.query": worldQueryPayloadSchema,
  "world.evolve": worldEvolvePayloadSchema,
  "history.list": historyListPayloadSchema,
  "history.branches": historyBranchesPayloadSchema,
  "history.saveManual": historySaveManualPayloadSchema,
  "history.returnPreviousRound": historyReturnPreviousRoundPayloadSchema,
  "history.continueFrom": historyEntryOperationPayloadSchema,
  "history.restore": historyEntryOperationPayloadSchema,
  "history.retention.preview": historyRetentionPreviewPayloadSchema,
} as const
