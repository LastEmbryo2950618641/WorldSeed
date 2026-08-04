import { z } from "zod"

import { idSchema } from "./ids.js"

export const readRequestSchema = z.object({
  requestId: idSchema,
  reason: z.string().min(1),
  expectedEvidence: z.string().min(1),
  query: z.object({
    exactKeys: z.array(z.string().min(1)),
    semanticTexts: z.array(z.string().min(1)),
    anchorIds: z.array(idSchema),
    directions: z.array(z.enum(["out", "in", "both"])),
    maxCandidates: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
    sourceKinds: z.array(z.enum(["graph", "revision", "source", "rule", "reference"])),
  }),
})
export type ReadRequest = z.infer<typeof readRequestSchema>

export const unresolvedDependencySchema = z.object({
  dependencyId: idSchema,
  description: z.string().min(1),
  requiredFor: z.string().min(1),
  disposition: z.enum(["read", "narrow", "defer", "retain_uncertainty"]),
})
export type UnresolvedDependency = z.infer<typeof unresolvedDependencySchema>
