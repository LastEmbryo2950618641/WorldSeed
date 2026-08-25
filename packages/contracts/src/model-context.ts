import { z } from "zod"

import { aiPhaseSchema } from "./common.js"
import { idSchema } from "./ids.js"

export const modelContextRoleValues = ["system", "user", "assistant"] as const
export const modelContextRoleSchema = z.enum(modelContextRoleValues)
export type ModelContextRole = z.infer<typeof modelContextRoleSchema>

export const modelContextMessageKindValues = [
  "system_rules",
  "phase_instruction",
  "phase_protocol",
  "phase_request",
  "phase_response",
  "canonical_chapter",
  "chapter_revision",
] as const
export const modelContextMessageKindSchema = z.enum(modelContextMessageKindValues)
export type ModelContextMessageKind = z.infer<typeof modelContextMessageKindSchema>

const modelContextContentFields = {
  content: z.string().min(1).optional(),
  contentRef: z.string().min(1).optional(),
}

function requireSingleContentSource(
  value: { content?: string | undefined; contentRef?: string | undefined },
  context: z.RefinementCtx,
): void {
  if ((value.content === undefined) === (value.contentRef === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Exactly one of content or contentRef is required",
    })
  }
}

export const modelContextMessageDraftSchema = z.object({
  role: modelContextRoleSchema,
  kind: modelContextMessageKindSchema,
  taskId: idSchema.optional(),
  turnId: idSchema.optional(),
  phase: aiPhaseSchema.optional(),
  ...modelContextContentFields,
}).strict().superRefine(requireSingleContentSource)
export type ModelContextMessageDraft = z.infer<typeof modelContextMessageDraftSchema>

export const modelContextMessageSchema = z.object({
  messageId: idSchema,
  chainId: idSchema,
  projectId: idSchema,
  sequence: z.number().int().nonnegative(),
  role: modelContextRoleSchema,
  kind: modelContextMessageKindSchema,
  taskId: idSchema.optional(),
  turnId: idSchema.optional(),
  phase: aiPhaseSchema.optional(),
  originPhaseRunId: idSchema.optional(),
  originIndex: z.number().int().nonnegative().optional(),
  ...modelContextContentFields,
  contentDigest: z.string().min(1),
  tokenEstimate: z.number().int().nonnegative(),
  createdAtMs: z.number().int().nonnegative(),
}).strict().superRefine(requireSingleContentSource).superRefine((value, context) => {
  if ((value.originPhaseRunId === undefined) !== (value.originIndex === undefined)) {
    context.addIssue({ code: "custom", message: "originPhaseRunId and originIndex must be provided together" })
  }
})
export type ModelContextMessage = z.infer<typeof modelContextMessageSchema>

export const visibleModelContextMessageSchema = z.object({
  messageId: idSchema,
  sequence: z.number().int().nonnegative(),
  role: modelContextRoleSchema,
  kind: modelContextMessageKindSchema,
  taskId: idSchema.optional(),
  turnId: idSchema.optional(),
  phase: aiPhaseSchema.optional(),
  content: z.string().min(1),
}).strict()
export type VisibleModelContextMessage = z.infer<typeof visibleModelContextMessageSchema>
