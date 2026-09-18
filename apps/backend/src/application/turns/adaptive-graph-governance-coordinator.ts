import { graphGovernanceArtifactSchema, type GraphGovernanceArtifact } from "@worldseed/prompt-contracts"

export type AdaptiveGraphGovernanceMode =
  | "no_change"
  | "local_governance"
  | "compact_governance"
  | "full_governance"

export type AdaptiveGraphGovernanceCandidate = GraphGovernanceArtifact

export type AdaptiveGraphGovernanceDecision = Readonly<{
  mode: AdaptiveGraphGovernanceMode
  artifact?: GraphGovernanceArtifact
  fallbackReason?: string
}>

export function decideAdaptiveGraphGovernance(
  input: unknown,
  sourceUnitCount = 0,
): AdaptiveGraphGovernanceDecision {
  let artifact: GraphGovernanceArtifact
  try {
    artifact = graphGovernanceArtifactSchema.parse(input)
  } catch {
    return {
      mode: "full_governance",
      fallbackReason: "Adaptive governance candidate failed contract validation",
    }
  }

  if (artifact.executionMode === "full_governance") {
    return {
      mode: "full_governance",
      fallbackReason: "AI selected full governance",
    }
  }

  if (artifact.executionMode === "local_governance") {
    let requiresCompactSettlement = false
    if (artifact.affectedFrontierRefs.length > 0) {
      requiresCompactSettlement = true
    }
    if (artifact.mutations.length > 0 && artifact.sceneSpacetimeBindings.length === 0) {
      requiresCompactSettlement = true
    }
    const settledMutationIndexes = artifact.mutationSpacetimeSettlements.flatMap((settlement) => settlement.mutationIndexes)
    if (settledMutationIndexes.length !== artifact.mutations.length
      || new Set(settledMutationIndexes).size !== artifact.mutations.length
      || artifact.mutations.some((_, index) => !settledMutationIndexes.includes(index))) {
      return {
        mode: "full_governance",
        fallbackReason: "Local governance mutations are not fully settled",
      }
    }
    const decidedMutationIndexes = new Set(
      artifact.decisionRecords.flatMap((record) => record.mutationIndexes),
    )
    if (artifact.mutations.some((_, index) => !decidedMutationIndexes.has(index))) {
      requiresCompactSettlement = true
    }
    if (sourceUnitCount > 0) {
      const settledSourceUnitIndexes = new Set(
        artifact.settlementRecords
          .filter((record) => record.graphRefs.length > 0)
          .map((record) => record.sourceUnitIndex),
      )
      if (Array.from({ length: sourceUnitCount }, (_, index) => index)
        .some((index) => !settledSourceUnitIndexes.has(index))) {
        requiresCompactSettlement = true
      }
    }
    if (requiresCompactSettlement) {
      return {
        mode: "compact_governance",
        artifact,
        fallbackReason: "Local governance needs compact dependency, spacetime, review, and frontier settlement",
      }
    }
  }

  return {
    mode: artifact.executionMode,
    artifact,
  }
}
