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
  assertPhaseReferenceContract,
  assertSemanticReviewCoversGovernance,
  assertSpacetimeGovernanceCoverage,
  graphGovernanceArtifactSchema,
  semanticReviewArtifactSchema,
  phaseArtifactJsonSchema,
  parsePhaseArtifact,
} from "@worldseed/prompt-contracts"

import type { TurnPhaseInput } from "../../../application/index.js"

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
  assertCitationsAreReadable(semantic.citedReadIds, request)
  const artifact = semantic.artifact === undefined
    ? undefined
    : normalizeArtifactReferences(
        request,
        completeAdvisoryDefaults(
          request,
          parsePhaseArtifact(request.phase, normalizeOptionalModelFields(request.phase, semantic.artifact)),
          semantic.reason,
          semantic.selfReview,
        ),
      )
  assertCrossPhaseArtifactContract(request, artifact)
  assertArtifactReferences(request, artifact)

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
      },
    }
  })

  return phaseResultEnvelopeSchema.parse({
    schemaVersion: request.schemaVersion,
    envelopeId: request.envelopeId,
    contextId: request.contextId,
    phase: request.phase,
    outcome: semantic.outcome,
    artifact,
    requestedReads,
    citedReadIds: semantic.citedReadIds,
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
  const settlementRecords = completeSettlementRecords(
    governance,
    input.sourceUnitIds.length,
    reason,
  )
  if (decisionRecords === governance.decisionRecords && settlementRecords === governance.settlementRecords) return governance
  return {
    ...governance,
    decisionRecords,
    settlementRecords,
  }
}

function completeSettlementRecords(
  governance: ReturnType<typeof graphGovernanceArtifactSchema.parse>,
  sourceUnitCount: number,
  reason: string,
): ReturnType<typeof graphGovernanceArtifactSchema.parse>["settlementRecords"] {
  if (sourceUnitCount === 0) return governance.settlementRecords
  const existing = new Map(governance.settlementRecords.map((record) => [record.sourceUnitIndex, record]))
  if (existing.size === sourceUnitCount && Array.from({ length: sourceUnitCount }, (_, index) => existing.has(index)).every(Boolean)) {
    return governance.settlementRecords
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
  const derived = Array.from({ length: sourceUnitCount }, (_, sourceUnitIndex) => {
    const sceneIndexes = new Set(governance.sceneSpacetimeBindings
      .filter((binding) => binding.sourceUnitIndexes.includes(sourceUnitIndex))
      .map((binding) => binding.sceneIndex))
    const mutationIndexes = new Set(governance.mutationSpacetimeSettlements
      .filter((settlement) => settlement.effectiveSceneBindingIndexes.some((index) => sceneIndexes.has(index)))
      .flatMap((settlement) => settlement.mutationIndexes))
    const graphRefs = mutationRefs
      .filter((mutation) => mutationIndexes.has(mutation.mutationIndex))
      .map((mutation) => ({
        targetKind: mutation.targetKind,
        targetRef: mutation.targetRef,
        mutationIndex: mutation.mutationIndex,
      }))
    return {
      sourceUnitIndex,
      graphRefs,
      reason: `${reason}（由场景绑定与修改时空结算生成原文返回投影）`,
      status: "derived",
    }
  })
  return Array.from({ length: sourceUnitCount }, (_, index) => existing.get(index) ?? derived[index]!)
}

function normalizeArtifactReferences(request: PhaseRequestEnvelope, artifact: unknown): unknown {
  if (request.phase === "semantic_review") {
    return completeApprovedAffectedFrontiers(request, artifact)
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
    mutations: governance.mutations.map((mutation) => {
      switch (mutation.operation) {
        case "create_node":
          return mutation
        case "edit_node":
          return { ...mutation, nodeRef: graphRef(mutation.nodeRef) }
        case "retire_node":
          return {
            ...mutation,
            nodeRef: graphRef(mutation.nodeRef),
            archiveOutletRefs: mutation.archiveOutletRefs.map(graphRef),
          }
        case "create_link":
          return { ...mutation, fromRef: graphRef(mutation.fromRef), toRef: graphRef(mutation.toRef) }
        case "edit_link":
          return {
            ...mutation,
            linkRef: graphRef(mutation.linkRef),
            fromRef: graphRef(mutation.fromRef),
            toRef: graphRef(mutation.toRef),
          }
        case "retire_link":
          return {
            ...mutation,
            linkRef: graphRef(mutation.linkRef),
            archiveOutletRefs: mutation.archiveOutletRefs.map(graphRef),
          }
      }
    }),
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

function completeApprovedAffectedFrontiers(request: PhaseRequestEnvelope, artifact: unknown): unknown {
  const review = semanticReviewArtifactSchema.parse(artifact)
  const input = request.input as TurnPhaseInput
  const governance = graphGovernanceArtifactSchema.parse(input.artifacts.graph_governance)
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

function assertCrossPhaseArtifactContract(request: PhaseRequestEnvelope, artifact: unknown): void {
  const input = request.input as TurnPhaseInput
  if (request.phase === "graph_governance" && input.artifacts.dependency_audit !== undefined) {
    assertSpacetimeGovernanceCoverage(input.artifacts.dependency_audit, artifact, input.sourceUnitIds.length)
  }
  if (request.phase === "semantic_review") {
    assertSemanticReviewCoversGovernance(input.artifacts.graph_governance, artifact)
  }
  if (request.phase === "frontier_settlement") {
    assertFrontierSettlementCoversReview(input.artifacts.semantic_review, artifact)
  }
}

function assertArtifactReferences(request: PhaseRequestEnvelope, artifact: unknown): void {
  if (artifact === undefined) return
  const input = request.input as TurnPhaseInput
  const governance = input.artifacts.graph_governance === undefined
    ? undefined
    : graphGovernanceArtifactSchema.parse(input.artifacts.graph_governance)
  assertPhaseReferenceContract(request.phase, artifact, {
    readableEvidenceIds: new Set(input.readEvidence.map((evidence) => evidence.readId)),
    readableGraphIds: new Set(input.readEvidence
      .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
      .map((evidence) => evidence.ownerId)),
    readableWorkspacePaths: new Set(input.readEvidence
      .filter((evidence) => evidence.ownerKind.startsWith("workspace:"))
      .map((evidence) => evidence.ownerId)),
    declaredLocalGraphRefs: new Set(governance?.mutations.flatMap((mutation) => (
      mutation.operation === "create_node" || mutation.operation === "create_link" ? [mutation.ref] : []
    )) ?? []),
  })
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
