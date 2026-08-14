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
    const previousValues = JSON.stringify(previousDeltas)
    const firstRequestInTurn = !previousMessages.some((message) => (
      message.turnId === request.turnId && message.kind === "phase_request"
    ))
    const readEvidence = selectNewEvidence(input.readEvidence, previousValues)
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
    const artifacts = selectUnrepresentedArtifacts(input.artifacts, previousMessages)
    const workspaceCatalogAlreadyVisible = previousInputs.some((previous) => previous.workspaceCatalog !== undefined)
    const coreInput = firstRequestInTurn ? selectCoreTurnInput(input) : {}
    const deltaInput = {
      ...(input.workspaceCatalog === undefined || workspaceCatalogAlreadyVisible
        ? {}
        : { workspaceCatalog: input.workspaceCatalog }),
      ...(factualEvidence.length === 0 ? {} : { readEvidence: factualEvidence }),
      ...coreInput,
      ...(presentationEvidence.length === 0 ? {} : { presentationEvidence }),
      ...(retrievalGaps.length === 0 ? {} : { retrievalGaps }),
      ...(graphCapacity === undefined ? {} : { graphCapacity }),
      ...(verificationProbeExecutions.length === 0 ? {} : { verificationProbeExecutions }),
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

function selectNewEvidence(value: unknown, previousValues: string): unknown[] {
  if (!Array.isArray(value)) return []
  return value.filter((evidence) => {
    const readId = asRecord(evidence).readId
    return typeof readId !== "string" || !previousValues.includes(JSON.stringify(readId))
  })
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

function selectUnrepresentedArtifacts(
  value: unknown,
  previousMessages: readonly VisibleModelContextMessage[],
): Record<string, unknown> {
  const artifacts = asRecord(value)
  return Object.fromEntries(Object.entries(artifacts).filter(([phase]) => !previousMessages.some((message) => (
    message.kind === "phase_response" && message.phase === phase
  ))))
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
