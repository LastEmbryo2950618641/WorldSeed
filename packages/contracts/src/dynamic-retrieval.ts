import { z } from "zod"

import { idSchema } from "./ids.js"

export const workspaceCatalogRoleValues = [
  "world_rules",
  "settings",
  "references",
  "chapters",
  "presentation",
] as const

export const workspaceCatalogEntrySchema = z.object({
  relativePath: z.string().min(1),
  entryKind: z.enum(["directory", "file"]),
  role: z.enum(workspaceCatalogRoleValues),
  version: z.string().min(1),
  digest: z.string().min(1),
  size: z.number().int().nonnegative(),
})
export type WorkspaceCatalogEntry = z.infer<typeof workspaceCatalogEntrySchema>

export const workspaceCatalogSnapshotSchema = z.object({
  snapshotId: idSchema,
  projectId: idSchema,
  generatedAtMs: z.number().int().nonnegative(),
  entries: z.array(workspaceCatalogEntrySchema),
  digest: z.string().min(1),
})
export type WorkspaceCatalogSnapshot = z.infer<typeof workspaceCatalogSnapshotSchema>

export const evidenceSourceKindValues = ["workspace", "graph", "revision", "chapter"] as const

export const evidenceSchema = z.object({
  evidenceId: idSchema,
  projectId: idSchema,
  contextId: idSchema.optional(),
  sourceKind: z.enum(evidenceSourceKindValues),
  ownerId: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().min(1),
  locator: z.string().min(1),
  contentRef: z.string().min(1),
  readReason: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
})
export type Evidence = z.infer<typeof evidenceSchema>
