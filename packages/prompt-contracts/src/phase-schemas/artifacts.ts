import { z } from "zod"

import {
  aiPhaseSchema,
  graphMutationSchema,
  idSchema,
  sourceRefSchema,
  unresolvedDependencySchema,
  type AIPhase,
} from "@worldseed/contracts"

const continuityStatusSchema = z.enum(["pass", "revise", "unknown"])

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
  ruleSnapshotId: idSchema,
  baseRuleVersion: z.string().min(1),
  userRuleVersionIds: z.array(idSchema),
  settingSkillVersionIds: z.array(idSchema),
  referenceSkillVersionIds: z.array(idSchema),
  presentationRuleVersionIds: z.array(idSchema),
  selectionReasons: z.record(z.string(), z.string().min(1)),
  unresolvedRuleConflicts: z.array(z.string().min(1)),
})

export const retrievalArtifactSchema = z.object({
  executedRequestIds: z.array(idSchema),
  returnedReadIds: z.array(idSchema),
  rejectedCandidateIds: z.array(idSchema),
  missingEvidence: z.array(z.string().min(1)),
  nextExpansionHints: z.array(z.string().min(1)),
})

export const emergencePlanningArtifactSchema = z.object({
  decisions: z.array(z.object({
    decisionId: idSchema,
    pressureEvidenceIds: z.array(idSchema),
    action: z.enum(["reuse", "extend", "reveal", "create_new", "defer", "reject"]),
    existingAnchorIds: z.array(idSchema),
    proposedAnchorCount: z.number().int().nonnegative(),
    timeAnchorIds: z.array(idSchema),
    locationAnchorIds: z.array(idSchema),
    informationBoundaryIds: z.array(idSchema),
    reason: z.string().min(1),
  })),
  noCreationReason: z.string().min(1).optional(),
})

export const emergenceReviewArtifactSchema = z.object({
  reviewedDecisionIds: z.array(idSchema),
  approvedDecisionIds: z.array(idSchema),
  revisionRequests: z.array(z.object({
    decisionId: idSchema,
    reason: z.string().min(1),
    returnTo: z.enum(["source_retrieval", "emergence_planning"]),
  })),
  identityRecallComplete: z.boolean(),
  temporalEntryComplete: z.boolean(),
  spatialEntryComplete: z.boolean(),
  informationBoundaryComplete: z.boolean(),
})

export const internalDraftArtifactSchema = z.object({
  draftId: idSchema,
  contentMarkdown: z.string().min(1),
  contentRef: z.string().min(1).optional(),
  adoptedEmergenceDecisionIds: z.array(idSchema),
  citedReadIds: z.array(idSchema),
  currentTimeAnchorIds: z.array(idSchema),
  currentLocationAnchorIds: z.array(idSchema),
  detectedUnplannedContent: z.array(z.string().min(1)),
})

export const chapterNamingArtifactSchema = z.object({
  chapterId: idSchema,
  chapterNumberText: z.string().min(1),
  heading: z.string().min(1),
  filename: z.string().regex(/\.md$/u),
  predecessorSourceId: idSchema.optional(),
  continuityEvidenceIds: z.array(idSchema),
})

export const dependencyAuditArtifactSchema = z.object({
  auditedDraftId: idSchema,
  resolvedDependencyIds: z.array(idSchema),
  missingDependencies: z.array(unresolvedDependencySchema),
  unplannedContent: z.array(z.object({
    description: z.string().min(1),
    returnTo: z.enum(["source_retrieval", "emergence_planning", "draft"]),
  })),
  timeContinuity: continuityStatusSchema,
  locationContinuity: continuityStatusSchema,
  informationBoundary: continuityStatusSchema,
})

export const responseReviewArtifactSchema = z.object({
  responseArtifactId: idSchema,
  evidenceClosed: z.boolean(),
  leaksUnobservedInformation: z.boolean(),
  requiresWorkflowUpgrade: z.boolean(),
  upgradeReason: z.string().min(1).optional(),
})

export const graphGovernanceArtifactSchema = z.object({
  proposalId: idSchema,
  sourceUnitIds: z.array(idSchema),
  mutations: z.array(graphMutationSchema),
  retrievalProjections: z.array(z.object({
    projectionId: idSchema,
    ownerKind: z.string().min(1),
    ownerId: idSchema,
    ownerMutationIndex: z.number().int().nonnegative().optional(),
    ownerRevisionId: idSchema.optional(),
    exactKeys: z.array(z.string().min(1)),
    semanticText: z.string().min(1),
    sourceRefs: z.array(sourceRefSchema),
  }).refine(
    (projection) => projection.ownerMutationIndex !== undefined || projection.ownerRevisionId !== undefined,
    { message: "projection must reference a proposed mutation or an existing revision" },
  )),
  settlementRecords: z.array(z.object({
    settlementRecordId: idSchema,
    sourceUnitId: idSchema,
    graphRefs: z.array(z.object({
      targetKind: z.enum(["node", "link"]),
      targetId: idSchema,
      mutationIndex: z.number().int().nonnegative().optional(),
    })),
    reason: z.string().min(1),
    status: z.string().min(1),
  })),
  continuityProofs: z.array(z.object({
    continuityProofId: idSchema,
    payload: z.unknown(),
  })),
  archiveOutletIds: z.array(idSchema),
  decisionRecords: z.array(z.object({
    decisionRecordId: idSchema,
    decisionKind: z.string().min(1),
    mutationIndexes: z.array(z.number().int().nonnegative()),
    reason: z.string().min(1),
    evidenceIds: z.array(idSchema),
    payload: z.unknown(),
    selfReview: z.string().min(1),
  })),
})

export const semanticReviewArtifactSchema = z.object({
  proposalId: idSchema,
  approvedMutationIndexes: z.array(z.number().int().nonnegative()),
  rejectedMutationIndexes: z.array(z.number().int().nonnegative()),
  revisionReason: z.string().min(1).optional(),
  returnTo: z.enum(["source_retrieval", "graph_governance"]).optional(),
  graphStillDiscoverable: z.boolean(),
  graphStillConcise: z.boolean(),
  continuityPreserved: z.boolean(),
})

export const settlementReviewArtifactSchema = z.object({
  sourceUnitIds: z.array(idSchema),
  settledSourceUnitIds: z.array(idSchema),
  uncoveredSourceUnitIds: z.array(idSchema),
  sourceReturnComplete: z.boolean(),
  retrievalProjectionComplete: z.boolean(),
  semanticCoverageComplete: z.boolean(),
})

export const frontierSettlementArtifactSchema = z.object({
  affectedAnchorIds: z.array(idSchema),
  activeFrontierIds: z.array(idSchema),
  deferredFrontierIds: z.array(idSchema),
  archivedFrontierIds: z.array(idSchema),
  lastWorldTimeAnchorIds: z.array(idSchema),
  deferralReasons: z.record(idSchema, z.string().min(1)),
})

export const commitReviewArtifactSchema = z.object({
  decision: z.enum(["commit", "revise", "retire"]),
  scopeId: idSchema,
  requiredPhaseRunIds: z.array(idSchema),
  approvedArtifactIds: z.array(idSchema),
  unresolvedDependencyIds: z.array(idSchema),
  revisionTargetPhase: aiPhaseSchema.optional(),
  finalSelfReview: z.string().min(1),
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
