import type { PhaseRequestEnvelope, VisibleModelContextMessage } from "@worldseed/contracts"

export const MODEL_CONTEXT_DELTA_HEADER = "Worldseed context delta JSON:"

export class ModelContextAppender {
  public createDelta(
    request: PhaseRequestEnvelope,
    modelRequest: unknown,
    previousMessages: readonly VisibleModelContextMessage[],
  ): unknown {
    const source = asRecord(modelRequest)
    const input = asRecord(source.input)
    const previousDeltas = previousMessages.flatMap((message) => parseDelta(message.content))
    const previousInputs = previousDeltas.map((delta) => asRecord(asRecord(delta).input))
    const firstRequestInTurn = !previousMessages.some((message) => (
      message.turnId === request.turnId && message.kind === "phase_request"
    ))
    const resurfacedReadIds = arrayOfStrings(input.resurfacedReadIds)
    const readEvidence = selectNewEvidence(input.readEvidence, previousInputs, resurfacedReadIds)
    const presentationEvidence = readEvidence.filter(isPresentationEvidence)
    const factualEvidence = readEvidence.filter((evidence) => !isPresentationEvidence(evidence))
    const readIds = new Set(readEvidence.flatMap((value) => {
      const readId = asRecord(value).readId
      return typeof readId === "string" ? [readId] : []
    }))
    const retrievalGaps = selectNewStructuralValues(input.retrievalGaps, previousInputs, "retrievalGaps")
    const graphCapacity = selectChangedStructuralValue(input.graphCapacity, previousInputs, "graphCapacity")
    const verificationProbeExecutions = selectNewProbeExecutions(
      input.verificationProbeExecutions,
      previousInputs,
    )
    const stageProjection = selectChangedStageProjection(input.stageProjection, previousInputs)
    const artifacts = selectChangedPhaseArtifacts(input.artifacts, previousDeltas, request.phase)
    const workspaceCatalogAlreadyVisible = previousInputs.some((previous) => previous.workspaceCatalog !== undefined)
    const coreInput = firstRequestInTurn ? selectCoreTurnInput(input) : {}
    const deltaInput = {
      ...(input.workspaceCatalog === undefined || workspaceCatalogAlreadyVisible
        ? {}
        : { workspaceCatalog: input.workspaceCatalog }),
      ...(factualEvidence.length === 0 ? {} : { readEvidence: factualEvidence }),
      ...(resurfacedReadIds.length === 0 ? {} : { resurfacedReadIds }),
      ...coreInput,
      ...(presentationEvidence.length === 0 ? {} : { presentationEvidence }),
      ...(retrievalGaps.length === 0 ? {} : { retrievalGaps }),
      ...(graphCapacity === undefined ? {} : { graphCapacity }),
      ...(verificationProbeExecutions.length === 0 ? {} : { verificationProbeExecutions }),
      ...(stageProjection === undefined ? {} : { stageProjection }),
      ...(Object.keys(artifacts).length === 0 ? {} : { artifacts }),
    }
    const committedReadIds = arrayOfStrings(source.committedReadIds).filter((readId) => readIds.has(readId))
    const visiblePendingIds = arrayOfStrings(source.visiblePendingIds).filter((readId) => readIds.has(readId))
    return {
      phase: source.phase,
      protocolVersion: source.protocolVersion,
      committedReadIds,
      visiblePendingIds,
      remainingBudget: source.remainingBudget,
      input: deltaInput,
    }
  }

  public formatDelta(delta: unknown): string {
    return `${MODEL_CONTEXT_DELTA_HEADER}\n${JSON.stringify(delta)}`
  }
}

function selectChangedStageProjection(
  value: unknown,
  previousInputs: readonly Record<string, unknown>[],
): unknown {
  if (value === undefined) return undefined
  const projection = asRecord(value)
  const projectionDigest = projection.projectionDigest
  if (typeof projectionDigest !== "string") {
    return selectChangedStructuralValue(value, previousInputs, "stageProjection")
  }
  const alreadyVisible = previousInputs.some((input) => (
    asRecord(input.stageProjection).projectionDigest === projectionDigest
  ))
  return alreadyVisible ? undefined : value
}

function isPresentationEvidence(value: unknown): boolean {
  return asRecord(value).ownerKind === "workspace:presentation"
}

function selectCoreTurnInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    "workflow",
    "userInput",
    "chapterSequence",
    "allowWorkspaceChapterReads",
    "presentation",
    "projectSettings",
    // Assist/discuss sessions are not on the continuous deduction chain; their
    // envelopes (incl. conversationHistory) must ride the first-turn delta.
    "synopsisDiscuss",
    "revisionAssist",
  ].flatMap((key) => input[key] === undefined ? [] : [[key, input[key]]]))
}

function selectChangedStructuralValue(
  value: unknown,
  previousInputs: readonly Record<string, unknown>[],
  key: string,
): unknown {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  const previousValues = previousInputs.flatMap((input) => (
    input[key] === undefined ? [] : [JSON.stringify(input[key])]
  ))
  return previousValues.at(-1) === serialized ? undefined : value
}

function selectNewEvidence(
  value: unknown,
  previousInputs: readonly Record<string, unknown>[],
  resurfacedReadIds: readonly string[],
): unknown[] {
  if (!Array.isArray(value)) return []
  const resurfaced = new Set(resurfacedReadIds)
  const previousIdentities = new Set(previousInputs.flatMap((input) => [
    ...arrayOfUnknowns(input.readEvidence),
    ...arrayOfUnknowns(input.presentationEvidence),
  ].flatMap(evidenceIdentities)))
  return value.filter((evidence) => {
    if (evidenceReadIds(evidence).some((readId) => resurfaced.has(readId))) return true
    const identities = evidenceIdentities(evidence)
    return identities.length === 0 || !identities.some((identity) => previousIdentities.has(identity))
  })
}

function evidenceReadIds(value: unknown): string[] {
  const evidence = asRecord(value)
  return [
    evidence.readId,
    evidence.canonicalReadId,
    ...arrayOfUnknowns(evidence.readIdAliases),
  ].filter((readId): readId is string => typeof readId === "string")
}

function evidenceIdentities(value: unknown): string[] {
  const evidence = asRecord(value)
  return [
    ...(typeof evidence.versionKey === "string" ? [`version:${evidence.versionKey}`] : []),
    ...evidenceReadIds(evidence).map((readId) => `read:${readId}`),
  ]
}

function selectNewStructuralValues(
  value: unknown,
  previousInputs: readonly Record<string, unknown>[],
  key: string,
): unknown[] {
  if (!Array.isArray(value)) return []
  const previous = new Set(previousInputs.flatMap((input) => (
    Array.isArray(input[key]) ? input[key].map((item) => JSON.stringify(item)) : []
  )))
  return value.filter((item) => !previous.has(JSON.stringify(item)))
}

function selectNewProbeExecutions(
  value: unknown,
  previousInputs: readonly Record<string, unknown>[],
): unknown[] {
  if (!Array.isArray(value)) return []
  const previousIndexes = new Set(previousInputs.flatMap((input) => (
    Array.isArray(input.verificationProbeExecutions)
      ? input.verificationProbeExecutions.flatMap((item) => {
        const probeIndex = asRecord(item).probeIndex
        return typeof probeIndex === "number" ? [probeIndex] : []
      })
      : []
  )))
  return value.filter((item) => {
    const probeIndex = asRecord(item).probeIndex
    return typeof probeIndex !== "number" || !previousIndexes.has(probeIndex)
  })
}

function selectChangedPhaseArtifacts(
  value: unknown,
  previousDeltas: readonly unknown[],
  phase: PhaseRequestEnvelope["phase"],
): Record<string, unknown> {
  const artifacts = asRecord(value)
  const previousPhaseArtifacts = previousDeltas
    .filter((delta) => asRecord(delta).phase === phase)
    .map((delta) => asRecord(asRecord(delta).input).artifacts)
    .map(asRecord)
  return Object.fromEntries(Object.entries(artifacts).filter(([artifactPhase, artifact]) => {
    const previousArtifact = previousPhaseArtifacts
      .flatMap((previous) => previous[artifactPhase] === undefined ? [] : [previous[artifactPhase]])
      .at(-1)
    return previousArtifact === undefined || JSON.stringify(previousArtifact) !== JSON.stringify(artifact)
  }))
}

function parseDelta(content: string): unknown[] {
  if (!content.startsWith(`${MODEL_CONTEXT_DELTA_HEADER}\n`)) return []
  try {
    return [JSON.parse(content.slice(MODEL_CONTEXT_DELTA_HEADER.length + 1)) as unknown]
  } catch {
    return []
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function arrayOfUnknowns(value: unknown): unknown[] {
  return Array.isArray(value) ? value as unknown[] : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
