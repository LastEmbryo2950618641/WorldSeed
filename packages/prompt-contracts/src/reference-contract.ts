import type { AIPhase } from "@worldseed/contracts"

import {
  commitReviewArtifactSchema,
  dependencyAuditArtifactSchema,
  emergencePlanningArtifactSchema,
  frontierSettlementArtifactSchema,
  graphGovernanceArtifactSchema,
  graphGovernanceReviewArtifactSchema,
  graphRetrievalDesignArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  graphStructurePlanArtifactSchema,
  ruleAssemblyArtifactSchema,
  semanticReviewArtifactSchema,
  type GraphGovernanceArtifact,
} from "./phase-schemas/artifacts.js"
import { frontierSettlementProjectionSchema } from "./stage-projections.js"

export type PhaseReferenceVisibility = Readonly<{
  readableGraphIds: ReadonlySet<string>
  readableEvidenceIds: ReadonlySet<string>
  readableWorkspacePaths: ReadonlySet<string>
  declaredLocalGraphRefs?: ReadonlySet<string>
}>

export function assertPhaseReferenceContract(
  phase: AIPhase,
  artifact: unknown,
  visibility: PhaseReferenceVisibility,
): void {
  if (phase === "rule_assembly") {
    const rules = ruleAssemblyArtifactSchema.parse(artifact)
    const unreadPaths = rules.selectedWorkspacePaths.filter((path) => !visibility.readableWorkspacePaths.has(path))
    if (unreadPaths.length > 0) {
      throw new Error(`selectedWorkspacePaths contains files not read in this turn: ${unreadPaths.join(", ")}`)
    }
    return
  }

  if (phase === "emergence_planning") {
    const planning = emergencePlanningArtifactSchema.parse(artifact)
    const graphReferences = planning.decisions.flatMap((decision) => [
      ...decision.existingAnchorRefs,
      ...decision.timeAnchorRefs,
      ...decision.locationAnchorRefs,
      ...decision.informationBoundaryRefs,
    ])
    assertReadableGraphReferences(graphReferences, visibility.readableGraphIds)
    return
  }

  if (phase === "dependency_audit") {
    const dependency = dependencyAuditArtifactSchema.parse(artifact)
    assertReadableEvidenceReferences(
      dependency.temporalClaims.flatMap((claim) => claim.evidenceRefs),
      visibility.readableEvidenceIds,
    )
    assertReadableGraphReferences(
      dependency.temporalClaims.flatMap((claim) => [...claim.referenceRefs, ...claim.timelineRefs]),
      visibility.readableGraphIds,
    )
    return
  }

  if (phase === "graph_governance") {
    assertGraphGovernanceReferenceContract(artifact, visibility.readableGraphIds, visibility.readableEvidenceIds)
    return
  }

  if (phase === "graph_structure_plan") {
    const structure = graphStructurePlanArtifactSchema.parse(artifact)
    assertGraphGovernanceReferenceContract({
      mutations: structure.proposals.map((proposal) => proposal.mutation),
      retrievalProjections: [],
      settlementRecords: [],
      mutationSpacetimeSettlements: [],
      sceneSpacetimeBindings: [],
      affectedFrontierRefs: structure.affectedFrontierRefs,
      archiveOutletRefs: structure.archiveOutletRefs,
      decisionRecords: [],
    }, visibility.readableGraphIds, visibility.readableEvidenceIds)
    return
  }

  if (phase === "graph_spacetime_settlement") {
    const settlement = graphSpacetimeSettlementArtifactSchema.parse(artifact)
    const readableGraphIds = new Set([
      ...visibility.readableGraphIds,
      ...(visibility.declaredLocalGraphRefs ?? []),
    ])
    assertReadableGraphReferences([
      ...settlement.sceneSpacetimeBindings.flatMap((binding) => [
        binding.sceneAnchorRef,
        ...binding.temporalReferenceRefs,
        ...binding.timeAnchorRefs,
        ...binding.spatialReferenceRefs,
        ...binding.locationAnchorRefs,
        ...binding.predecessorSceneAnchorRefs,
        ...binding.transitionPathRefs,
        ...binding.correspondenceRefs,
      ]),
      ...settlement.proposalSettlements.flatMap((entry) => [
        ...entry.effectiveExistingSceneAnchorRefs,
        ...entry.currentEntryRefs,
        ...entry.historicalReturnRefs,
      ]),
      ...settlement.temporalClaimSettlements.flatMap((entry) => [
        ...entry.referenceRefs,
        ...entry.timeAnchorRefs,
        ...entry.timelineRefs,
        ...entry.correspondenceRefs,
        ...entry.historicalReturnRefs,
      ]),
    ], readableGraphIds)
    assertReadableEvidenceReferences(
      settlement.proposalSettlements.flatMap((entry) => entry.predecessorRevisionReadRefs),
      visibility.readableEvidenceIds,
    )
    return
  }

  if (phase === "graph_retrieval_design") {
    const retrieval = graphRetrievalDesignArtifactSchema.parse(artifact)
    const readableGraphIds = new Set([
      ...visibility.readableGraphIds,
      ...(visibility.declaredLocalGraphRefs ?? []),
    ])
    const references = [
      ...retrieval.projections.flatMap((projection) => projection.ownerRef === undefined ? [] : [projection.ownerRef]),
      ...retrieval.sourceSettlements.flatMap((settlement) => (
        settlement.graphRefs.map((reference) => reference.targetRef)
      )),
    ]
    const invalidReferences = references.filter((reference) => !readableGraphIds.has(reference))
    if (invalidReferences.length > 0) {
      throw new Error(`Graph retrieval references must be readable graph owners or declared local handles: ${[...new Set(invalidReferences)].join(", ")}`)
    }
    return
  }

  if (phase === "semantic_review") {
    semanticReviewArtifactSchema.parse(artifact)
    return
  }


  if (phase === "graph_governance_review") {
    const review = graphGovernanceReviewArtifactSchema.parse(artifact)
    assertReadableEvidenceReferences(
      review.temporalClaimAssessments.flatMap((assessment) => assessment.evidenceRefs),
      visibility.readableEvidenceIds,
    )
    return
  }

  if (phase === "commit_review") {
    const review = commitReviewArtifactSchema.parse(artifact)
    assertReadableEvidenceReferences(
      review.continuityAdvice.flatMap((advice) => advice.evidenceRefs),
      visibility.readableEvidenceIds,
    )
    return
  }

  if (phase === "frontier_settlement") {
    const settlement = frontierSettlementArtifactSchema.parse(artifact)
    assertReadableGraphReferences(
      settlement.frontiers.flatMap((frontier) => [
        frontier.frontierAnchorRef,
        ...frontier.lastSceneAnchorRefs,
        ...frontier.lastTimeAnchorRefs,
        ...frontier.lastLocationAnchorRefs,
        ...frontier.correspondenceRefs,
      ]),
      new Set([
        ...visibility.readableGraphIds,
        ...(visibility.declaredLocalGraphRefs ?? []),
      ]),
    )
  }
}

export function assertGraphGovernanceReferenceContract(
  artifact: unknown,
  readableGraphIds: ReadonlySet<string>,
  readableEvidenceIds: ReadonlySet<string> = new Set(),
): GraphGovernanceArtifact {
  const governance = graphGovernanceArtifactSchema.parse(artifact)
  const declaredLocalRefs = new Set(governance.mutations.flatMap((mutation) => (
    mutation.operation === "create_node" || mutation.operation === "create_link" ? [mutation.ref] : []
  )))
  if (declaredLocalRefs.size !== governance.mutations.filter((mutation) => (
    mutation.operation === "create_node" || mutation.operation === "create_link"
  )).length) {
    throw new Error("Graph governance contains duplicate local handles")
  }

  const references = collectGraphGovernanceReferences(governance)
  const invalidReferences = references.graph.filter((reference) => (
    !readableGraphIds.has(reference) && !declaredLocalRefs.has(reference)
  ))
  if (invalidReferences.length > 0) {
    throw new Error(`Graph governance references must be readable graph owners or declared local handles: ${[...new Set(invalidReferences)].join(", ")}`)
  }
  assertReadableEvidenceReferences(references.evidence, readableEvidenceIds)
  return governance
}

export function assertSpacetimeGovernanceCoverage(
  dependencyInput: unknown,
  governanceInput: unknown,
  sourceUnitCount: number,
): void {
  const dependency = dependencyAuditArtifactSchema.parse(dependencyInput)
  const governance = graphGovernanceArtifactSchema.parse(governanceInput)
  assertSceneSpacetimeCoverage(dependency, governance.sceneSpacetimeBindings, sourceUnitCount)

  if (sourceUnitCount > 0) {
    assertExactIndexSet(
      governance.settlementRecords.map((record) => record.sourceUnitIndex),
      sourceUnitCount,
      "Source unit settlement records",
    )
    const emptySettlements = governance.settlementRecords
      .filter((record) => record.graphRefs.length === 0)
      .map((record) => record.sourceUnitIndex)
    if (emptySettlements.length > 0) {
      throw new Error(`Source unit settlement records require a graph return path: ${emptySettlements.join(", ")}`)
    }
  }

  const coveredMutationIndexes = governance.mutationSpacetimeSettlements.flatMap((settlement) => settlement.mutationIndexes)
  assertExactIndexSet(coveredMutationIndexes, governance.mutations.length, "Mutation spacetime settlements")
  for (const settlement of governance.mutationSpacetimeSettlements) {
    assertIndexesInRange(settlement.effectiveSceneBindingIndexes, governance.sceneSpacetimeBindings.length, "Effective scene binding")
  }
  for (const decision of governance.decisionRecords) {
    assertIndexesInRange(decision.mutationIndexes, governance.mutations.length, "Decision mutation")
    assertIndexesInRange(
      decision.mutationSpacetimeSettlementIndexes,
      governance.mutationSpacetimeSettlements.length,
      "Decision mutation spacetime settlement",
    )
  }
}

export function assertGraphSpacetimeSettlementCoverage(
  dependencyInput: unknown,
  structureInput: unknown,
  settlementInput: unknown,
  sourceUnitCount: number,
): void {
  const dependency = dependencyAuditArtifactSchema.parse(dependencyInput)
  const structure = graphStructurePlanArtifactSchema.parse(structureInput)
  const settlement = graphSpacetimeSettlementArtifactSchema.parse(settlementInput)
  assertSceneSpacetimeCoverage(dependency, settlement.sceneSpacetimeBindings, sourceUnitCount)
  assertExactReferenceSet(
    settlement.proposalSettlements.flatMap((entry) => entry.proposalRefs),
    structure.proposals.map((proposal) => proposal.proposalRef),
    "Proposal spacetime settlements",
  )
  for (const entry of settlement.proposalSettlements) {
    assertIndexesInRange(entry.effectiveSceneBindingIndexes, settlement.sceneSpacetimeBindings.length, "Effective scene binding")
  }
  assertExactReferenceSet(
    settlement.temporalClaimSettlements.map((entry) => entry.claimRef),
    dependency.temporalClaims.map((claim) => claim.claimRef),
    "Temporal claim settlements",
  )
  assertTemporalClaimSceneIndexes(dependency.temporalClaims, settlement.temporalClaimSettlements)
}

export function assertTemporalClaimCoverage(
  dependencyInput: unknown,
  settlementInput: unknown,
  reviewInput: unknown,
): void {
  const dependency = dependencyAuditArtifactSchema.parse(dependencyInput)
  const settlement = graphSpacetimeSettlementArtifactSchema.parse(settlementInput)
  const review = graphGovernanceReviewArtifactSchema.parse(reviewInput)
  const claimRefs = dependency.temporalClaims.map((claim) => claim.claimRef)
  assertExactReferenceSet(
    settlement.temporalClaimSettlements.map((entry) => entry.claimRef),
    claimRefs,
    "Temporal claim settlements",
  )
  assertTemporalClaimSceneIndexes(dependency.temporalClaims, settlement.temporalClaimSettlements)
  assertExactReferenceSet(
    review.temporalClaimAssessments.map((entry) => entry.claimRef),
    claimRefs,
    "Temporal claim assessments",
  )
}

function assertTemporalClaimSceneIndexes(
  claims: ReturnType<typeof dependencyAuditArtifactSchema.parse>["temporalClaims"],
  settlements: ReturnType<typeof graphSpacetimeSettlementArtifactSchema.parse>["temporalClaimSettlements"],
): void {
  const expectedByClaim = new Map(claims.map((claim) => [claim.claimRef, claim.sceneIndex]))
  for (const settlement of settlements) {
    const expectedSceneIndex = expectedByClaim.get(settlement.claimRef)
    if (expectedSceneIndex !== undefined && settlement.sceneIndex !== expectedSceneIndex) {
      throw new Error(`Temporal claim ${settlement.claimRef} requires scene index ${String(expectedSceneIndex)}; received ${String(settlement.sceneIndex)}`)
    }
  }
}

export function assertCommitReviewCoversTemporalClaims(
  governanceReviewInput: unknown,
  commitReviewInput: unknown,
): void {
  const governanceReview = graphGovernanceReviewArtifactSchema.parse(governanceReviewInput)
  const commitReview = commitReviewArtifactSchema.parse(commitReviewInput)
  assertExactReferenceSet(
    commitReview.continuityAdvice.map((advice) => advice.claimRef),
    governanceReview.temporalClaimAssessments.map((assessment) => assessment.claimRef),
    "Commit continuity advice",
  )
}

function assertSceneSpacetimeCoverage(
  dependency: ReturnType<typeof dependencyAuditArtifactSchema.parse>,
  bindings: ReturnType<typeof graphSpacetimeSettlementArtifactSchema.parse>["sceneSpacetimeBindings"],
  sourceUnitCount: number,
): void {
  assertExactIndexSet(
    dependency.sceneContinuity.map((scene) => scene.sceneIndex),
    dependency.sceneContinuity.length,
    "Dependency audit scene inventory",
  )
  assertExactIndexSet(
    bindings.map((binding) => binding.sceneIndex),
    dependency.sceneContinuity.length,
    "Scene spacetime bindings",
  )

  for (const binding of bindings) {
    const scene = dependency.sceneContinuity[binding.sceneIndex]
    if (scene === undefined) throw new Error(`Scene binding index is outside the dependency inventory: ${String(binding.sceneIndex)}`)
    assertSameSet(binding.predecessorSceneIndexes, scene.predecessorSceneIndexes, `Scene ${String(binding.sceneIndex)} predecessor indexes`)
    if (scene.predecessorRequired
      && binding.predecessorSceneIndexes.length === 0
      && binding.predecessorSceneAnchorRefs.length === 0) {
      throw new Error(`Scene ${String(binding.sceneIndex)} requires a predecessor`)
    }
    if (scene.predecessorRequired && binding.transitionPathRefs.length === 0) {
      throw new Error(`Scene ${String(binding.sceneIndex)} requires a transition path`)
    }
    if (scene.correspondenceRequired && binding.correspondenceRefs.length === 0) {
      throw new Error(`Scene ${String(binding.sceneIndex)} requires a correspondence structure`)
    }
    if (sourceUnitCount > 0 && binding.sourceUnitIndexes.length === 0) {
      throw new Error(`Narrative scene ${String(binding.sceneIndex)} must cover source units`)
    }
    if (sourceUnitCount === 0 && binding.sourceUnitIndexes.length > 0) {
      throw new Error(`Background scene ${String(binding.sceneIndex)} cannot reference narrative source units`)
    }
  }

  if (sourceUnitCount > 0) {
    assertExactIndexSet(
      bindings.flatMap((binding) => binding.sourceUnitIndexes),
      sourceUnitCount,
      "Scene source coverage",
    )
  }
}

export function assertSemanticReviewCoversGovernance(
  governanceInput: unknown,
  reviewInput: unknown,
): void {
  const governance = graphGovernanceArtifactSchema.parse(governanceInput)
  const review = semanticReviewArtifactSchema.parse(reviewInput)
  assertAdvisoryIndexDecisions(
    review.approvedMutationIndexes,
    review.rejectedMutationIndexes,
    governance.mutations.length,
    "graph mutation",
  )
  assertAdvisoryIndexDecisions(
    review.approvedSpacetimeBindingIndexes,
    review.rejectedSpacetimeBindingIndexes,
    governance.sceneSpacetimeBindings.length,
    "scene spacetime binding",
  )
  assertAdvisoryIndexDecisions(
    review.approvedMutationSpacetimeSettlementIndexes,
    review.rejectedMutationSpacetimeSettlementIndexes,
    governance.mutationSpacetimeSettlements.length,
    "mutation spacetime settlement",
  )
  assertAdvisoryReferenceDecisions(
    review.approvedAffectedFrontierRefs,
    review.rejectedAffectedFrontierRefs,
    governance.affectedFrontierRefs,
    "affected frontier",
  )
}

export function assertFrontierSettlementCoversReview(
  reviewInput: unknown,
  settlementInput: unknown,
  governanceInput?: unknown,
  projectionInput?: unknown,
): void {
  const review = semanticReviewArtifactSchema.parse(reviewInput)
  const settlement = frontierSettlementArtifactSchema.parse(settlementInput)
  assertExactReferenceSet(
    settlement.frontiers.map((frontier) => frontier.frontierAnchorRef),
    review.approvedAffectedFrontierRefs,
    "frontier settlement",
  )
  if (governanceInput === undefined) return
  const governance = graphGovernanceArtifactSchema.parse(governanceInput)
  const approvedSceneBindings = review.approvedSpacetimeBindingIndexes.map((index) => governance.sceneSpacetimeBindings[index])
  const allowedSceneAnchors = new Set(approvedSceneBindings.map((binding) => binding?.sceneAnchorRef).filter(isString))
  const allowedTimeAnchors = new Set(approvedSceneBindings.flatMap((binding) => binding?.timeAnchorRefs ?? []))
  const allowedLocationAnchors = new Set(approvedSceneBindings.flatMap((binding) => binding?.locationAnchorRefs ?? []))
  const priorFrontierStates = projectionInput === undefined
    ? []
    : frontierSettlementProjectionSchema.parse(projectionInput).priorFrontierStates
  const priorStateByFrontier = new Map(priorFrontierStates.map((state) => [state.frontierAnchorRef, state]))
  for (const frontier of settlement.frontiers) {
    const priorState = priorStateByFrontier.get(frontier.frontierAnchorRef)
    assertReferencesBelongTo(
      frontier.lastSceneAnchorRefs,
      approvedSceneBindings.length === 0 ? new Set(priorState?.lastSceneAnchorRefs ?? []) : allowedSceneAnchors,
      approvedSceneBindings.length === 0
        ? "Frontier scene anchors must reuse this frontier's previously read anchors"
        : "Frontier scene anchors must come from approved spacetime bindings",
    )
    assertReferencesBelongTo(
      frontier.lastTimeAnchorRefs,
      approvedSceneBindings.length === 0 ? new Set(priorState?.lastTimeAnchorRefs ?? []) : allowedTimeAnchors,
      approvedSceneBindings.length === 0
        ? "Frontier time anchors must reuse this frontier's previously read anchors"
        : "Frontier time anchors must come from approved spacetime bindings",
    )
    assertReferencesBelongTo(
      frontier.lastLocationAnchorRefs,
      approvedSceneBindings.length === 0 ? new Set(priorState?.lastLocationAnchorRefs ?? []) : allowedLocationAnchors,
      approvedSceneBindings.length === 0
        ? "Frontier location anchors must reuse this frontier's previously read anchors"
        : "Frontier location anchors must come from approved spacetime bindings",
    )
  }
}

function assertReferencesBelongTo(references: readonly string[], allowed: ReadonlySet<string>, message: string): void {
  const invalid = references.filter((reference) => !allowed.has(reference))
  if (invalid.length > 0) throw new Error(`${message}: ${[...new Set(invalid)].join(", ")}`)
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function assertExactReferenceSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter((reference) => !actualSet.has(reference))
  const extra = [...actualSet].filter((reference) => !expectedSet.has(reference))
  if (actual.length !== expected.length || actualSet.size !== actual.length || missing.length > 0 || extra.length > 0) {
    throw new Error([
      `${label} must contain every approved reference exactly once`,
      `missing=[${missing.join(",")}]`,
      `extra=[${extra.join(",")}]`,
    ].join("; "))
  }
}

function assertReadableGraphReferences(
  references: readonly string[],
  readableGraphIds: ReadonlySet<string>,
): void {
  const invalidReferences = references.filter((reference) => !readableGraphIds.has(reference))
  if (invalidReferences.length > 0) {
    throw new Error(`Graph references must be owner IDs read in this turn: ${[...new Set(invalidReferences)].join(", ")}`)
  }
}

function assertReadableEvidenceReferences(
  references: readonly string[],
  readableEvidenceIds: ReadonlySet<string>,
): void {
  const invalidReferences = references.filter((reference) => !readableEvidenceIds.has(reference))
  if (invalidReferences.length > 0) {
    throw new Error(`Read evidence references must belong to this turn: ${[...new Set(invalidReferences)].join(", ")}`)
  }
}

function collectGraphGovernanceReferences(governance: GraphGovernanceArtifact): { graph: string[]; evidence: string[] } {
  const graph: string[] = []
  for (const mutation of governance.mutations) {
    switch (mutation.operation) {
      case "create_node":
        collectEmbeddedLocalReferences(mutation.data, graph)
        break
      case "edit_node":
        graph.push(mutation.nodeRef)
        collectEmbeddedLocalReferences(mutation.next, graph)
        break
      case "retire_node":
        graph.push(mutation.nodeRef, ...mutation.archiveOutletRefs)
        break
      case "create_link":
        graph.push(mutation.fromRef, mutation.toRef)
        collectEmbeddedLocalReferences(mutation.content, graph)
        collectEmbeddedLocalReferences(mutation.metadata, graph)
        break
      case "edit_link":
        graph.push(mutation.linkRef, mutation.fromRef, mutation.toRef)
        collectEmbeddedLocalReferences(mutation.content, graph)
        collectEmbeddedLocalReferences(mutation.metadata, graph)
        break
      case "retire_link":
        graph.push(mutation.linkRef, ...mutation.archiveOutletRefs)
        break
    }
  }
  graph.push(
    ...governance.retrievalProjections.flatMap((projection) => projection.ownerRef === undefined ? [] : [projection.ownerRef]),
    ...governance.settlementRecords.flatMap((record) => record.graphRefs.map((reference) => reference.targetRef)),
    ...governance.sceneSpacetimeBindings.flatMap((binding) => [
      binding.sceneAnchorRef,
      ...binding.temporalReferenceRefs,
      ...binding.timeAnchorRefs,
      ...binding.spatialReferenceRefs,
      ...binding.locationAnchorRefs,
      ...binding.predecessorSceneAnchorRefs,
      ...binding.transitionPathRefs,
      ...binding.correspondenceRefs,
    ]),
    ...governance.mutationSpacetimeSettlements.flatMap((settlement) => [
      ...settlement.effectiveExistingSceneAnchorRefs,
      ...settlement.currentEntryRefs,
      ...settlement.historicalReturnRefs,
    ]),
    ...governance.affectedFrontierRefs,
    ...governance.archiveOutletRefs,
  )
  return {
    graph,
    evidence: governance.mutationSpacetimeSettlements.flatMap((settlement) => settlement.predecessorRevisionReadRefs),
  }
}

function assertExactIndexSet(indexes: readonly number[], expectedLength: number, label: string): void {
  const expected = Array.from({ length: expectedLength }, (_, index) => index)
  if (indexes.length !== expectedLength || new Set(indexes).size !== indexes.length || expected.some((index) => !indexes.includes(index))) {
    const missing = expected.filter((index) => !indexes.includes(index))
    const duplicates = [...new Set(indexes.filter((index, position) => indexes.indexOf(index) !== position))]
    const outOfRange = [...new Set(indexes.filter((index) => index < 0 || index >= expectedLength))]
    throw new Error([
      `${label} must contain every index exactly once`,
      `expected=[${expected.join(",")}]`,
      `received=[${indexes.join(",")}]`,
      `missing=[${missing.join(",")}]`,
      `duplicates=[${duplicates.join(",")}]`,
      `outOfRange=[${outOfRange.join(",")}]`,
    ].join("; "))
  }
}

function assertIndexesInRange(indexes: readonly number[], length: number, label: string): void {
  if (indexes.some((index) => index >= length)) throw new Error(`${label} index is out of range`)
}

function assertSameSet(actual: readonly number[], expected: readonly number[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((index) => !actual.includes(index))) {
    throw new Error(`${label} do not match`)
  }
}

function assertAdvisoryIndexDecisions(
  approved: readonly number[],
  rejected: readonly number[],
  expectedLength: number,
  label: string,
): void {
  const decisions = [...approved, ...rejected]
  assertIndexesInRange(decisions, expectedLength, `Semantic review ${label}`)
  if (new Set(decisions).size !== decisions.length) {
    throw new Error(`Semantic review ${label} decisions must not overlap or repeat`)
  }
}

function assertAdvisoryReferenceDecisions(
  approved: readonly string[],
  rejected: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const decisions = [...approved, ...rejected]
  if (new Set(decisions).size !== decisions.length
    || decisions.some((reference) => !expected.includes(reference))) {
    throw new Error(`Semantic review ${label} decisions must be unique proposed references`)
  }
}

function collectEmbeddedLocalReferences(value: unknown, references: string[]): void {
  if (typeof value === "string") {
    if (/^local:[a-zA-Z0-9_.-]+$/u.test(value)) references.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEmbeddedLocalReferences(item, references)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const item of Object.values(value)) collectEmbeddedLocalReferences(item, references)
}
