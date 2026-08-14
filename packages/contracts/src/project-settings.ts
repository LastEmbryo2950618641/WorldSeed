import { z } from "zod"

const positiveInteger = z.number().int().positive()

const retrievalSettingsSchema = z.object({
  maxRequestsPerRound: positiveInteger.max(50),
  maxCandidates: positiveInteger.max(200),
  maxDepth: positiveInteger.max(8),
  maxEvidenceTokens: positiveInteger.max(200_000),
})

const graphSettingsSchema = z.object({
  maxDirectOutDegree: positiveInteger.max(64),
  maxDirectInDegree: positiveInteger.max(64),
  mergeWarningThreshold: positiveInteger.max(64),
  preferredExpansionDepth: z.number().int().nonnegative().max(8),
  maxExpansionDepth: positiveInteger.max(8),
  maxVisitedNodes: positiveInteger.max(2_000),
  maxVisitedLinks: positiveInteger.max(4_000),
  maxNeighborhoodAnchors: positiveInteger.max(64).default(32),
  layoutMode: z.literal("layered_collision_avoidance"),
})

const historySettingsSchema = z.object({
  retentionLimit: positiveInteger.max(100_000).nullable(),
})

export const projectSettingsSchema = z.object({
  version: z.literal(2),
  execution: z.object({
    maxModelCalls: positiveInteger.max(400),
    contextCompactionThresholdRatio: z.number().min(0.5).max(0.99),
    contextCompressionTargetRatio: z.number().min(0.1).max(0.9).default(0.5),
    outputTokenLimitMode: z.literal("model"),
    maxWallTimeMs: positiveInteger.max(7_200_000),
    maxModelRequestTimeMs: positiveInteger.max(3_600_000).default(3_600_000),
    maxRetrievalRounds: positiveInteger.max(10),
  }),
  retrieval: retrievalSettingsSchema,
  graph: graphSettingsSchema,
  history: historySettingsSchema.default({ retentionLimit: null }),
}).superRefine(validateGraphSettings)

export type ProjectSettings = z.infer<typeof projectSettingsSchema>

function validateGraphSettings(settings: { graph: z.infer<typeof graphSettingsSchema> }, context: z.RefinementCtx): void {
  if (settings.graph.mergeWarningThreshold > Math.min(settings.graph.maxDirectOutDegree, settings.graph.maxDirectInDegree)) {
    context.addIssue({
      code: "custom",
      path: ["graph", "mergeWarningThreshold"],
      message: "Merge warning threshold cannot exceed either direct degree limit",
    })
  }
  if (settings.graph.preferredExpansionDepth > settings.graph.maxExpansionDepth) {
    context.addIssue({
      code: "custom",
      path: ["graph", "preferredExpansionDepth"],
      message: "Preferred expansion depth cannot exceed maximum expansion depth",
    })
  }
}
