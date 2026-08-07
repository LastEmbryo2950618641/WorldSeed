import { z } from "zod"

import {
  aiPhaseSchema,
  type AIPhase,
} from "@worldseed/contracts"

const continuityStatusSchema = z.enum(["pass", "revise", "unknown"])
const referenceSchema = z.string().min(1)
const indexSchema = z.number().int().nonnegative()
const localReferenceSchema = z.string().regex(/^local:[a-zA-Z0-9_.-]+$/u)
const semanticDependencySchema = z.object({
  description: z.string().min(1),
  requiredFor: z.string().min(1),
  disposition: z.enum(["read", "narrow", "defer", "retain_uncertainty"]),
})
const graphDataSchema = z.object({
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const graphMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_node"), ref: localReferenceSchema, data: graphDataSchema }),
  z.object({ operation: z.literal("edit_node"), nodeRef: referenceSchema, next: graphDataSchema }),
  z.object({ operation: z.literal("retire_node"), nodeRef: referenceSchema, archiveOutletRefs: z.array(referenceSchema).min(1) }),
  z.object({ operation: z.literal("create_link"), ref: localReferenceSchema, fromRef: referenceSchema, toRef: referenceSchema, content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ operation: z.literal("edit_link"), linkRef: referenceSchema, fromRef: referenceSchema, toRef: referenceSchema, content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ operation: z.literal("retire_link"), linkRef: referenceSchema, archiveOutletRefs: z.array(referenceSchema).min(1) }),
])

export const interpretArtifactSchema = z.object({
  workflow: z.enum(["turn", "query", "evolution", "revision"]),
  userIntent: z.string(),
  worldIntent: z.string(),
  presentationIntent: z.string(),
  userClaims: z.array(z.object({
    text: z.string().min(1),
    treatment: z.enum(["instruction", "proposal", "claim", "question", "presentation"]),
    truthStatus: z.enum(["not_assumed", "requires_read", "current_turn_new"]),
  })),
  requiredTimeAnchor: z.boolean(),
  requiredLocationAnchor: z.boolean(),
  initialReadHypotheses: z.array(z.string().min(1)),
})

export const ruleAssemblyArtifactSchema = z.object({
  selectedWorkspacePaths: z.array(z.string().min(1)),
  selectionReasons: z.record(z.string(), z.string().min(1)),
  unresolvedRuleConflicts: z.array(z.string().min(1)),
})

export const retrievalArtifactSchema = z.object({
  missingEvidence: z.array(z.string().min(1)).default([]),
  nextExpansionHints: z.array(z.string().min(1)).default([]),
})

export const emergencePlanningArtifactSchema = z.object({
  decisions: z.array(z.object({
    pressureEvidenceRefs: z.array(referenceSchema),
    action: z.enum(["reuse", "extend", "reveal", "create_new", "defer", "reject"]),
    existingAnchorRefs: z.array(referenceSchema),
    timeAnchorRefs: z.array(referenceSchema),
    locationAnchorRefs: z.array(referenceSchema),
    informationBoundaryRefs: z.array(referenceSchema),
    reason: z.string().min(1),
  })),
  noCreationReason: z.string().min(1).optional(),
})

export const emergenceReviewArtifactSchema = z.object({
  approvedDecisionIndexes: z.array(z.number().int().nonnegative()),
  revisionRequests: z.array(z.object({
    decisionIndex: z.number().int().nonnegative(),
    reason: z.string().min(1),
    returnTo: z.enum(["source_retrieval", "emergence_planning"]),
  })),
  identityRecallComplete: z.boolean(),
  temporalEntryComplete: z.boolean(),
  spatialEntryComplete: z.boolean(),
  informationBoundaryComplete: z.boolean(),
})

export const internalDraftArtifactSchema = z.object({
  contentMarkdown: z.string().min(1),
  adoptedDecisionIndexes: z.array(z.number().int().nonnegative()),
  currentTimeAnchorRefs: z.array(referenceSchema),
  currentLocationAnchorRefs: z.array(referenceSchema),
  detectedUnplannedContent: z.array(z.string().min(1)),
})

export const chapterNamingArtifactSchema = z.object({
  chapterNumberText: z.string().min(1),
  heading: z.string().min(1),
  filename: z.string().regex(/\.md$/u),
  continuityEvidenceRefs: z.array(referenceSchema),
})

export const dependencyAuditArtifactSchema = z.object({
  missingDependencies: z.array(semanticDependencySchema),
  unplannedContent: z.array(z.object({
    description: z.string().min(1),
    returnTo: z.enum(["source_retrieval", "emergence_planning", "draft"]),
  })),
  sceneContinuity: z.array(z.object({
    sceneIndex: indexSchema,
    sceneDescription: z.string().min(1),
    predecessorSceneIndexes: z.array(indexSchema),
    predecessorSceneRefs: z.array(referenceSchema),
    predecessorRequired: z.boolean(),
    predecessorReason: z.string().min(1),
    correspondenceRequired: z.boolean(),
    correspondenceReason: z.string().min(1),
    timeContinuity: continuityStatusSchema,
    locationContinuity: continuityStatusSchema,
    crossReferenceContinuity: continuityStatusSchema,
    reason: z.string().min(1),
  })),
  informationBoundary: continuityStatusSchema,
})

export const responseReviewArtifactSchema = z.object({
  evidenceClosed: z.boolean(),
  leaksUnobservedInformation: z.boolean(),
  requiresWorkflowUpgrade: z.boolean(),
  upgradeReason: z.string().min(1).optional(),
})

const sceneSpacetimeBindingSchema = z.object({
  sceneIndex: indexSchema,
  sceneAnchorRef: referenceSchema,
  sourceUnitIndexes: z.array(indexSchema),
  temporalReferenceRefs: z.array(referenceSchema).min(1),
  timeAnchorRefs: z.array(referenceSchema).min(1),
  spatialReferenceRefs: z.array(referenceSchema).min(1),
  locationAnchorRefs: z.array(referenceSchema).min(1),
  predecessorSceneIndexes: z.array(indexSchema),
  predecessorSceneAnchorRefs: z.array(referenceSchema),
  transitionPathRefs: z.array(referenceSchema),
  correspondenceRefs: z.array(referenceSchema),
  explanation: z.string().min(1),
  selfReview: z.string().min(1),
})

const mutationSpacetimeSettlementSchema = z.object({
  mutationIndexes: z.array(indexSchema).min(1),
  effectDisposition: z.enum(["world_effect", "representation_only"]),
  effectiveSceneBindingIndexes: z.array(indexSchema),
  effectiveExistingSceneAnchorRefs: z.array(referenceSchema),
  currentEntryRefs: z.array(referenceSchema),
  predecessorRevisionRequired: z.boolean(),
  predecessorRevisionReadRefs: z.array(referenceSchema),
  historicalReturnRefs: z.array(referenceSchema).min(1),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
}).superRefine((settlement, context) => {
  if (settlement.effectDisposition === "world_effect") {
    if (settlement.effectiveSceneBindingIndexes.length === 0 && settlement.effectiveExistingSceneAnchorRefs.length === 0) {
      context.addIssue({ code: "custom", message: "world_effect requires an effective scene" })
    }
    if (settlement.currentEntryRefs.length === 0) {
      context.addIssue({ code: "custom", message: "world_effect requires a current entry" })
    }
  }
  if (settlement.predecessorRevisionRequired && settlement.predecessorRevisionReadRefs.length === 0) {
    context.addIssue({ code: "custom", message: "required predecessor revisions must use read evidence references" })
  }
})

export const graphGovernanceArtifactSchema = z.object({
  mutations: z.array(graphMutationSchema),
  retrievalProjections: z.array(z.object({
    ownerKind: z.enum(["node", "link"]),
    ownerMutationIndex: indexSchema.optional(),
    ownerRef: referenceSchema.optional(),
    exactKeys: z.array(z.string().min(1)),
    semanticText: z.string().min(1),
  }).refine(
    (projection) => projection.ownerMutationIndex !== undefined || projection.ownerRef !== undefined,
    { message: "projection must reference a proposed mutation or an existing revision" },
  )),
  settlementRecords: z.array(z.object({
    sourceUnitIndex: indexSchema,
    graphRefs: z.array(z.object({
      targetKind: z.enum(["node", "link"]),
      targetRef: referenceSchema,
      mutationIndex: indexSchema.optional(),
    })),
    reason: z.string().min(1),
    status: z.string().min(1),
  })).default([]),
  mutationSpacetimeSettlements: z.array(mutationSpacetimeSettlementSchema),
  sceneSpacetimeBindings: z.array(sceneSpacetimeBindingSchema),
  affectedFrontierRefs: z.array(referenceSchema),
  archiveOutletRefs: z.array(referenceSchema),
  decisionRecords: z.array(z.object({
    decisionKind: z.string().min(1),
    mutationIndexes: z.array(indexSchema),
    mutationSpacetimeSettlementIndexes: z.array(indexSchema),
    reason: z.string().min(1),
    payload: z.unknown(),
    selfReview: z.string().min(1),
  })),
})

export const semanticReviewArtifactSchema = z.object({
  approvedMutationIndexes: z.array(indexSchema),
  rejectedMutationIndexes: z.array(indexSchema),
  approvedSpacetimeBindingIndexes: z.array(indexSchema),
  rejectedSpacetimeBindingIndexes: z.array(indexSchema),
  approvedMutationSpacetimeSettlementIndexes: z.array(indexSchema),
  rejectedMutationSpacetimeSettlementIndexes: z.array(indexSchema),
  approvedAffectedFrontierRefs: z.array(referenceSchema),
  rejectedAffectedFrontierRefs: z.array(referenceSchema),
  verificationProbes: z.array(z.object({
    purpose: z.enum(["scene_restore", "current_state", "history_return", "source_return"]),
    sceneBindingIndexes: z.array(indexSchema),
    mutationSpacetimeSettlementIndexes: z.array(indexSchema),
    query: z.string().min(1),
    observedReadRefs: z.array(referenceSchema),
    observedGraphRefs: z.array(referenceSchema),
    verdict: z.enum(["pass", "uncertain", "fail"]),
    reason: z.string().min(1),
  })),
  sceneInventoryComplete: z.boolean(),
  revisionReason: z.string().min(1).optional(),
  returnTo: z.enum(["source_retrieval", "graph_governance"]).optional(),
  graphStillDiscoverable: z.boolean(),
  graphStillConcise: z.boolean(),
  continuityPreserved: z.boolean(),
  spacetimeContinuityPreserved: z.boolean(),
})

export const settlementReviewArtifactSchema = z.object({
  settledSourceUnitIndexes: z.array(indexSchema),
  uncoveredSourceUnitIndexes: z.array(indexSchema),
  sourceReturnComplete: z.boolean(),
  retrievalProjectionComplete: z.boolean(),
  semanticCoverageComplete: z.boolean(),
  spacetimeBindingsComplete: z.boolean(),
  mutationSpacetimeSettlementsComplete: z.boolean(),
})

export const frontierSettlementArtifactSchema = z.object({
  frontiers: z.array(z.object({
    frontierAnchorRef: referenceSchema,
    disposition: z.enum(["active", "deferred", "archived"]),
    lastSceneAnchorRefs: z.array(referenceSchema),
    lastTimeAnchorRefs: z.array(referenceSchema),
    lastLocationAnchorRefs: z.array(referenceSchema),
    correspondenceRefs: z.array(referenceSchema),
    reason: z.string().min(1),
    revisitCondition: z.string().min(1).optional(),
  }).superRefine((frontier, context) => {
    if (frontier.disposition !== "archived") {
      if (frontier.lastSceneAnchorRefs.length === 0 || frontier.lastTimeAnchorRefs.length === 0 || frontier.lastLocationAnchorRefs.length === 0) {
        context.addIssue({ code: "custom", message: "active and deferred frontiers require their own scene, time, and location anchors" })
      }
      if (frontier.revisitCondition === undefined) {
        context.addIssue({ code: "custom", message: "active and deferred frontiers require a revisit condition" })
      }
    }
  })),
})

export const commitReviewArtifactSchema = z.object({
  recommendation: z.enum(["commit", "revise", "retire"]),
  revisionTargetPhase: aiPhaseSchema.optional(),
  finalSelfReview: z.string().min(1),
})

export const contextCompactionArtifactSchema = z.object({
  coveredSegmentIndexes: z.array(z.number().int().nonnegative()),
  summary: z.string().min(1),
  retainedFactDigests: z.array(z.string().min(1)),
  retainedAnchorRefs: z.array(referenceSchema),
  unresolvedDependencyRefs: z.array(referenceSchema),
  sourceRefs: z.array(referenceSchema),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
})

export const contextCompactionReviewArtifactSchema = z.object({
  decision: z.enum(["approve", "revise", "block"]),
  missingFactDigests: z.array(z.string().min(1)),
  missingAnchorRefs: z.array(referenceSchema),
  missingSourceRefs: z.array(referenceSchema),
  reason: z.string().min(1),
})

export const phaseArtifactSchemas: Record<AIPhase, z.ZodType> = {
  interpret: interpretArtifactSchema,
  rule_assembly: ruleAssemblyArtifactSchema,
  source_retrieval: retrievalArtifactSchema,
  emergence_planning: emergencePlanningArtifactSchema,
  emergence_review: emergenceReviewArtifactSchema,
  draft: internalDraftArtifactSchema,
  chapter_naming: chapterNamingArtifactSchema,
  dependency_audit: dependencyAuditArtifactSchema,
  response_review: responseReviewArtifactSchema,
  graph_governance: graphGovernanceArtifactSchema,
  semantic_review: semanticReviewArtifactSchema,
  settlement_review: settlementReviewArtifactSchema,
  frontier_settlement: frontierSettlementArtifactSchema,
  commit_review: commitReviewArtifactSchema,
  context_compaction: contextCompactionArtifactSchema,
  context_compaction_review: contextCompactionReviewArtifactSchema,
}

export function phaseArtifactJsonSchema(phase: AIPhase): unknown {
  return z.toJSONSchema(phaseArtifactSchemas[phase])
}

export type InterpretArtifact = z.infer<typeof interpretArtifactSchema>
export type RuleAssemblyArtifact = z.infer<typeof ruleAssemblyArtifactSchema>
export type RetrievalArtifact = z.infer<typeof retrievalArtifactSchema>
export type EmergencePlanningArtifact = z.infer<typeof emergencePlanningArtifactSchema>
export type EmergenceReviewArtifact = z.infer<typeof emergenceReviewArtifactSchema>
export type InternalDraftArtifact = z.infer<typeof internalDraftArtifactSchema>
export type ChapterNamingArtifact = z.infer<typeof chapterNamingArtifactSchema>
export type DependencyAuditArtifact = z.infer<typeof dependencyAuditArtifactSchema>
export type ResponseReviewArtifact = z.infer<typeof responseReviewArtifactSchema>
export type GraphGovernanceArtifact = z.infer<typeof graphGovernanceArtifactSchema>
export type SemanticReviewArtifact = z.infer<typeof semanticReviewArtifactSchema>
export type SettlementReviewArtifact = z.infer<typeof settlementReviewArtifactSchema>
export type FrontierSettlementArtifact = z.infer<typeof frontierSettlementArtifactSchema>
export type CommitReviewArtifact = z.infer<typeof commitReviewArtifactSchema>
export type ContextCompactionArtifact = z.infer<typeof contextCompactionArtifactSchema>
export type ContextCompactionReviewArtifact = z.infer<typeof contextCompactionReviewArtifactSchema>
