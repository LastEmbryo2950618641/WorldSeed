import {
  graphCapacityRewriteArtifactSchema,
  graphGovernanceArtifactSchema,
  graphRetrievalDesignArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  graphStructurePlanArtifactSchema,
  type GraphCapacityRewriteArtifact,
  type GraphGovernanceArtifact,
  type GraphRetrievalDesignArtifact,
  type GraphSpacetimeSettlementArtifact,
  type GraphStructurePlanArtifact,
} from "@worldseed/prompt-contracts"

export type GraphGovernanceResponsibility = "structure" | "capacity" | "spacetime" | "retrieval"

export function applyGraphCapacityRewrite(
  currentInput: GraphStructurePlanArtifact,
  rewriteInput: GraphCapacityRewriteArtifact,
): GraphStructurePlanArtifact {
  const current = graphStructurePlanArtifactSchema.parse(currentInput)
  const rewrite = graphCapacityRewriteArtifactSchema.parse(rewriteInput)
  const currentProposalRefs = new Set(current.proposals.map((proposal) => proposal.proposalRef))
  const affected = new Set(rewrite.affectedProposalRefs)
  const unknownAffected = rewrite.affectedProposalRefs.filter((proposalRef) => !currentProposalRefs.has(proposalRef))
  if (unknownAffected.length > 0) {
    throw new Error(`Capacity rewrite declared missing existing proposals as affected: ${unknownAffected.join(", ")}`)
  }
  const changedExisting = [
    ...rewrite.removeProposalRefs,
    ...rewrite.upsertProposals
      .map((proposal) => proposal.proposalRef)
      .filter((proposalRef) => currentProposalRefs.has(proposalRef)),
  ]
  const outsideScope = changedExisting.filter((proposalRef) => !affected.has(proposalRef))
  if (outsideScope.length > 0) {
    throw new Error(`Capacity rewrite changed proposals outside its declared local proposal scope: ${outsideScope.join(", ")}`)
  }

  const proposals = new Map(current.proposals.map((proposal) => [proposal.proposalRef, proposal]))
  for (const proposalRef of rewrite.removeProposalRefs) proposals.delete(proposalRef)
  for (const proposal of rewrite.upsertProposals) proposals.set(proposal.proposalRef, proposal)
  const removedProposalRefs = new Set(rewrite.removeProposalRefs)
  const decisionRecords = current.decisionRecords.map((decision) => ({
    ...decision,
    proposalRefs: decision.proposalRefs.filter((proposalRef) => !removedProposalRefs.has(proposalRef)),
  }))
  decisionRecords.push({
    decisionKind: "capacity_rewrite",
    proposalRefs: rewrite.upsertProposals.map((proposal) => proposal.proposalRef),
    reason: rewrite.reason,
    payload: {
      hotspotRefs: rewrite.hotspotRefs,
      affectedProposalRefs: rewrite.affectedProposalRefs,
      removeProposalRefs: rewrite.removeProposalRefs,
    },
    selfReview: rewrite.selfReview,
  })
  return graphStructurePlanArtifactSchema.parse({
    ...current,
    proposals: [...proposals.values()],
    decisionRecords,
  })
}

export function replayGraphCapacityRewrites(
  structure: GraphStructurePlanArtifact,
  rewrites: readonly GraphCapacityRewriteArtifact[],
): GraphStructurePlanArtifact {
  return rewrites.reduce(
    (current, rewrite) => applyGraphCapacityRewrite(current, rewrite),
    graphStructurePlanArtifactSchema.parse(structure),
  )
}

export function assembleGraphGovernanceArtifact(input: Readonly<{
  structure: GraphStructurePlanArtifact
  spacetime: GraphSpacetimeSettlementArtifact
  retrieval: GraphRetrievalDesignArtifact
  sourceUnitCount: number
}>): GraphGovernanceArtifact {
  const structure = graphStructurePlanArtifactSchema.parse(input.structure)
  const spacetime = graphSpacetimeSettlementArtifactSchema.parse(input.spacetime)
  const retrieval = graphRetrievalDesignArtifactSchema.parse(input.retrieval)
  const mutationIndexByProposalRef = new Map(
    structure.proposals.map((proposal, index) => [proposal.proposalRef, index]),
  )
  const ownerKindByProposalRef = new Map(structure.proposals.map((proposal) => [
    proposal.proposalRef,
    proposal.mutation.operation.endsWith("_node") ? "node" as const : "link" as const,
  ]))
  const mutationIndexes = (proposalRefs: readonly string[]): number[] => proposalRefs.map((proposalRef) => {
    const index = mutationIndexByProposalRef.get(proposalRef)
    if (index === undefined) throw new Error(`Unknown graph proposal reference: ${proposalRef}`)
    return index
  })

  const governance = graphGovernanceArtifactSchema.parse({
    mutations: structure.proposals.map((proposal) => proposal.mutation),
    retrievalProjections: retrieval.projections.map((projection) => ({
      ownerKind: projection.ownerProposalRef === undefined
        ? inferExistingOwnerKind(projection.ownerRef as string)
        : ownerKindByProposalRef.get(projection.ownerProposalRef),
      ...(projection.ownerProposalRef === undefined
        ? { ownerRef: projection.ownerRef }
        : { ownerMutationIndex: mutationIndexes([projection.ownerProposalRef])[0] }),
      exactKeys: projection.exactKeys,
      semanticText: projection.semanticText,
    })),
    settlementRecords: retrieval.sourceSettlements.map((settlement) => ({
      ...settlement,
      graphRefs: settlement.graphRefs.map((reference) => ({
        targetKind: reference.targetKind,
        targetRef: reference.targetRef,
        ...(reference.proposalRef === undefined
          ? {}
          : { mutationIndex: mutationIndexes([reference.proposalRef])[0] }),
      })),
    })),
    mutationSpacetimeSettlements: spacetime.proposalSettlements.map((settlement) => ({
      ...settlement,
      mutationIndexes: mutationIndexes(settlement.proposalRefs),
      proposalRefs: undefined,
    })),
    sceneSpacetimeBindings: spacetime.sceneSpacetimeBindings,
    affectedFrontierRefs: structure.affectedFrontierRefs,
    archiveOutletRefs: structure.archiveOutletRefs,
    decisionRecords: structure.decisionRecords.map((decision) => ({
      decisionKind: decision.decisionKind,
      mutationIndexes: mutationIndexes(decision.proposalRefs),
      mutationSpacetimeSettlementIndexes: spacetime.proposalSettlements.flatMap((settlement, index) => (
        settlement.proposalRefs.some((proposalRef) => decision.proposalRefs.includes(proposalRef)) ? [index] : []
      )),
      reason: decision.reason,
      payload: decision.payload,
      selfReview: decision.selfReview,
    })),
  })
  return completeGraphSettlementRecords(
    governance,
    input.sourceUnitCount,
    "Staged graph governance",
  )
}

export function completeGraphSettlementRecords(
  governanceInput: GraphGovernanceArtifact,
  sourceUnitCount: number,
  reason: string,
): GraphGovernanceArtifact {
  const governance = graphGovernanceArtifactSchema.parse(governanceInput)
  if (sourceUnitCount === 0) return governance
  const existing = new Map(governance.settlementRecords.map((record) => [record.sourceUnitIndex, record]))
  if (existing.size === sourceUnitCount
    && Array.from({ length: sourceUnitCount }, (_, index) => (existing.get(index)?.graphRefs.length ?? 0) > 0).every(Boolean)) {
    return governance
  }
  const mutationRefs = governance.mutations.map((mutation, mutationIndex) => ({
    mutationIndex,
    targetKind: mutation.operation.endsWith("_link") ? "link" as const : "node" as const,
    targetRef: mutation.operation === "create_node" || mutation.operation === "create_link"
      ? mutation.ref
      : mutation.operation === "edit_node" || mutation.operation === "retire_node"
        ? mutation.nodeRef
        : mutation.linkRef,
  }))
  const mutationKindByRef = new Map(mutationRefs.map((reference) => [reference.targetRef, reference.targetKind]))
  const derived = Array.from({ length: sourceUnitCount }, (_, sourceUnitIndex) => {
    const sourceBindings = governance.sceneSpacetimeBindings
      .filter((binding) => binding.sourceUnitIndexes.includes(sourceUnitIndex))
    const sceneIndexes = new Set(sourceBindings.map((binding) => binding.sceneIndex))
    const mutationIndexes = new Set(governance.mutationSpacetimeSettlements
      .filter((settlement) => settlement.effectiveSceneBindingIndexes.some((index) => sceneIndexes.has(index)))
      .flatMap((settlement) => settlement.mutationIndexes))
    const mutationGraphRefs = mutationRefs
      .filter((mutation) => mutationIndexes.has(mutation.mutationIndex))
      .map((mutation) => ({
        targetKind: mutation.targetKind,
        targetRef: mutation.targetRef,
        mutationIndex: mutation.mutationIndex,
      }))
    const sceneGraphRefs = sourceBindings.map((binding) => binding.sceneAnchorRef).map((targetRef) => ({
      targetKind: mutationKindByRef.get(targetRef) ?? inferExistingOwnerKind(targetRef),
      targetRef,
    }))
    return {
      sourceUnitIndex,
      graphRefs: uniqueGraphRefs(mutationGraphRefs.length > 0 ? mutationGraphRefs : sceneGraphRefs),
      reason: `${reason}（由场景绑定与修改时空结算生成原文返回投影）`,
      status: "derived",
    }
  })
  return graphGovernanceArtifactSchema.parse({
    ...governance,
    settlementRecords: Array.from(
      { length: sourceUnitCount },
      (_, index) => {
        const current = existing.get(index)
        return current !== undefined && current.graphRefs.length > 0 ? current : derived[index]!
      },
    ),
  })
}

function inferExistingOwnerKind(ownerRef: string): "node" | "link" {
  if (ownerRef.startsWith("node_") || ownerRef.startsWith("node-")) return "node"
  if (ownerRef.startsWith("link_") || ownerRef.startsWith("link-")) return "link"
  throw new Error(`Existing retrieval projection owner must be a node or link reference: ${ownerRef}`)
}

function uniqueGraphRefs<T extends { targetKind: "node" | "link"; targetRef: string }>(references: readonly T[]): T[] {
  return [...new Map(references.map((reference) => [
    `${reference.targetKind}:${reference.targetRef}`,
    reference,
  ])).values()]
}

export function invalidatedGraphGovernancePhases(
  responsibility: GraphGovernanceResponsibility,
): readonly ("graph_capacity_rewrite" | "graph_spacetime_settlement" | "graph_retrieval_design" | "graph_governance_review")[] {
  switch (responsibility) {
    case "structure": return ["graph_capacity_rewrite", "graph_spacetime_settlement", "graph_retrieval_design", "graph_governance_review"]
    case "capacity": return ["graph_spacetime_settlement", "graph_retrieval_design", "graph_governance_review"]
    case "spacetime": return ["graph_retrieval_design", "graph_governance_review"]
    case "retrieval": return ["graph_governance_review"]
  }
}
