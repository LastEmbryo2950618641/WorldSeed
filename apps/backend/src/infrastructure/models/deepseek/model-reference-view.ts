import type { PhaseRequestEnvelope } from "@worldseed/contracts"

export type ModelReferenceView = Readonly<{
  request: unknown
  restore<T>(value: T): T
  toModelText(value: string): string
  committedReadTokens: readonly string[]
  visiblePendingTokens: readonly string[]
  graphReferencePairs: readonly string[]
  revisionReadTokens: readonly string[]
  aliasCount: number
}>

export function createModelReferenceView(request: PhaseRequestEnvelope): ModelReferenceView {
  const registry = new ReferenceRegistry()
  registerRequestReferences(request, registry)
  const modelRequest = registry.encode(createModelRequest(request))
  assertNoTechnicalUuids(modelRequest)
  return {
    request: modelRequest,
    restore: <T>(value: T) => registry.decode(value) as T,
    toModelText: (value) => registry.toModelText(value),
    committedReadTokens: request.committedReadIds.map((id) => registry.tokenFor(id)),
    visiblePendingTokens: request.visiblePendingIds.map((id) => registry.tokenFor(id)),
    graphReferencePairs: readGraphReferencePairs(request, registry),
    revisionReadTokens: readRevisionReadTokens(request, registry),
    aliasCount: registry.size,
  }
}

class ReferenceRegistry {
  private readonly actualToToken = new Map<string, string>()
  private readonly tokenToActual = new Map<string, string>()
  private readonly counters = new Map<string, number>()

  public get size(): number {
    return this.actualToToken.size
  }

  public register(actual: string, prefix: string): void {
    if (!isUuid(actual) || this.actualToToken.has(actual)) return
    const next = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, next)
    const token = `${prefix}-${String(next)}`
    this.actualToToken.set(actual, token)
    this.tokenToActual.set(token, actual)
  }

  public tokenFor(actual: string): string {
    const token = this.actualToToken.get(actual)
    if (token !== undefined) return token
    if (isPersistentId(actual)) return actual
    throw new Error(`No model reference alias registered for ${actual}`)
  }

  public encode(value: unknown): unknown {
    if (typeof value === "string") return this.actualToToken.get(value) ?? value
    if (Array.isArray(value)) return value.map((item) => this.encode(item))
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.encode(item)]))
  }

  public decode(value: unknown): unknown {
    if (typeof value === "string") return this.tokenToActual.get(value) ?? value
    if (Array.isArray(value)) return value.map((item) => this.decode(item))
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decode(item)]))
  }

  public toModelText(value: string): string {
    let result = value
    for (const [actual, token] of this.actualToToken) {
      result = result.replaceAll(actual, token)
    }
    return result.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,
      "internal-id",
    )
  }
}

function registerRequestReferences(request: PhaseRequestEnvelope, registry: ReferenceRegistry): void {
  for (const id of request.committedReadIds) registry.register(id, "read")
  for (const id of request.visiblePendingIds) registry.register(id, "read")

  if (!isRecord(request.input)) return
  if (Array.isArray(request.input.readEvidence)) {
    for (const evidence of request.input.readEvidence) {
      if (!isRecord(evidence)) continue
      registerIfUuid(evidence.readId, "read", registry)
      if (isRecord(evidence.sourcePosition)) {
        registerIfUuid(evidence.sourcePosition.sourceRef, "source", registry)
      }
      if (evidence.ownerKind === "node" || evidence.ownerKind === "link") {
        registerIfUuid(evidence.ownerId, evidence.ownerKind, registry)
      }
      if (Array.isArray(evidence.relatedOwnerRefs)) {
        for (const relatedOwner of evidence.relatedOwnerRefs) {
          if (!isRecord(relatedOwner)) continue
          if (relatedOwner.ownerKind !== "node" && relatedOwner.ownerKind !== "link") continue
          registerIfUuid(relatedOwner.ownerId, relatedOwner.ownerKind, registry)
        }
      }
    }
  }
}

function readGraphReferencePairs(request: PhaseRequestEnvelope, registry: ReferenceRegistry): string[] {
  if (!isRecord(request.input) || !Array.isArray(request.input.readEvidence)) return []
  return request.input.readEvidence.flatMap((evidence) => {
    if (!isRecord(evidence) || (evidence.ownerKind !== "node" && evidence.ownerKind !== "link")) return []
    if (typeof evidence.readId !== "string" || typeof evidence.ownerId !== "string") return []
    return [`${registry.tokenFor(evidence.readId)} -> ${registry.tokenFor(evidence.ownerId)}`]
  })
}

function readRevisionReadTokens(request: PhaseRequestEnvelope, registry: ReferenceRegistry): string[] {
  if (!isRecord(request.input) || !Array.isArray(request.input.readEvidence)) return []
  return request.input.readEvidence.flatMap((evidence) => {
    if (!isRecord(evidence) || typeof evidence.revisionId !== "string" || typeof evidence.readId !== "string") return []
    return [registry.tokenFor(evidence.readId)]
  })
}

function createModelRequest(request: PhaseRequestEnvelope): unknown {
  return {
    phase: request.phase,
    protocolVersion: request.protocolVersion,
    committedReadIds: request.committedReadIds,
    visiblePendingIds: request.visiblePendingIds,
    remainingBudget: request.remainingBudget,
    input: createModelInput(request.input),
  }
}

function createModelInput(value: unknown): unknown {
  if (!isRecord(value)) return value
  const {
    sourceId: ignoredSourceId,
    sourceUnitIds: ignoredSourceUnitIds,
    phaseRunIds: ignoredPhaseRunIds,
    workspaceCatalog,
    readEvidence,
    retrievalGaps,
    verificationProbeExecutions,
    validationArtifacts: ignoredValidationArtifacts,
    stageProjection,
    ...semanticInput
  } = value
  void ignoredSourceId
  void ignoredSourceUnitIds
  void ignoredPhaseRunIds
  void ignoredValidationArtifacts
  return {
    ...semanticInput,
    ...(stageProjection === undefined ? {} : { stageProjection: createModelStageProjection(stageProjection) }),
    ...(Array.isArray(readEvidence)
      ? { readEvidence: readEvidence.map(createModelReadEvidence) }
      : readEvidence === undefined ? {} : { readEvidence }),
    ...(Array.isArray(retrievalGaps)
      ? { retrievalGaps: retrievalGaps.map(createModelRetrievalGap) }
      : retrievalGaps === undefined ? {} : { retrievalGaps }),
    ...(Array.isArray(verificationProbeExecutions)
      ? { verificationProbeExecutions: verificationProbeExecutions.map(createModelVerificationProbeExecution) }
      : verificationProbeExecutions === undefined ? {} : { verificationProbeExecutions }),
    ...(isRecord(workspaceCatalog)
      ? { workspaceCatalog: { entries: workspaceCatalog.entries } }
      : workspaceCatalog === undefined ? {} : { workspaceCatalog }),
  }
}

function createModelStageProjection(value: unknown): unknown {
  if (!isRecord(value)) return value
  const pendingScope = isRecord(value.pendingScope) ? value.pendingScope : undefined
  const verificationProbeExecutions = Array.isArray(value.verificationProbeExecutions)
    ? value.verificationProbeExecutions.map(createModelVerificationProbeExecution)
    : undefined
  const modelPendingScope = pendingScope === undefined
    ? undefined
    : Object.fromEntries(Object.entries(pendingScope).filter(([key]) => key !== "scopeId"))
  return {
    ...value,
    ...(modelPendingScope === undefined ? {} : { pendingScope: modelPendingScope }),
    ...(verificationProbeExecutions === undefined ? {} : { verificationProbeExecutions }),
  }
}

function createModelVerificationProbeExecution(value: unknown): unknown {
  if (!isRecord(value)) return value
  const {
    requestId: ignoredRequestId,
    operationId: ignoredOperationId,
    ...execution
  } = value
  void ignoredRequestId
  void ignoredOperationId
  return execution
}

function createModelReadEvidence(value: unknown): unknown {
  if (!isRecord(value)) return value
  const {
    revisionId: ignoredRevisionId,
    sourceRefs: ignoredSourceRefs,
    canonicalReadId: ignoredCanonicalReadId,
    readIdAliases: ignoredReadIdAliases,
    ownerId,
    ownerKind,
    relatedOwnerRefs,
    ...evidence
  } = value
  void ignoredRevisionId
  void ignoredSourceRefs
  void ignoredCanonicalReadId
  void ignoredReadIdAliases
  const modelRelatedOwnerRefs = Array.isArray(relatedOwnerRefs)
    ? relatedOwnerRefs.flatMap((relatedOwner) => {
      if (!isRecord(relatedOwner)
        || (relatedOwner.ownerKind !== "node" && relatedOwner.ownerKind !== "link")
        || typeof relatedOwner.ownerId !== "string") return []
      return [{
        ownerKind: relatedOwner.ownerKind,
        ownerId: relatedOwner.ownerId,
        ...(Array.isArray(relatedOwner.exactKeys) ? { exactKeys: relatedOwner.exactKeys } : {}),
        ...(typeof relatedOwner.semanticText === "string" ? { semanticText: relatedOwner.semanticText } : {}),
      }]
    })
    : []
  const modelCanAddressOwner = ownerKind === "node" || ownerKind === "link"
    || typeof ownerId !== "string" || !isUuid(ownerId)
  return {
    ...evidence,
    ownerKind,
    ...(modelRelatedOwnerRefs.length > 0 ? { relatedOwnerRefs: modelRelatedOwnerRefs } : {}),
    ...(modelCanAddressOwner ? { ownerId } : {}),
  }
}

function createModelRetrievalGap(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { requestId: ignoredRequestId, ...gap } = value
  void ignoredRequestId
  return gap
}

function registerIfUuid(value: unknown, prefix: string, registry: ReferenceRegistry): void {
  if (typeof value === "string") registry.register(value, prefix)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function isPersistentId(value: string): boolean {
  return /^(?:node|link|evidence|source|revision)_[1-9][0-9]*$/u.test(value)
}

function assertNoTechnicalUuids(value: unknown): void {
  if (typeof value === "string") {
    if (isUuid(value)) throw new Error(`Model request contains an unregistered technical UUID: ${value}`)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoTechnicalUuids(item)
    return
  }
  if (!isRecord(value)) return
  for (const item of Object.values(value)) assertNoTechnicalUuids(item)
}
