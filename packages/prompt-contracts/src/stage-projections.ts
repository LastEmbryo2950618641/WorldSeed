import { z } from "zod"

import {
  continuityAdviceSchema,
  graphGovernanceReviewArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  graphStructurePlanArtifactSchema,
  temporalClaimSchema,
} from "./phase-schemas/artifacts.js"

const digestSchema = z.string().min(1)
const referenceSchema = z.string().min(1)
const indexSchema = z.number().int().nonnegative()

const projectionBaseShape = {
  version: z.literal(1),
  sourceArtifactDigests: z.record(z.string().min(1), digestSchema),
  pendingScope: z.object({
    scopeId: z.string().min(1),
    candidateDigest: digestSchema,
  }),
  projectionDigest: digestSchema,
  unresolvedIssues: z.array(z.string().min(1)),
}

export const graphGovernanceReviewProjectionSchema = z.object({
  kind: z.literal("graph_governance_review"),
  ...projectionBaseShape,
  proposals: graphStructurePlanArtifactSchema.shape.proposals,
  decisionRecords: graphStructurePlanArtifactSchema.shape.decisionRecords,
  sceneSpacetimeBindings: graphSpacetimeSettlementArtifactSchema.shape.sceneSpacetimeBindings,
  proposalSettlements: graphSpacetimeSettlementArtifactSchema.shape.proposalSettlements,
  retrievalProjections: z.array(z.unknown()),
  sourceSettlements: z.array(z.unknown()),
  affectedFrontierRefs: z.array(referenceSchema),
  archiveOutletRefs: z.array(referenceSchema),
  temporalClaims: z.array(temporalClaimSchema),
  temporalClaimSettlements: graphSpacetimeSettlementArtifactSchema.shape.temporalClaimSettlements,
  verificationProbeExecutions: z.array(z.unknown()),
  mechanicalChecks: z.object({
    capacitySatisfied: z.boolean(),
    sourceReturnComplete: z.boolean(),
    referenceIntegrity: z.boolean(),
  }),
})

const coverageEntrySchema = z.object({
  sourceUnitIndex: indexSchema.optional(),
  sceneIndexes: z.array(indexSchema).default([]),
  proposalRefs: z.array(referenceSchema).default([]),
  graphRefs: z.array(referenceSchema).default([]),
})

const priorFrontierStateSchema = z.object({
  frontierAnchorRef: referenceSchema,
  lastSceneAnchorRefs: z.array(referenceSchema),
  lastTimeAnchorRefs: z.array(referenceSchema),
  lastLocationAnchorRefs: z.array(referenceSchema),
  correspondenceRefs: z.array(referenceSchema),
})

export const settlementReviewProjectionSchema = z.object({
  kind: z.literal("settlement_review"),
  ...projectionBaseShape,
  sourceCoverage: z.array(coverageEntrySchema),
  sceneCoverage: z.array(coverageEntrySchema),
  proposalCoverage: z.array(coverageEntrySchema),
  retrievalCoverage: z.array(coverageEntrySchema),
  uncoveredSourceUnitIndexes: z.array(indexSchema),
  mechanicalChecks: z.object({
    sourceCoverageComplete: z.boolean(),
    spacetimeCoverageComplete: z.boolean(),
    retrievalCoverageComplete: z.boolean(),
  }),
})

export const frontierSettlementProjectionSchema = z.object({
  kind: z.literal("frontier_settlement"),
  ...projectionBaseShape,
  affectedFrontierRefs: z.array(referenceSchema),
  approvedSceneBindings: graphSpacetimeSettlementArtifactSchema.shape.sceneSpacetimeBindings,
  archiveOutletRefs: z.array(referenceSchema),
  correspondenceRefs: z.array(referenceSchema),
  priorFrontierStates: z.array(priorFrontierStateSchema),
})

export const commitReviewProjectionSchema = z.object({
  kind: z.literal("commit_review"),
  ...projectionBaseShape,
  stageChain: z.array(z.object({
    phase: z.string().min(1),
    artifactDigest: digestSchema,
    outcome: z.string().min(1),
  })),
  governanceConclusion: z.object({
    recommendation: graphGovernanceReviewArtifactSchema.shape.recommendation,
    issueCount: indexSchema,
  }),
  settlementConclusion: z.object({
    complete: z.boolean(),
    uncoveredSourceUnitIndexes: z.array(indexSchema),
  }),
  frontierConclusion: z.object({ frontierCount: indexSchema }),
  continuityAdvice: z.array(continuityAdviceSchema),
  pendingWriteSummary: z.object({
    mutationCount: indexSchema,
    sourceSettlementCount: indexSchema,
    frontierCount: indexSchema,
  }),
  mechanicalInvariants: z.object({
    referenceIntegrity: z.boolean(),
    digestAligned: z.boolean(),
    finalizationReady: z.boolean(),
  }),
  risks: z.array(z.string().min(1)),
})

export const stageProjectionSchema = z.discriminatedUnion("kind", [
  graphGovernanceReviewProjectionSchema,
  settlementReviewProjectionSchema,
  frontierSettlementProjectionSchema,
  commitReviewProjectionSchema,
])

export type StageProjection = z.infer<typeof stageProjectionSchema>
export type GraphGovernanceReviewProjection = z.infer<typeof graphGovernanceReviewProjectionSchema>
export type SettlementReviewProjection = z.infer<typeof settlementReviewProjectionSchema>
export type FrontierSettlementProjection = z.infer<typeof frontierSettlementProjectionSchema>
export type CommitReviewProjection = z.infer<typeof commitReviewProjectionSchema>
