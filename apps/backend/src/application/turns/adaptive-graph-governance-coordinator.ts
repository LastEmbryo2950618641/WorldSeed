import { graphGovernanceArtifactSchema, type GraphGovernanceArtifact } from "@worldseed/prompt-contracts"

export type AdaptiveGraphGovernanceMode = "no_change" | "local_governance" | "full_governance"

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
    if (artifact.affectedFrontierRefs.length > 0) {
      return {
        mode: "full_governance",
        fallbackReason: "Local governance changed an existing frontier and requires the full settlement chain",
      }
    }
    if (artifact.mutations.length > 0 && artifact.sceneSpacetimeBindings.length === 0) {
      return {
        mode: "full_governance",
        fallbackReason: "Local governance mutations have no scene-spacetime binding",
      }
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
      return {
        mode: "full_governance",
        fallbackReason: "Local governance mutations have no decision record",
      }
    }
    if (sourceUnitCount > 0) {
      const settledSourceUnitIndexes = new Set(
        artifact.settlementRecords
          .filter((record) => record.graphRefs.length > 0)
          .map((record) => record.sourceUnitIndex),
      )
      if (Array.from({ length: sourceUnitCount }, (_, index) => index)
        .some((index) => !settledSourceUnitIndexes.has(index))) {
        return {
          mode: "full_governance",
          fallbackReason: "Local governance does not return every submitted source unit",
        }
      }
    }
  }

  return {
    mode: artifact.executionMode,
    artifact,
  }
}
