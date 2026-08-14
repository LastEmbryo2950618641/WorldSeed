import { z } from "zod"

import { idSchema } from "./ids.js"
import { graphObjectIdSchema, sourceObjectIdSchema } from "./persistent-id.js"

const graphQueryAnchorSchema = z.union([
  graphObjectIdSchema,
  z.string().regex(/^local:[a-zA-Z0-9_.-]+$/u),
])

export const verificationProbePurposeSchema = z.string().trim().min(1).max(200)

export const verificationProbeDescriptorSchema = z.object({
  purpose: verificationProbePurposeSchema,
  sceneBindingIndexes: z.array(z.number().int().nonnegative()),
  mutationSpacetimeSettlementIndexes: z.array(z.number().int().nonnegative()),
})
export type VerificationProbeDescriptor = z.infer<typeof verificationProbeDescriptorSchema>

export const readRequestSchema = z.object({
  requestId: idSchema,
  reason: z.string().min(1),
  expectedEvidence: z.string().min(1),
  query: z.object({
    exactKeys: z.array(z.string().min(1)),
    semanticTexts: z.array(z.string().min(1)),
    anchorIds: z.array(graphQueryAnchorSchema),
    directions: z.array(z.enum(["out", "in", "both"])),
    maxCandidates: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
    sourceKinds: z.array(z.enum(["graph", "revision", "source", "rule", "reference"])),
    sourceIds: z.array(sourceObjectIdSchema).optional(),
    sourceBoundary: z.enum(["start", "end"]).optional(),
  }),
  verificationProbe: verificationProbeDescriptorSchema.optional(),
})
export type ReadRequest = z.infer<typeof readRequestSchema>

export const unresolvedDependencySchema = z.object({
  dependencyId: idSchema,
  description: z.string().min(1),
  requiredFor: z.string().min(1),
  disposition: z.enum(["read", "narrow", "defer", "retain_uncertainty"]),
})
export type UnresolvedDependency = z.infer<typeof unresolvedDependencySchema>
