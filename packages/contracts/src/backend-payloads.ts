import { z } from "zod"

import { idSchema } from "./ids.js"

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

export const turnStartPayloadSchema = z.object({
  projectId: idSchema,
  workspaceRootRef: z.string().min(1),
  userInput: z.string().trim().min(1),
  chapterSequence: z.number().int().positive(),
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

export const graphNeighborhoodPayloadSchema = z.object({
  projectId: idSchema,
  workspaceRootRef: z.string().min(1),
  anchorIds: z.array(idSchema).min(1).max(12),
  direction: z.enum(["out", "in", "both"]).default("both"),
  maxDepth: z.number().int().min(1).max(4).default(2),
  maxNodes: z.number().int().min(1).max(96).default(48),
  maxLinks: z.number().int().min(1).max(192).default(96),
})
export type GraphNeighborhoodPayload = z.infer<typeof graphNeighborhoodPayloadSchema>

export const backendPayloadSchemas = {
  "project.create": projectCreatePayloadSchema,
  "project.open": projectWorkspacePayloadSchema,
  "project.validate": projectWorkspacePayloadSchema,
  "workspace.list": projectWorkspacePayloadSchema,
  "workspace.read": workspaceReadPayloadSchema,
  "workspace.save": workspaceSavePayloadSchema,
  "graph.neighborhood": graphNeighborhoodPayloadSchema,
  "turn.start": turnStartPayloadSchema,
  "turn.status": taskPayloadSchema,
} as const
