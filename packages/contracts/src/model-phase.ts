import { z } from "zod"

const modelReadEvidenceReferenceSchema = z.string().regex(/^read-[1-9][0-9]*$/u)
const modelGraphReferenceSchema = z.string().regex(/^(?:node|link)-[1-9][0-9]*$/u)

const modelReadQuerySchema = z.object({
  exactKeys: z.array(z.string().min(1)).optional(),
  semanticTexts: z.array(z.string().min(1)).optional(),
  anchorIds: z.array(modelGraphReferenceSchema).optional(),
  directions: z.array(z.enum(["out", "in", "both"])).optional(),
  maxCandidates: z.number().int().positive().optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  sourceKinds: z.array(z.enum(["graph", "revision", "source", "rule", "reference"])).optional(),
}).strict()

export const modelReadRequestSchema = z.object({
  reason: z.string().min(1),
  expectedEvidence: z.string().min(1),
  query: modelReadQuerySchema.optional(),
}).strict()

export const modelDependencySchema = z.object({
  description: z.string().min(1),
  requiredFor: z.string().min(1),
  disposition: z.enum(["read", "narrow", "defer", "retain_uncertainty"]),
}).strict()

export const modelPhaseResultSchema = z.object({
  outcome: z.enum(["continue", "request_read", "blocked", "approve", "revise", "reject", "retire"]),
  artifact: z.unknown().optional(),
  requestedReads: z.array(modelReadRequestSchema).default([]),
  citedReadIds: z.array(modelReadEvidenceReferenceSchema).default([]),
  unresolvedDependencies: z.array(modelDependencySchema).default([]),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
}).strict()

export type ModelPhaseResult = z.infer<typeof modelPhaseResultSchema>

export function modelPhaseResultJsonSchema(): unknown {
  return z.toJSONSchema(modelPhaseResultSchema)
}
