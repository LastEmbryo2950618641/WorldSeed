import type { AIPhase } from "@worldseed/contracts"

import {
  dependencyAuditArtifactSchema,
  emergencePlanningArtifactSchema,
  frontierSettlementArtifactSchema,
  graphGovernanceArtifactSchema,
  ruleAssemblyArtifactSchema,
  semanticReviewArtifactSchema,
  type GraphGovernanceArtifact,
} from "./phase-schemas/artifacts.js"

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

  if (phase === "graph_governance") {
    assertGraphGovernanceReferenceContract(artifact, visibility.readableGraphIds, visibility.readableEvidenceIds)
    return
  }

  if (phase === "semantic_review") {
    const review = semanticReviewArtifactSchema.parse(artifact)
    assertReadableGraphReferences(
      review.verificationProbes.flatMap((probe) => probe.observedGraphRefs),
      new Set([
        ...visibility.readableGraphIds,
        ...(visibility.declaredLocalGraphRefs ?? []),
      ]),
    )
    assertReadableEvidenceReferences(
      review.verificationProbes.flatMap((probe) => probe.observedReadRefs),
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
  assertExactIndexSet(
    dependency.sceneContinuity.map((scene) => scene.sceneIndex),
    dependency.sceneContinuity.length,
    "Dependency audit scene inventory",
  )
  assertExactIndexSet(
    governance.sceneSpacetimeBindings.map((binding) => binding.sceneIndex),
    dependency.sceneContinuity.length,
    "Scene spacetime bindings",
  )

  for (const binding of governance.sceneSpacetimeBindings) {
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
      governance.settlementRecords.map((record) => record.sourceUnitIndex),
      sourceUnitCount,
      "Source unit settlement records",
    )
    assertExactIndexSet(
      governance.sceneSpacetimeBindings.flatMap((binding) => binding.sourceUnitIndexes),
      sourceUnitCount,
      "Scene source coverage",
    )
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
): void {
  const review = semanticReviewArtifactSchema.parse(reviewInput)
  const settlement = frontierSettlementArtifactSchema.parse(settlementInput)
  assertExactReferenceSet(
    settlement.frontiers.map((frontier) => frontier.frontierAnchorRef),
    review.approvedAffectedFrontierRefs,
    "frontier settlement",
  )
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
