import { z } from "zod"

import { projectSettingsSchema } from "./project-settings.js"

import { idSchema } from "./ids.js"

export const deepSeekReasoningEffortSchema = z.enum(["low", "high", "max"])

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
  model: z.object({
    baseUrl: z.url(),
    model: z.string().trim().min(1).max(200),
    credentialRef: z.string().trim().min(1).max(300),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    thinkingModeEnabled: z.boolean().default(true),
    reasoningEffort: deepSeekReasoningEffortSchema.default("high"),
    jsonModeEnabled: z.boolean().default(false),
  }).optional(),
  maxModelCalls: z.number().int().positive().optional(),
})
export type TurnStartPayload = z.infer<typeof turnStartPayloadSchema>

export const taskPayloadSchema = z.object({
  taskId: idSchema,
})
export type TaskPayload = z.infer<typeof taskPayloadSchema>

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
  thinkingModeEnabled: z.boolean().default(true),
  reasoningEffort: deepSeekReasoningEffortSchema.default("high"),
  jsonModeEnabled: z.boolean().default(false),
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
  anchorIds: z.array(idSchema).min(1).max(GRAPH_NEIGHBORHOOD_MAX_REQUEST_ANCHORS),
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
  "turn.status": taskPayloadSchema,
} as const
