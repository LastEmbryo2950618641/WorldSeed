import { randomUUID } from "node:crypto"

import {
  modelPhaseResultJsonSchema,
  modelPhaseResultSchema,
  phaseResultEnvelopeSchema,
  type AIPhase,
  type ModelPhaseResult,
  type PhaseRequestEnvelope,
  type PhaseResultEnvelope,
  type ReadRequest,
} from "@worldseed/contracts"
import {
  assertFrontierSettlementCoversReview,
  assertCommitReviewCoversTemporalClaims,
  assertGraphSpacetimeSettlementCoverage,
  assertPhaseReferenceContract,
  assertSemanticReviewCoversGovernance,
  assertSpacetimeGovernanceCoverage,
  assertTemporalClaimCoverage,
  graphGovernanceArtifactSchema,
  graphStructurePlanArtifactSchema,
  frontierSettlementProjectionSchema,
  semanticReviewArtifactSchema,
  phaseArtifactJsonSchema,
  parsePhaseArtifact,
} from "@worldseed/prompt-contracts"

import {
  canonicalizeEvidenceReadId,
  completeGraphSettlementRecords,
  VerificationProbeCoordinator,
  type TurnPhaseInput,
} from "../../../application/index.js"

const verificationProbeCoordinator = new VerificationProbeCoordinator()

export function phaseModelResultJsonSchema(phase: AIPhase): unknown {
  const resultSchema = asRecord(modelPhaseResultJsonSchema())
  const resultProperties = asRecord(resultSchema.properties)
  return stripSchemaMetadata({
    ...resultSchema,
    properties: {
      ...resultProperties,
      artifact: phaseArtifactJsonSchema(phase),
    },
  })
}

function stripSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchemaMetadata(item))
  if (typeof value !== "object" || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, entry]) => [key, stripSchemaMetadata(entry)]),
  )
}

export function parseModelPhaseResult(value: unknown): ModelPhaseResult {
  return modelPhaseResultSchema.parse(value)
}

export function assembleModelPhaseResult(
  semantic: ModelPhaseResult,
  request: PhaseRequestEnvelope,
  createId: () => string = randomUUID,
): PhaseResultEnvelope {
  const input = request.input as TurnPhaseInput
  const citedReadIds = semantic.citedReadIds.map((readId) => (
    canonicalizeEvidenceReadId(readId, input.readEvidence)
  ))
  assertCitationsAreReadable(citedReadIds, request)
  const artifact = semantic.artifact === undefined
    ? undefined
    : normalizeArtifactReferences(
        request,
        completeAdvisoryDefaults(
          request,
          parsePhaseArtifact(
            request.phase,
            normalizeOptionalModelFields(
              request.phase,
              normalizeEvidenceAliases(semantic.artifact, input.readEvidence),
            ),
          ),
          semantic.reason,
          semantic.selfReview,
        ),
      )
  const requestedReads = semantic.requestedReads.map((read) => {
    const query = read.query
    const exactKeys = query?.exactKeys ?? []
    const semanticTexts = query?.semanticTexts ?? []
    return {
      requestId: createId(),
      reason: read.reason,
      expectedEvidence: read.expectedEvidence,
      query: {
        exactKeys,
        semanticTexts: exactKeys.length === 0 && semanticTexts.length === 0
          ? [read.expectedEvidence]
          : semanticTexts,
        anchorIds: query?.anchorIds ?? [],
        directions: query?.directions ?? ["both" as const],
        maxCandidates: query?.maxCandidates ?? 24,
        maxDepth: query?.maxDepth ?? 2,
        sourceKinds: normalizeRequestedSourceKinds(exactKeys, query?.sourceKinds),
        ...(query?.sourceIds === undefined ? {} : { sourceIds: query.sourceIds }),
        ...(query?.sourceBoundary === undefined ? {} : { sourceBoundary: query.sourceBoundary }),
      },
      ...(read.verificationProbe === undefined ? {} : { verificationProbe: read.verificationProbe }),
    }
  })
  assertCrossPhaseArtifactContract(request, artifact, requestedReads.length === 0)
  assertArtifactReferences(request, artifact)

  return phaseResultEnvelopeSchema.parse({
    schemaVersion: request.schemaVersion,
    envelopeId: request.envelopeId,
    contextId: request.contextId,
    phase: request.phase,
    outcome: semantic.outcome,
    artifact,
    requestedReads,
    citedReadIds,
    producedArtifactIds: [],
    decisionRecordIds: [],
    unresolvedDependencies: semantic.unresolvedDependencies.map((dependency) => ({
      dependencyId: createId(),
      ...dependency,
    })),
    reason: semantic.reason,
    selfReview: semantic.selfReview,
  })
}

function normalizeEvidenceAliases(value: unknown, evidence: TurnPhaseInput["readEvidence"]): unknown {
  if (typeof value === "string") return canonicalizeEvidenceReadId(value, evidence)
  if (Array.isArray(value)) return value.map((item) => normalizeEvidenceAliases(item, evidence))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    normalizeEvidenceAliases(item, evidence),
  ]))
}

function normalizeRequestedSourceKinds(
  exactKeys: readonly string[],
  requestedSourceKinds: ReadRequest["query"]["sourceKinds"] | undefined,
): ReadRequest["query"]["sourceKinds"] {
  const sourceKinds = [...new Set(requestedSourceKinds ?? [
    "rule" as const,
    "reference" as const,
    "graph" as const,
    "revision" as const,
    "source" as const,
  ])]
  const queriesPersistentWorld = sourceKinds.some((kind) => (
    kind === "graph" || kind === "revision" || kind === "source"
  ))
  if (exactKeys.length > 0 && queriesPersistentWorld && !sourceKinds.includes("source")) {
    sourceKinds.push("source")
  }
  return sourceKinds
}

function normalizeOptionalModelFields(phase: AIPhase, artifact: unknown): unknown {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return artifact
  const record = artifact as Record<string, unknown>
  if (phase === "emergence_planning" && record.noCreationReason === "") {
    const { noCreationReason: ignoredNoCreationReason, ...rest } = record
    void ignoredNoCreationReason
    return rest
  }
  if (phase === "dependency_audit" && Array.isArray(record.sceneContinuity)) {
    return normalizeDependencySceneIndexes(record)
  }
  if (phase === "graph_governance" && Array.isArray(record.settlementRecords)) {
    return {
      ...record,
      settlementRecords: record.settlementRecords.map((settlement) => {
        if (typeof settlement !== "object" || settlement === null || Array.isArray(settlement)) return settlement
        const settlementRecord = settlement as Record<string, unknown>
        if (!Array.isArray(settlementRecord.graphRefs)) return settlement
        return {
          ...settlementRecord,
          graphRefs: settlementRecord.graphRefs.map((reference) => {
            if (typeof reference !== "object" || reference === null || Array.isArray(reference)) return reference
            const referenceRecord = reference as Record<string, unknown>
            if (referenceRecord.mutationIndex !== null) return reference
            const { mutationIndex: ignoredMutationIndex, ...rest } = referenceRecord
            void ignoredMutationIndex
            return rest
          }),
        }
      }),
    }
  }
  return artifact
}

function normalizeDependencySceneIndexes(record: Record<string, unknown>): Record<string, unknown> {
  const scenes = record.sceneContinuity
  if (!Array.isArray(scenes) || scenes.length === 0) return record

  const sceneIndexes = scenes.map((scene) => (
    typeof scene === "object" && scene !== null && !Array.isArray(scene)
      ? (scene as Record<string, unknown>).sceneIndex
      : undefined
  ))
  const isOneBased = sceneIndexes.every((sceneIndex, index) => sceneIndex === index + 1)
  if (!isOneBased) return record

  return {
    ...record,
    sceneContinuity: scenes.map((scene) => {
      if (typeof scene !== "object" || scene === null || Array.isArray(scene)) return scene
      const sceneRecord = scene as Record<string, unknown>
      const predecessorSceneIndexes = Array.isArray(sceneRecord.predecessorSceneIndexes)
        ? sceneRecord.predecessorSceneIndexes.map((sceneIndex) => (
          typeof sceneIndex === "number" && sceneIndex > 0 ? sceneIndex - 1 : sceneIndex
        ))
        : sceneRecord.predecessorSceneIndexes
      return {
        ...sceneRecord,
        sceneIndex: (sceneRecord.sceneIndex as number) - 1,
        predecessorSceneIndexes,
      }
    }),
  }
}

function completeAdvisoryDefaults(
  request: PhaseRequestEnvelope,
  artifact: unknown,
  reason: string,
  selfReview: string,
): unknown {
  if (request.phase !== "graph_governance") return artifact
  const governance = graphGovernanceArtifactSchema.parse(artifact)
  const input = request.input as TurnPhaseInput
  const decidedIndexes = new Set(governance.decisionRecords.flatMap((decision) => decision.mutationIndexes))
  const missingIndexes = Array.from({ length: governance.mutations.length }, (_, index) => index)
    .filter((index) => !decidedIndexes.has(index))
  const decisionRecords = missingIndexes.length === 0
    ? governance.decisionRecords
    : [
        ...governance.decisionRecords,
        {
          decisionKind: "phase_default",
          mutationIndexes: missingIndexes,
          mutationSpacetimeSettlementIndexes: [],
          reason,
          payload: { source: "phase_result" },
          selfReview,
        },
      ]
  const completedGovernance = completeGraphSettlementRecords(
    governance,
    input.sourceUnitIds.length,
    reason,
  )
  if (decisionRecords === governance.decisionRecords && completedGovernance === governance) return governance
  return {
    ...completedGovernance,
    decisionRecords,
  }
}

function normalizeArtifactReferences(request: PhaseRequestEnvelope, artifact: unknown): unknown {
  if (request.phase === "semantic_review") {
    return completeApprovedAffectedFrontiers(request, artifact)
  }
  if (request.phase === "graph_structure_plan") {
    const structure = graphStructurePlanArtifactSchema.parse(artifact)
    const input = request.input as TurnPhaseInput
    const evidenceOwnerByReadId = new Map(input.readEvidence.flatMap((evidence) => (
      evidence.ownerKind === "node" || evidence.ownerKind === "link"
        ? [[evidence.readId, evidence.ownerId] as const]
        : []
    )))
    const graphRef = (reference: string): string => evidenceOwnerByReadId.get(reference) ?? reference
    return {
      ...structure,
      proposals: structure.proposals.map((proposal) => ({
        ...proposal,
        mutation: normalizeGraphMutationReferences(proposal.mutation, graphRef),
      })),
      affectedFrontierRefs: structure.affectedFrontierRefs.map(graphRef),
      archiveOutletRefs: structure.archiveOutletRefs.map(graphRef),
    }
  }
  if (request.phase !== "graph_governance") return artifact
  const governance = graphGovernanceArtifactSchema.parse(artifact)
  const input = request.input as TurnPhaseInput
  const evidenceOwnerByReadId = new Map(input.readEvidence.flatMap((evidence) => (
    evidence.ownerKind === "node" || evidence.ownerKind === "link"
      ? [[evidence.readId, evidence.ownerId] as const]
      : []
  )))
  const evidenceReadIds = new Set(input.readEvidence.map((evidence) => evidence.readId))
  const graphRef = (reference: string): string => evidenceOwnerByReadId.get(reference) ?? reference
  const graphRefs = (references: readonly string[]): string[] => references.map(graphRef)
  const historicalGraphRefs = (
    references: readonly string[],
    fallbackReferences: readonly string[],
  ): string[] => {
    const normalized = graphRefs(references).filter((reference) => !evidenceReadIds.has(reference))
    return normalized.length > 0 ? normalized : [...new Set(graphRefs(fallbackReferences))]
  }
  const allSourceUnitIndexes = Array.from({ length: input.sourceUnitIds.length }, (_, index) => index)
  return {
    ...governance,
    mutations: governance.mutations.map((mutation) => normalizeGraphMutationReferences(mutation, graphRef)),
    retrievalProjections: governance.retrievalProjections.map((projection) => ({
      ...projection,
      ...(projection.ownerRef === undefined ? {} : { ownerRef: graphRef(projection.ownerRef) }),
    })),
    settlementRecords: governance.settlementRecords.map((record) => ({
      ...record,
      graphRefs: record.graphRefs.map((reference) => ({
        ...reference,
        targetRef: graphRef(reference.targetRef),
      })),
    })),
    sceneSpacetimeBindings: governance.sceneSpacetimeBindings.map((binding) => ({
      ...binding,
      sourceUnitIndexes: governance.sceneSpacetimeBindings.length === 1 && allSourceUnitIndexes.length > 0
        ? allSourceUnitIndexes
        : binding.sourceUnitIndexes,
      sceneAnchorRef: graphRef(binding.sceneAnchorRef),
      temporalReferenceRefs: binding.temporalReferenceRefs.map(graphRef),
      timeAnchorRefs: binding.timeAnchorRefs.map(graphRef),
      spatialReferenceRefs: binding.spatialReferenceRefs.map(graphRef),
      locationAnchorRefs: binding.locationAnchorRefs.map(graphRef),
      predecessorSceneAnchorRefs: binding.predecessorSceneAnchorRefs.map(graphRef),
      transitionPathRefs: binding.transitionPathRefs.map(graphRef),
      correspondenceRefs: binding.correspondenceRefs.map(graphRef),
    })),
    mutationSpacetimeSettlements: governance.mutationSpacetimeSettlements.map((settlement) => {
      const effectiveExistingSceneAnchorRefs = graphRefs(settlement.effectiveExistingSceneAnchorRefs)
      const currentEntryRefs = graphRefs(settlement.currentEntryRefs)
      return {
        ...settlement,
        effectiveExistingSceneAnchorRefs,
        currentEntryRefs,
        historicalReturnRefs: historicalGraphRefs(
          settlement.historicalReturnRefs,
          [...currentEntryRefs, ...effectiveExistingSceneAnchorRefs],
        ),
      }
    }),
    affectedFrontierRefs: governance.affectedFrontierRefs.map(graphRef),
    archiveOutletRefs: governance.archiveOutletRefs.map(graphRef),
  }
}

function normalizeGraphMutationReferences(
  mutation: ReturnType<typeof graphGovernanceArtifactSchema.parse>["mutations"][number],
  graphRef: (reference: string) => string,
): ReturnType<typeof graphGovernanceArtifactSchema.parse>["mutations"][number] {
  switch (mutation.operation) {
    case "create_node": return mutation
    case "edit_node": return { ...mutation, nodeRef: graphRef(mutation.nodeRef) }
    case "retire_node": return { ...mutation, nodeRef: graphRef(mutation.nodeRef), archiveOutletRefs: mutation.archiveOutletRefs.map(graphRef) }
    case "create_link": return { ...mutation, fromRef: graphRef(mutation.fromRef), toRef: graphRef(mutation.toRef) }
    case "edit_link": return { ...mutation, linkRef: graphRef(mutation.linkRef), fromRef: graphRef(mutation.fromRef), toRef: graphRef(mutation.toRef) }
    case "retire_link": return { ...mutation, linkRef: graphRef(mutation.linkRef), archiveOutletRefs: mutation.archiveOutletRefs.map(graphRef) }
  }
}

function completeApprovedAffectedFrontiers(request: PhaseRequestEnvelope, artifact: unknown): unknown {
  const review = semanticReviewArtifactSchema.parse(artifact)
  const input = request.input as TurnPhaseInput
  const governance = graphGovernanceArtifactSchema.parse(phaseArtifacts(input).graph_governance)
  if (!isCompleteApproval(review.approvedMutationIndexes, review.rejectedMutationIndexes, governance.mutations.length)
    || !isCompleteApproval(
      review.approvedSpacetimeBindingIndexes,
      review.rejectedSpacetimeBindingIndexes,
      governance.sceneSpacetimeBindings.length,
    )
    || !isCompleteApproval(
      review.approvedMutationSpacetimeSettlementIndexes,
      review.rejectedMutationSpacetimeSettlementIndexes,
      governance.mutationSpacetimeSettlements.length,
    )
    || review.rejectedAffectedFrontierRefs.length > 0) {
    return review
  }
  const decided = new Set(review.approvedAffectedFrontierRefs)
  const missing = governance.affectedFrontierRefs.filter((reference) => !decided.has(reference))
  return missing.length === 0
    ? review
    : {
        ...review,
        approvedAffectedFrontierRefs: [...review.approvedAffectedFrontierRefs, ...missing],
      }
}

function isCompleteApproval(approved: readonly number[], rejected: readonly number[], expectedLength: number): boolean {
  return rejected.length === 0
    && approved.length === expectedLength
    && new Set(approved).size === expectedLength
    && Array.from({ length: expectedLength }, (_, index) => index).every((index) => approved.includes(index))
}

function assertCrossPhaseArtifactContract(
  request: PhaseRequestEnvelope,
  artifact: unknown,
  finalArtifact: boolean,
): void {
  const input = request.input as TurnPhaseInput
  const artifacts = phaseArtifacts(input)
  if (request.phase === "graph_spacetime_settlement"
    && finalArtifact
    && artifacts.dependency_audit !== undefined
    && artifacts.graph_structure_plan !== undefined) {
    assertGraphSpacetimeSettlementCoverage(
      artifacts.dependency_audit,
      artifacts.graph_structure_plan,
      artifact,
      input.sourceUnitIds.length,
    )
  }
  if (request.phase === "graph_governance" && artifacts.dependency_audit !== undefined) {
    assertSpacetimeGovernanceCoverage(artifacts.dependency_audit, artifact, input.sourceUnitIds.length)
  }
  if (request.phase === "semantic_review") {
    assertSemanticReviewCoversGovernance(artifacts.graph_governance, artifact)
  }
  if (request.phase === "graph_governance_review"
    && finalArtifact
    && artifacts.dependency_audit !== undefined
    && artifacts.graph_spacetime_settlement !== undefined) {
    assertTemporalClaimCoverage(artifacts.dependency_audit, artifacts.graph_spacetime_settlement, artifact)
  }
  if ((request.phase === "semantic_review" || request.phase === "graph_governance_review") && finalArtifact) {
    verificationProbeCoordinator.assertAssessments(artifact, input.verificationProbeExecutions ?? [])
  }
  if (request.phase === "frontier_settlement") {
    assertFrontierSettlementCoversReview(
      artifacts.semantic_review,
      artifact,
      artifacts.graph_governance,
      input.stageProjection,
    )
  }
  if (request.phase === "commit_review" && artifacts.graph_governance_review !== undefined) {
    assertCommitReviewCoversTemporalClaims(artifacts.graph_governance_review, artifact)
  }
}

function assertArtifactReferences(request: PhaseRequestEnvelope, artifact: unknown): void {
  if (artifact === undefined) return
  const input = request.input as TurnPhaseInput
  const artifacts = phaseArtifacts(input)
  const governance = artifacts.graph_governance === undefined
    ? undefined
    : graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
  const structure = artifacts.graph_structure_plan === undefined
    ? undefined
    : graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan)
  const readableGraphIds = new Set(input.readEvidence
    .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
    .map((evidence) => evidence.ownerId))
  if (request.phase === "frontier_settlement" && input.stageProjection !== undefined) {
    for (const reference of frontierProjectionGraphReferences(input.stageProjection)) readableGraphIds.add(reference)
  }
  assertPhaseReferenceContract(request.phase, artifact, {
    readableEvidenceIds: new Set(input.readEvidence.map((evidence) => evidence.readId)),
    readableGraphIds,
    readableWorkspacePaths: new Set(input.readEvidence
      .filter((evidence) => evidence.ownerKind.startsWith("workspace:"))
      .map((evidence) => evidence.ownerId)),
    declaredLocalGraphRefs: new Set((governance?.mutations ?? structure?.proposals.map((proposal) => proposal.mutation) ?? []).flatMap((mutation) => (
      mutation.operation === "create_node" || mutation.operation === "create_link" ? [mutation.ref] : []
    )) ?? []),
  })
}

function frontierProjectionGraphReferences(value: unknown): string[] {
  const projection = frontierSettlementProjectionSchema.parse(value)
  return [...new Set([
    ...projection.affectedFrontierRefs,
    ...projection.archiveOutletRefs,
    ...projection.correspondenceRefs,
    ...projection.approvedSceneBindings.flatMap((binding) => [
      binding.sceneAnchorRef,
      ...binding.temporalReferenceRefs,
      ...binding.timeAnchorRefs,
      ...binding.spatialReferenceRefs,
      ...binding.locationAnchorRefs,
      ...binding.predecessorSceneAnchorRefs,
      ...binding.transitionPathRefs,
      ...binding.correspondenceRefs,
    ]),
    ...projection.priorFrontierStates.flatMap((state) => [
      state.frontierAnchorRef,
      ...state.lastSceneAnchorRefs,
      ...state.lastTimeAnchorRefs,
      ...state.lastLocationAnchorRefs,
      ...state.correspondenceRefs,
    ]),
  ])]
}

function phaseArtifacts(input: TurnPhaseInput): Partial<Record<AIPhase, unknown>> {
  return input.validationArtifacts ?? input.artifacts
}

function assertCitationsAreReadable(citedReadIds: readonly string[], request: PhaseRequestEnvelope): void {
  const readableIds = new Set([...request.committedReadIds, ...request.visiblePendingIds])
  const invalidIds = citedReadIds.filter((readId) => !readableIds.has(readId))
  if (invalidIds.length > 0) {
    throw new Error(`citedReadIds contains IDs that are not readable evidence: ${invalidIds.join(", ")}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}
