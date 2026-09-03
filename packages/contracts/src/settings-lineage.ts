import { z } from "zod"

import { idSchema } from "./ids.js"

export const settingsLineageSourceKindValues = [
  "extraction_approve",
  "staging_promote",
  "workspace_save",
  "migration_seed",
  "history_restore",
] as const
export const settingsLineageSourceKindSchema = z.enum(settingsLineageSourceKindValues)
export type SettingsLineageSourceKind = z.infer<typeof settingsLineageSourceKindSchema>

export const settingsLineageOpValues = ["upsert", "delete"] as const
export const settingsLineageOpSchema = z.enum(settingsLineageOpValues)
export type SettingsLineageOp = z.infer<typeof settingsLineageOpSchema>

export const settingsLineageEntrySchema = z.object({
  commitId: idSchema,
  commitSeq: z.number().int().positive(),
  relativePath: z.string().min(1),
  op: settingsLineageOpSchema,
  blobDigest: z.string().min(1).optional(),
  causingChapterId: idSchema.optional(),
  causingChapterSequence: z.number().int().positive().optional(),
  storyTime: z.string().min(1).max(200).optional(),
  sourceKind: settingsLineageSourceKindSchema,
  sourceRef: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(500).optional(),
  createdAtMs: z.number().int().nonnegative(),
})
export type SettingsLineageEntry = z.infer<typeof settingsLineageEntrySchema>

export const settingsLineageListResultSchema = z.object({
  entries: z.array(settingsLineageEntrySchema),
})
export type SettingsLineageListResult = z.infer<typeof settingsLineageListResultSchema>

export const settingsLineageCommitResultSchema = z.object({
  entry: settingsLineageEntrySchema,
  markdown: z.string(),
  previousMarkdown: z.string().optional(),
})
export type SettingsLineageCommitResult = z.infer<typeof settingsLineageCommitResultSchema>

export const settingsLineageHeadMetaSchema = z.object({
  relativePath: z.string().min(1),
  commitId: idSchema.optional(),
  commitSeq: z.number().int().positive().optional(),
  blobDigest: z.string().min(1).optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
  lastCause: z.object({
    causingChapterSequence: z.number().int().positive().optional(),
    sourceKind: settingsLineageSourceKindSchema,
    summary: z.string().min(1).max(500).optional(),
  }).optional(),
})
export type SettingsLineageHeadMeta = z.infer<typeof settingsLineageHeadMetaSchema>

export const settingsLineagePathsResultSchema = z.object({
  paths: z.array(z.string().min(1)),
})
export type SettingsLineagePathsResult = z.infer<typeof settingsLineagePathsResultSchema>

export const settingsLineageReadAsOfResultSchema = z.object({
  relativePath: z.string().min(1),
  chapterSequence: z.number().int().positive(),
  commitId: idSchema,
  commitSeq: z.number().int().positive(),
  markdown: z.string(),
})
export type SettingsLineageReadAsOfResult = z.infer<typeof settingsLineageReadAsOfResultSchema>

export const settingsLineageRestoreAsCurrentResultSchema = z.object({
  entry: settingsLineageEntrySchema,
})
export type SettingsLineageRestoreAsCurrentResult = z.infer<typeof settingsLineageRestoreAsCurrentResultSchema>

export const settingsLineageAnnotateResultSchema = z.object({
  entry: settingsLineageEntrySchema,
})
export type SettingsLineageAnnotateResult = z.infer<typeof settingsLineageAnnotateResultSchema>
