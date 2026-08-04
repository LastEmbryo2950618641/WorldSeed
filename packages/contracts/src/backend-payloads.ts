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

export const backendPayloadSchemas = {
  "project.create": projectCreatePayloadSchema,
  "project.open": projectWorkspacePayloadSchema,
  "project.validate": projectWorkspacePayloadSchema,
  "turn.start": turnStartPayloadSchema,
  "turn.status": taskPayloadSchema,
} as const
