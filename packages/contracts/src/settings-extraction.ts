import { z } from "zod"

import { idSchema } from "./ids.js"

export const settingsProposalKindSchema = z.enum(["create", "update", "merge"])
export type SettingsProposalKind = z.infer<typeof settingsProposalKindSchema>

export const settingsProposalStatusSchema = z.enum(["pending", "approved", "rejected"])
export type SettingsProposalStatus = z.infer<typeof settingsProposalStatusSchema>

const settingsRelativePathSchema = z.string().regex(/^设定集\/[^/][^\n]*\.md$/u)

export const settingsProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    relativePath: settingsRelativePathSchema,
    markdown: z.string().min(1),
    readmeEntry: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal("update"),
    relativePath: settingsRelativePathSchema,
    markdown: z.string().min(1),
  }),
  z.object({
    kind: z.literal("merge"),
    targetPath: settingsRelativePathSchema,
    markdown: z.string().min(1),
    mergedFromPaths: z.array(settingsRelativePathSchema).min(1),
  }),
])
export type SettingsProposalPayload = z.infer<typeof settingsProposalPayloadSchema>

export const settingsExtractionProposalInputSchema = z.object({
  payload: settingsProposalPayloadSchema,
  reason: z.string().max(1_000).optional(),
  conflictNotes: z.string().max(2_000).optional(),
})
export type SettingsExtractionProposalInput = z.infer<typeof settingsExtractionProposalInputSchema>

export const settingsExtractionProposalSchema = z.object({
  proposalId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  kind: settingsProposalKindSchema,
  payload: settingsProposalPayloadSchema,
  status: settingsProposalStatusSchema,
  phaseRunId: idSchema.optional(),
  reason: z.string().max(1_000).optional(),
  conflictNotes: z.string().max(2_000).optional(),
  createdAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().optional(),
})
export type SettingsExtractionProposal = z.infer<typeof settingsExtractionProposalSchema>

export const settingsExtractionSnapshotSchema = z.object({
  proposals: z.array(settingsExtractionProposalSchema),
})
export type SettingsExtractionSnapshot = z.infer<typeof settingsExtractionSnapshotSchema>
