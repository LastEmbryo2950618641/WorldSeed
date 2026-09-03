import { z } from "zod"

import {
  aiPhaseSchema,
  type AIPhase,
} from "@worldseed/contracts"

const continuityStatusSchema = z.enum(["pass", "revise", "unknown"])
const referenceSchema = z.string().min(1)
const evidenceReferenceSchema = z.string().regex(/^(?:(?:read-[1-9][0-9]*)|(?:evidence_[1-9][0-9]*))$/u)
const indexSchema = z.number().int().nonnegative()
const localReferenceSchema = z.string().regex(/^local:[a-zA-Z0-9_.-]+$/u)
const semanticDependencySchema = z.object({
  description: z.string().min(1),
  requiredFor: z.string().min(1),
  disposition: z.enum(["read", "narrow", "defer", "retain_uncertainty"]),
})
const ruleWorkspacePathSchema = z.string().min(1).max(512)
const ruleControlTextSchema = z.string().min(1).max(500)
const graphDataSchema = z.object({
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export const graphMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_node"), ref: localReferenceSchema, data: graphDataSchema }),
  z.object({ operation: z.literal("edit_node"), nodeRef: referenceSchema, next: graphDataSchema }),
  z.object({ operation: z.literal("retire_node"), nodeRef: referenceSchema, archiveOutletRefs: z.array(referenceSchema).min(1) }),
  z.object({ operation: z.literal("create_link"), ref: localReferenceSchema, fromRef: referenceSchema, toRef: referenceSchema, content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ operation: z.literal("edit_link"), linkRef: referenceSchema, fromRef: referenceSchema, toRef: referenceSchema, content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ operation: z.literal("retire_link"), linkRef: referenceSchema, archiveOutletRefs: z.array(referenceSchema).min(1) }),
])

const proposalReferenceSchema = z.string().regex(/^proposal:[a-zA-Z0-9_.:-]+$/u)
const graphStructureProposalSchema = z.object({
  proposalRef: proposalReferenceSchema,
  mutation: graphMutationSchema,
  reason: z.string().min(1),
  selfReview: z.string().min(1),
})

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
  selectedWorkspacePaths: z.array(ruleWorkspacePathSchema).max(32),
  selectionReasons: z.record(ruleWorkspacePathSchema, ruleControlTextSchema),
  unresolvedRuleConflicts: z.array(ruleControlTextSchema).max(16),
}).superRefine((artifact, context) => {
  const selectedPaths = new Set(artifact.selectedWorkspacePaths)
  if (selectedPaths.size !== artifact.selectedWorkspacePaths.length) {
    context.addIssue({
      code: "custom",
      path: ["selectedWorkspacePaths"],
      message: "selectedWorkspacePaths must not contain duplicates",
    })
  }

  const reasonPaths = Object.keys(artifact.selectionReasons)
  const missingReasonPaths = artifact.selectedWorkspacePaths.filter((path) => !(path in artifact.selectionReasons))
  const unselectedReasonPaths = reasonPaths.filter((path) => !selectedPaths.has(path))
  if (missingReasonPaths.length > 0 || unselectedReasonPaths.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["selectionReasons"],
      message: "selectionReasons keys must exactly match selectedWorkspacePaths",
    })
  }
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
  /** Volume folder under 章节正文, e.g. `第一卷 潮水退去时`. */
  volumeFolderName: z.string().min(1).refine(
    (value) => /^第(?:\d+|[零一二三四五六七八九十百]+)卷\s+\S.*$/u.test(value.trim()),
    {
      message: "volumeFolderName 必须为「第N卷 标题」形式（例如「第一卷 潮水退去时」）；章节不能直接放在章节正文根下",
    },
  ),
  continuityEvidenceRefs: z.array(referenceSchema),
})

export const temporalClaimSchema = z.object({
  claimRef: z.string().regex(/^claim:[a-zA-Z0-9_.:-]+$/u),
  sceneIndex: indexSchema,
  sourceUnitIndexes: z.array(indexSchema),
  proseExcerpt: z.string().min(1),
  referenceDescription: z.string().min(1),
  referenceRefs: z.array(referenceSchema),
  evidenceRefs: z.array(referenceSchema),
  timelineRefs: z.array(referenceSchema),
  relationDescription: z.string().min(1),
  verdict: z.enum(["pass", "uncertain", "conflict"]),
  reason: z.string().min(1),
  missingEvidence: z.array(z.string().min(1)),
})

export const temporalClaimSettlementSchema = z.object({
  claimRef: temporalClaimSchema.shape.claimRef,
  sceneIndex: indexSchema,
  referenceRefs: z.array(referenceSchema),
  timeAnchorRefs: z.array(referenceSchema),
  timelineRefs: z.array(referenceSchema),
  correspondenceRefs: z.array(referenceSchema),
  historicalReturnRefs: z.array(referenceSchema),
  confidence: z.enum(["certain", "uncertain"]),
  explanation: z.string().min(1),
  selfReview: z.string().min(1),
})

export const temporalClaimAssessmentSchema = z.object({
  claimRef: temporalClaimSchema.shape.claimRef,
  evidenceSufficient: z.boolean(),
  verdict: z.enum(["pass", "uncertain", "conflict"]),
  narrativeContext: z.string().min(1),
  evidenceRefs: z.array(evidenceReferenceSchema),
  responsibility: z.enum(["dependency", "spacetime", "retrieval", "draft"]),
  reason: z.string().min(1),
  advice: z.string().min(1).optional(),
})

export const continuityAdviceSchema = z.object({
  claimRef: temporalClaimSchema.shape.claimRef,
  proseExcerpt: z.string().min(1),
  verdict: z.enum(["pass", "uncertain", "conflict"]),
  summary: z.string().min(1),
  evidenceRefs: z.array(evidenceReferenceSchema),
  suggestedDirection: z.string().min(1).optional(),
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
  temporalClaims: z.array(temporalClaimSchema).default([]),
  informationBoundary: continuityStatusSchema,
}).superRefine((artifact, context) => {
  const claimRefs = artifact.temporalClaims.map((claim) => claim.claimRef)
  if (new Set(claimRefs).size !== claimRefs.length) {
    context.addIssue({ code: "custom", path: ["temporalClaims"], message: "temporal claim references must be unique" })
  }
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

const spacetimeSettlementBaseSchema = z.object({
  effectDisposition: z.enum(["world_effect", "representation_only"]),
  effectiveSceneBindingIndexes: z.array(indexSchema),
  effectiveExistingSceneAnchorRefs: z.array(referenceSchema),
  currentEntryRefs: z.array(referenceSchema),
  predecessorRevisionRequired: z.boolean(),
  predecessorRevisionReadRefs: z.array(referenceSchema),
  historicalReturnRefs: z.array(referenceSchema).min(1),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
})

function assertSpacetimeSettlementRules(
  settlement: z.infer<typeof spacetimeSettlementBaseSchema>,
  context: z.RefinementCtx,
): void {
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
}

const mutationSpacetimeSettlementSchema = spacetimeSettlementBaseSchema.extend({
  mutationIndexes: z.array(indexSchema).min(1),
}).superRefine(assertSpacetimeSettlementRules)

export const graphStructurePlanArtifactSchema = z.object({
  proposals: z.array(graphStructureProposalSchema),
  affectedFrontierRefs: z.array(referenceSchema),
  archiveOutletRefs: z.array(referenceSchema),
  decisionRecords: z.array(z.object({
    decisionKind: z.string().min(1),
    proposalRefs: z.array(proposalReferenceSchema),
    reason: z.string().min(1),
    payload: z.unknown(),
    selfReview: z.string().min(1),
  })),
}).superRefine((artifact, context) => {
  const proposalRefs = artifact.proposals.map((proposal) => proposal.proposalRef)
  if (new Set(proposalRefs).size !== proposalRefs.length) {
    context.addIssue({ code: "custom", path: ["proposals"], message: "proposalRef values must be unique" })
  }
  const proposalRefSet = new Set(proposalRefs)
  const decidedProposalRefs = artifact.decisionRecords.flatMap((decision) => decision.proposalRefs)
  const unknownProposalRefs = [...new Set(decidedProposalRefs.filter((proposalRef) => !proposalRefSet.has(proposalRef)))]
  if (unknownProposalRefs.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["decisionRecords"],
      message: `decision records reference unknown proposals: ${unknownProposalRefs.join(", ")}`,
    })
  }
  const decidedProposalRefSet = new Set(decidedProposalRefs)
  const uncoveredProposalRefs = proposalRefs.filter((proposalRef) => !decidedProposalRefSet.has(proposalRef))
  if (uncoveredProposalRefs.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["decisionRecords"],
      message: `decision records must cover every proposal; uncovered: ${uncoveredProposalRefs.join(", ")}`,
    })
  }
})

export const graphCapacityRewriteArtifactSchema = z.object({
  hotspotRefs: z.array(referenceSchema).min(1),
  affectedProposalRefs: z.array(proposalReferenceSchema).min(1),
  removeProposalRefs: z.array(proposalReferenceSchema),
  upsertProposals: z.array(graphStructureProposalSchema),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
})

export const graphSpacetimeSettlementArtifactSchema = z.object({
  sceneSpacetimeBindings: z.array(sceneSpacetimeBindingSchema),
  proposalSettlements: z.array(spacetimeSettlementBaseSchema.extend({
    proposalRefs: z.array(proposalReferenceSchema).min(1),
  }).superRefine(assertSpacetimeSettlementRules)),
  temporalClaimSettlements: z.array(temporalClaimSettlementSchema).default([]),
})

export const graphRetrievalDesignArtifactSchema = z.object({
  projections: z.array(z.object({
    ownerProposalRef: proposalReferenceSchema.optional(),
    ownerRef: referenceSchema.optional(),
    exactKeys: z.array(z.string().min(1)),
    semanticText: z.string().min(1),
  }).refine(
    (projection) => projection.ownerProposalRef !== undefined || projection.ownerRef !== undefined,
    { message: "projection must reference a proposal or an existing graph owner" },
  )),
  sourceSettlements: z.array(z.object({
    sourceUnitIndex: indexSchema,
    graphRefs: z.array(z.object({
      targetKind: z.enum(["node", "link"]),
      targetRef: referenceSchema,
      proposalRef: proposalReferenceSchema.optional(),
    })),
    reason: z.string().min(1),
    status: z.string().min(1),
  })).default([]),
})

export const graphGovernanceReviewArtifactSchema = z.object({
  recommendation: z.enum(["pass", "revise"]),
  issues: z.array(z.object({
    responsibility: z.enum(["structure", "capacity", "spacetime", "retrieval"]),
    summary: z.string().min(1),
    affectedRefs: z.array(referenceSchema),
  })),
  graphStillDiscoverable: z.boolean(),
  graphStillConcise: z.boolean(),
  continuityPreserved: z.boolean(),
  spacetimeContinuityPreserved: z.boolean(),
  sourceReturnComplete: z.boolean(),
  verificationProbeAssessments: z.array(z.object({
    probeIndex: indexSchema,
    verdict: z.enum(["pass", "uncertain", "fail"]),
    reason: z.string().min(1),
  })),
  temporalClaimAssessments: z.array(temporalClaimAssessmentSchema).default([]),
  selfReview: z.string().min(1),
})

export const graphGovernanceArtifactSchema = z.object({
  executionMode: z.enum(["no_change", "local_governance", "full_governance"]).default("full_governance"),
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
}).superRefine((artifact, context) => {
  if (artifact.executionMode === "no_change" && artifact.mutations.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["mutations"],
      message: "no_change graph governance cannot contain mutations",
    })
  }
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
  verificationProbeAssessments: z.array(z.object({
    probeIndex: indexSchema,
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
  goalCompliance: z.array(z.object({
    goalId: z.string().min(1),
    verdict: z.enum(["satisfied", "partial", "violated"]),
    reason: z.string().min(1),
  })).optional(),
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
  continuityAdvice: z.array(continuityAdviceSchema).default([]),
  finalSelfReview: z.string().min(1),
})

export const revisionReviewArtifactSchema = z.object({
  issues: z.array(z.object({
    location: z.string().min(1),
    category: z.string().min(1),
    severity: z.enum(["suggestion", "notice"]),
    evidenceRefs: z.array(z.string().min(1)),
    description: z.string().min(1),
    impact: z.string().min(1),
    suggestion: z.string().min(1),
    requiresGraphSync: z.boolean(),
    affectsLaterChapters: z.boolean(),
  })),
  recommendation: z.enum(["no_issue", "review_suggested", "material_conflict"]),
  finalSelfReview: z.string().min(1),
})

export const revisionAssistArtifactSchema = z.object({
  assistantMessage: z.string().min(1),
  proposedHeading: z.string().min(1).optional(),
  proposedBody: z.string().min(1),
  finalSelfReview: z.string().min(1),
})

const synopsisDiscussGoalIdSchema = z.string().min(1)
const synopsisDiscussGoalNarrativeKindSchema = z.enum(["general", "foreshadow", "climax"])
const synopsisDiscussGoalScaleSchema = z.enum(["short", "medium", "long"])

const synopsisDiscussGoalProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    content: z.string().min(1).max(2_000),
    narrativeKind: synopsisDiscussGoalNarrativeKindSchema.optional(),
    scale: synopsisDiscussGoalScaleSchema.optional(),
    plantChapterSequence: z.number().int().positive().optional(),
    payoffChapterSequence: z.number().int().positive().optional(),
  }).superRefine((payload, context) => {
    if (
      payload.plantChapterSequence !== undefined
      && payload.payoffChapterSequence !== undefined
      && payload.plantChapterSequence > payload.payoffChapterSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "plantChapterSequence must be ≤ payoffChapterSequence",
        path: ["plantChapterSequence"],
      })
    }
  }),
  z.object({
    kind: z.literal("update_content"),
    goalId: synopsisDiscussGoalIdSchema,
    content: z.string().min(1).max(2_000).optional(),
    narrativeKind: synopsisDiscussGoalNarrativeKindSchema.optional(),
    scale: synopsisDiscussGoalScaleSchema.optional(),
    plantChapterSequence: z.number().int().positive().optional(),
    payoffChapterSequence: z.number().int().positive().optional(),
  }).superRefine((payload, context) => {
    const hasTaxonomy = payload.narrativeKind !== undefined
      || payload.scale !== undefined
      || payload.plantChapterSequence !== undefined
      || payload.payoffChapterSequence !== undefined
    if ((payload.content === undefined || payload.content.trim().length === 0) && !hasTaxonomy) {
      context.addIssue({
        code: "custom",
        message: "content or taxonomy fields required for update_content",
        path: ["content"],
      })
    }
    if (
      payload.plantChapterSequence !== undefined
      && payload.payoffChapterSequence !== undefined
      && payload.plantChapterSequence > payload.payoffChapterSequence
    ) {
      context.addIssue({
        code: "custom",
        message: "plantChapterSequence must be ≤ payoffChapterSequence",
        path: ["plantChapterSequence"],
      })
    }
  }),
  z.object({
    kind: z.literal("complete"),
    goalId: synopsisDiscussGoalIdSchema,
  }),
  z.object({
    kind: z.literal("remove"),
    goalId: synopsisDiscussGoalIdSchema,
    reason: z.string().max(1_000).optional(),
  }),
  z.object({
    kind: z.literal("set_chapter_progress"),
    goalId: synopsisDiscussGoalIdSchema,
    chapterSequence: z.number().int().positive(),
    summary: z.string().min(1).max(4_000),
  }),
])

export const synopsisDiscussGoalProposalSchema = z.object({
  payload: synopsisDiscussGoalProposalPayloadSchema,
  reason: z.string().max(1_000).optional(),
})

export const synopsisStagingEntryPatchSchema = z.object({
  entryId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  promoteTargetPath: z.string().min(1).max(500).optional(),
  status: z.enum(["open", "pending_promote", "settled"]).optional(),
})

export const synopsisStagingDeltaSchema = z.object({
  notes: z.array(synopsisStagingEntryPatchSchema).max(20).optional(),
  characters: z.array(synopsisStagingEntryPatchSchema).max(20).optional(),
  worldRules: z.array(synopsisStagingEntryPatchSchema).max(20).optional(),
  promoteHints: z.array(synopsisStagingEntryPatchSchema).max(20).optional(),
})

export const synopsisStagingPromoteWriteSchema = z.object({
  entryId: z.string().min(1),
  relativePath: z.string().regex(/^设定集\/[^/][^\n]*\.md$/u),
  markdown: z.string().min(1),
  readmeEntry: z.string().max(500).optional(),
  mode: z.enum(["create", "update"]),
})

export const synopsisStagingPromoteArtifactSchema = z.object({
  settingsWrites: z.array(synopsisStagingPromoteWriteSchema).min(1).max(30),
  goalProposals: z.array(synopsisDiscussGoalProposalSchema).optional(),
  reason: z.string().max(1_000).optional(),
})

/** Immediate create/update for 描写规则 / 笔风规则 during synopsis discuss. */
export const synopsisPresentationWriteSchema = z.object({
  relativePath: z.string().regex(
    /^表现输出\/(?:描写规则|笔风规则)\/[^/][^\n]*\.md$/u,
    "presentationWrites 路径必须位于 表现输出/描写规则/ 或 表现输出/笔风规则/ 下",
  ),
  markdown: z.string().min(1).max(80_000),
  mode: z.enum(["create", "update"]),
})

export const synopsisDiscussArtifactSchema = z.object({
  assistantMessage: z.string().min(1),
  chapterTitle: z.string().min(1).optional(),
  /** Volume folder under 章节正文, e.g. `第一卷 潮水退去时`. */
  volumeFolderName: z.string().min(1).refine(
    (value) => /^第(?:\d+|[零一二三四五六七八九十百]+)卷\s+\S.*$/u.test(value.trim()),
    {
      message: "volumeFolderName 必须为「第N卷 标题」形式（例如「第一卷 潮水退去时」）",
    },
  ).optional(),
  synopsisBody: z.string().min(1).optional(),
  /** Full chapter outline markdown (`…[剧情细纲].md`); preferred turn bootstrap when present. */
  outlineBody: z.string().min(1).optional(),
  choices: z.array(z.object({
    label: z.string().min(1),
    action: z.enum(["start_turn", "continue_discuss", "promote_staging", "confirm_arc_plan"]),
  })).optional(),
  goalProposals: z.array(synopsisDiscussGoalProposalSchema).optional(),
  stagingDelta: synopsisStagingDeltaSchema.optional(),
  stagingPromote: synopsisStagingPromoteArtifactSchema.optional(),
  /** Create or overwrite 描写/笔风规则 Markdown; applied immediately (not 设定集 promote). */
  presentationWrites: z.array(synopsisPresentationWriteSchema).min(1).max(20).optional(),
  arcPlan: z.object({
    markdown: z.string().min(1).max(20_000),
    estimatedChapterCount: z.number().int().positive().max(50).optional(),
    estimatedWordRange: z.string().min(1).max(100).optional(),
    chapterBeats: z.array(z.object({
      sequenceOffset: z.number().int().nonnegative().max(50),
      purpose: z.string().min(1).max(500),
    })).max(30).optional(),
  }).optional(),
  finalSelfReview: z.string().min(1),
})

export const settingsExtractionArtifactSchema = z.object({
  summary: z.string().min(1),
  proposals: z.array(z.object({
    payload: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("create"),
        relativePath: z.string().min(1),
        markdown: z.string().min(1),
        readmeEntry: z.string().max(500).optional(),
      }),
      z.object({
        kind: z.literal("update"),
        relativePath: z.string().min(1),
        markdown: z.string().min(1),
      }),
      z.object({
        kind: z.literal("merge"),
        targetPath: z.string().min(1),
        markdown: z.string().min(1),
        mergedFromPaths: z.array(z.string().min(1)).min(1),
      }),
    ]),
    reason: z.string().max(1_000).optional(),
    conflictNotes: z.string().max(2_000).optional(),
  })),
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
  settings_extraction: settingsExtractionArtifactSchema,
  response_review: responseReviewArtifactSchema,
  graph_governance: graphGovernanceArtifactSchema,
  graph_structure_plan: graphStructurePlanArtifactSchema,
  graph_capacity_rewrite: graphCapacityRewriteArtifactSchema,
  graph_spacetime_settlement: graphSpacetimeSettlementArtifactSchema,
  graph_retrieval_design: graphRetrievalDesignArtifactSchema,
  graph_governance_review: graphGovernanceReviewArtifactSchema,
  semantic_review: semanticReviewArtifactSchema,
  settlement_review: settlementReviewArtifactSchema,
  frontier_settlement: frontierSettlementArtifactSchema,
  commit_review: commitReviewArtifactSchema,
  revision_review: revisionReviewArtifactSchema,
  revision_assist: revisionAssistArtifactSchema,
  synopsis_discuss: synopsisDiscussArtifactSchema,
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
export type GraphStructurePlanArtifact = z.infer<typeof graphStructurePlanArtifactSchema>
export type GraphCapacityRewriteArtifact = z.infer<typeof graphCapacityRewriteArtifactSchema>
export type GraphSpacetimeSettlementArtifact = z.infer<typeof graphSpacetimeSettlementArtifactSchema>
export type GraphRetrievalDesignArtifact = z.infer<typeof graphRetrievalDesignArtifactSchema>
export type GraphGovernanceReviewArtifact = z.infer<typeof graphGovernanceReviewArtifactSchema>
export type SemanticReviewArtifact = z.infer<typeof semanticReviewArtifactSchema>
export type SettlementReviewArtifact = z.infer<typeof settlementReviewArtifactSchema>
export type FrontierSettlementArtifact = z.infer<typeof frontierSettlementArtifactSchema>
export type CommitReviewArtifact = z.infer<typeof commitReviewArtifactSchema>
export type RevisionReviewArtifact = z.infer<typeof revisionReviewArtifactSchema>
export type RevisionAssistArtifact = z.infer<typeof revisionAssistArtifactSchema>
export type SynopsisDiscussArtifact = z.infer<typeof synopsisDiscussArtifactSchema>
export type SynopsisPresentationWrite = z.infer<typeof synopsisPresentationWriteSchema>
export type SettingsExtractionArtifact = z.infer<typeof settingsExtractionArtifactSchema>
