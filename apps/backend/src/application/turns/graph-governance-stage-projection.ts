import type { AIPhase } from "@worldseed/contracts"
import {
  commitReviewProjectionSchema,
  dependencyAuditArtifactSchema,
  frontierSettlementArtifactSchema,
  frontierSettlementProjectionSchema,
  graphGovernanceArtifactSchema,
  graphGovernanceReviewArtifactSchema,
  graphGovernanceReviewProjectionSchema,
  graphRetrievalDesignArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  graphStructurePlanArtifactSchema,
  semanticReviewArtifactSchema,
  settlementReviewArtifactSchema,
  settlementReviewProjectionSchema,
  type CommitReviewProjection,
  type FrontierSettlementProjection,
  type GraphGovernanceReviewProjection,
  type SettlementReviewProjection,
  type StageProjection,
} from "@worldseed/prompt-contracts"

import { digest } from "../../core/index.js"
import type { VerificationProbeExecution } from "./ports/index.js"

type PhaseArtifacts = Partial<Record<AIPhase, unknown>>

type ProjectionInput = Readonly<{
  scopeId: string
  artifacts: PhaseArtifacts
  readEvidence?: readonly Readonly<{
    ownerKind?: unknown
    ownerId?: unknown
    sourceRefs?: readonly unknown[]
  }>[]
}>

export function buildStageProjection(
  input: ProjectionInput & Readonly<{
    phase: AIPhase
    sourceUnitCount: number
    verificationProbeExecutions: readonly VerificationProbeExecution[]
  }>,
): StageProjection | undefined {
  switch (input.phase) {
    case "graph_governance_review": return buildGraphGovernanceReviewProjection(input)
    case "settlement_review": return buildSettlementReviewProjection(input)
    case "frontier_settlement": return buildFrontierSettlementProjection(input)
    case "commit_review": return buildCommitReviewProjection(input)
    default: return undefined
  }
}

export function buildGraphGovernanceReviewProjection(
  input: ProjectionInput & Readonly<{
    sourceUnitCount: number
    verificationProbeExecutions: readonly VerificationProbeExecution[]
  }>,
): GraphGovernanceReviewProjection {
  const dependency = dependencyAuditArtifactSchema.parse(requiredArtifact(input.artifacts, "dependency_audit"))
  const structure = graphStructurePlanArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_structure_plan"))
  const spacetime = graphSpacetimeSettlementArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_spacetime_settlement"))
  const retrieval = graphRetrievalDesignArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_retrieval_design"))
  const uncoveredSourceUnitIndexes = expectedIndexes(input.sourceUnitCount).filter((sourceUnitIndex) => (
    !retrieval.sourceSettlements.some((settlement) => (
      settlement.sourceUnitIndex === sourceUnitIndex && settlement.graphRefs.length > 0
    ))
  ))
  const core = {
    kind: "graph_governance_review" as const,
    ...projectionBase(input.scopeId, input.artifacts, [
      "dependency_audit",
      "graph_structure_plan",
      "graph_spacetime_settlement",
      "graph_retrieval_design",
    ]),
    proposals: structure.proposals,
    decisionRecords: structure.decisionRecords,
    sceneSpacetimeBindings: spacetime.sceneSpacetimeBindings,
    proposalSettlements: spacetime.proposalSettlements,
    retrievalProjections: retrieval.projections,
    sourceSettlements: retrieval.sourceSettlements,
    affectedFrontierRefs: structure.affectedFrontierRefs,
    archiveOutletRefs: structure.archiveOutletRefs,
    temporalClaims: dependency.temporalClaims,
    temporalClaimSettlements: spacetime.temporalClaimSettlements,
    verificationProbeExecutions: input.verificationProbeExecutions,
    mechanicalChecks: {
      capacitySatisfied: true,
      sourceReturnComplete: uncoveredSourceUnitIndexes.length === 0,
      referenceIntegrity: true,
    },
  }
  return graphGovernanceReviewProjectionSchema.parse(withProjectionDigest(core))
}

export function buildSettlementReviewProjection(
  input: ProjectionInput & Readonly<{ sourceUnitCount: number }>,
): SettlementReviewProjection {
  const governance = graphGovernanceArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_governance"))
  const retrieval = graphRetrievalDesignArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_retrieval_design"))
  const sourceCoverage = governance.settlementRecords.map((record) => ({
    sourceUnitIndex: record.sourceUnitIndex,
    sceneIndexes: governance.sceneSpacetimeBindings
      .filter((binding) => binding.sourceUnitIndexes.includes(record.sourceUnitIndex))
      .map((binding) => binding.sceneIndex),
    proposalRefs: [],
    graphRefs: record.graphRefs.map((reference) => reference.targetRef),
  }))
  const uncoveredSourceUnitIndexes = expectedIndexes(input.sourceUnitCount).filter((sourceUnitIndex) => (
    !sourceCoverage.some((coverage) => coverage.sourceUnitIndex === sourceUnitIndex && coverage.graphRefs.length > 0)
  ))
  const core = {
    kind: "settlement_review" as const,
    ...projectionBase(input.scopeId, input.artifacts, [
      "dependency_audit",
      "graph_governance",
      "semantic_review",
    ]),
    sourceCoverage,
    sceneCoverage: governance.sceneSpacetimeBindings.map((binding) => ({
      sceneIndexes: [binding.sceneIndex],
      proposalRefs: [],
      graphRefs: [
        binding.sceneAnchorRef,
        ...binding.timeAnchorRefs,
        ...binding.locationAnchorRefs,
      ],
    })),
    proposalCoverage: governance.mutationSpacetimeSettlements.map((settlement) => ({
      sceneIndexes: settlement.effectiveSceneBindingIndexes,
      proposalRefs: settlement.mutationIndexes.map((index) => `proposal:mutation:${String(index + 1)}`),
      graphRefs: [...settlement.currentEntryRefs, ...settlement.historicalReturnRefs],
    })),
    retrievalCoverage: retrieval.sourceSettlements.map((settlement) => ({
      sourceUnitIndex: settlement.sourceUnitIndex,
      sceneIndexes: [],
      proposalRefs: settlement.graphRefs.flatMap((reference) => reference.proposalRef === undefined ? [] : [reference.proposalRef]),
      graphRefs: settlement.graphRefs.map((reference) => reference.targetRef),
    })),
    uncoveredSourceUnitIndexes,
    mechanicalChecks: {
      sourceCoverageComplete: uncoveredSourceUnitIndexes.length === 0,
      spacetimeCoverageComplete: governance.sceneSpacetimeBindings.length > 0 || input.sourceUnitCount === 0,
      retrievalCoverageComplete: retrieval.sourceSettlements.length === input.sourceUnitCount,
    },
  }
  return settlementReviewProjectionSchema.parse(withProjectionDigest(core))
}

export function buildFrontierSettlementProjection(input: ProjectionInput): FrontierSettlementProjection {
  const governance = graphGovernanceArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_governance"))
  const semantic = semanticReviewArtifactSchema.parse(requiredArtifact(input.artifacts, "semantic_review"))
  const approvedSceneBindings = semantic.approvedSpacetimeBindingIndexes.flatMap((index) => {
    const binding = governance.sceneSpacetimeBindings[index]
    return binding === undefined ? [] : [binding]
  })
  const core = {
    kind: "frontier_settlement" as const,
    ...projectionBase(input.scopeId, input.artifacts, ["graph_governance", "semantic_review", "settlement_review"]),
    affectedFrontierRefs: semantic.approvedAffectedFrontierRefs,
    approvedSceneBindings,
    archiveOutletRefs: governance.archiveOutletRefs,
    correspondenceRefs: [...new Set(approvedSceneBindings.flatMap((binding) => binding.correspondenceRefs))],
    priorFrontierStates: readPriorFrontierStates(input.readEvidence ?? [], semantic.approvedAffectedFrontierRefs),
  }
  return frontierSettlementProjectionSchema.parse(withProjectionDigest(core))
}

export function readPriorFrontierStates(
  readEvidence: readonly Readonly<{
    ownerKind?: unknown
    ownerId?: unknown
    sourceRefs?: readonly unknown[]
  }>[],
  affectedFrontierRefs: readonly string[],
): Array<{
  frontierAnchorRef: string
  lastSceneAnchorRefs: string[]
  lastTimeAnchorRefs: string[]
  lastLocationAnchorRefs: string[]
  correspondenceRefs: string[]
}> {
  const affected = new Set(affectedFrontierRefs)
  const states = new Map<string, {
    frontierAnchorRef: string
    lastSceneAnchorRefs: string[]
    lastTimeAnchorRefs: string[]
    lastLocationAnchorRefs: string[]
    correspondenceRefs: string[]
  }>()
  for (const evidence of readEvidence) {
    if (evidence.ownerKind !== "frontier" || typeof evidence.ownerId !== "string" || !affected.has(evidence.ownerId)) continue
    for (const sourceRef of evidence.sourceRefs ?? []) {
      if (!isRecord(sourceRef) || sourceRef.frontierAnchorRef !== evidence.ownerId) continue
      const state = parsePriorFrontierState(sourceRef)
      if (state !== undefined) states.set(state.frontierAnchorRef, state)
    }
  }
  return [...states.values()].sort((left, right) => left.frontierAnchorRef.localeCompare(right.frontierAnchorRef))
}

function parsePriorFrontierState(value: unknown): {
  frontierAnchorRef: string
  lastSceneAnchorRefs: string[]
  lastTimeAnchorRefs: string[]
  lastLocationAnchorRefs: string[]
  correspondenceRefs: string[]
} | undefined {
  if (!isRecord(value) || typeof value.frontierAnchorRef !== "string") return undefined
  const arrays = [
    value.lastSceneAnchorRefs,
    value.lastTimeAnchorRefs,
    value.lastLocationAnchorRefs,
    value.correspondenceRefs,
  ]
  if (!arrays.every((candidate) => Array.isArray(candidate) && candidate.every((item) => typeof item === "string"))) return undefined
  return {
    frontierAnchorRef: value.frontierAnchorRef,
    lastSceneAnchorRefs: value.lastSceneAnchorRefs as string[],
    lastTimeAnchorRefs: value.lastTimeAnchorRefs as string[],
    lastLocationAnchorRefs: value.lastLocationAnchorRefs as string[],
    correspondenceRefs: value.correspondenceRefs as string[],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function buildCommitReviewProjection(input: ProjectionInput): CommitReviewProjection {
  const dependency = dependencyAuditArtifactSchema.parse(requiredArtifact(input.artifacts, "dependency_audit"))
  const governance = graphGovernanceArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_governance"))
  const governanceReview = graphGovernanceReviewArtifactSchema.parse(requiredArtifact(input.artifacts, "graph_governance_review"))
  const settlementReview = settlementReviewArtifactSchema.parse(requiredArtifact(input.artifacts, "settlement_review"))
  const frontierSettlement = frontierSettlementArtifactSchema.parse(requiredArtifact(input.artifacts, "frontier_settlement"))
  const claimByRef = new Map(dependency.temporalClaims.map((claim) => [claim.claimRef, claim]))
  const continuityAdvice = governanceReview.temporalClaimAssessments.flatMap((assessment) => {
    const claim = claimByRef.get(assessment.claimRef)
    if (claim === undefined) return []
    return [{
      claimRef: assessment.claimRef,
      proseExcerpt: claim.proseExcerpt,
      verdict: assessment.verdict,
      summary: assessment.reason,
      evidenceRefs: assessment.evidenceRefs,
      ...(assessment.advice === undefined ? {} : { suggestedDirection: assessment.advice }),
    }]
  })
  const sourcePhases: AIPhase[] = [
    "dependency_audit",
    "graph_governance_review",
    "settlement_review",
    "frontier_settlement",
  ]
  const core = {
    kind: "commit_review" as const,
    ...projectionBase(input.scopeId, input.artifacts, sourcePhases),
    stageChain: sourcePhases.map((phase) => ({
      phase,
      artifactDigest: digest(requiredArtifact(input.artifacts, phase)),
      outcome: "completed",
    })),
    governanceConclusion: {
      recommendation: governanceReview.recommendation,
      issueCount: governanceReview.issues.length,
    },
    settlementConclusion: {
      complete: settlementReview.sourceReturnComplete
        && settlementReview.retrievalProjectionComplete
        && settlementReview.semanticCoverageComplete
        && settlementReview.spacetimeBindingsComplete
        && settlementReview.mutationSpacetimeSettlementsComplete,
      uncoveredSourceUnitIndexes: settlementReview.uncoveredSourceUnitIndexes,
    },
    frontierConclusion: { frontierCount: frontierSettlement.frontiers.length },
    continuityAdvice,
    pendingWriteSummary: {
      mutationCount: governance.mutations.length,
      sourceSettlementCount: governance.settlementRecords.length,
      frontierCount: frontierSettlement.frontiers.length,
    },
    mechanicalInvariants: {
      referenceIntegrity: true,
      digestAligned: true,
      finalizationReady: true,
    },
    risks: [
      ...governanceReview.issues.map((issue) => issue.summary),
      ...continuityAdvice.filter((advice) => advice.verdict !== "pass").map((advice) => advice.summary),
    ],
  }
  return commitReviewProjectionSchema.parse(withProjectionDigest(core))
}

function projectionBase(
  scopeId: string,
  artifacts: PhaseArtifacts,
  phases: readonly AIPhase[],
): Readonly<{
  version: 1
  sourceArtifactDigests: Record<string, string>
  pendingScope: Readonly<{ scopeId: string; candidateDigest: string }>
  unresolvedIssues: readonly string[]
}> {
  const sourceArtifactDigests = Object.fromEntries(phases.map((phase) => [
    phase,
    digest(requiredArtifact(artifacts, phase)),
  ]))
  return {
    version: 1,
    sourceArtifactDigests,
    pendingScope: {
      scopeId,
      candidateDigest: digest(sourceArtifactDigests),
    },
    unresolvedIssues: [],
  }
}

function withProjectionDigest<T extends object>(projection: T): T & Readonly<{ projectionDigest: string }> {
  return { ...projection, projectionDigest: digest(projection) }
}

function requiredArtifact(artifacts: PhaseArtifacts, phase: AIPhase): unknown {
  const artifact = artifacts[phase]
  if (artifact === undefined) throw new Error(`Missing ${phase} artifact for stage projection`)
  return artifact
}

function expectedIndexes(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}
