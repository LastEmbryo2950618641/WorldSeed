import type { RelatedOwnerRef, TurnReadEvidence } from "../turns/ports/ai-model-port.js"

export type CanonicalTurnReadEvidence = TurnReadEvidence & Readonly<{
  canonicalReadId: string
  readIdAliases: readonly string[]
  versionKey: string
}>

export type EvidenceVersionOptions = Readonly<{
  scopeId?: string
}>

export type ReadableEvidenceIds = {
  committedReadIds: string[]
  visiblePendingIds: string[]
}

export function mergeEvidenceVersions(
  evidence: readonly TurnReadEvidence[],
  options: EvidenceVersionOptions = {},
): CanonicalTurnReadEvidence[] {
  const merged = new Map<string, CanonicalTurnReadEvidence>()
  for (const item of evidence) {
    const versionKey = evidenceVersionKey(item, options)
    const existing = merged.get(versionKey)
    if (existing === undefined) {
      const canonicalReadId = readCanonicalId(item)
      merged.set(versionKey, {
        ...item,
        readId: canonicalReadId,
        canonicalReadId,
        readIdAliases: collectAliases(canonicalReadId, item),
        versionKey,
      })
      continue
    }
    merged.set(versionKey, mergeEvidence(existing, item))
  }
  return [...merged.values()]
}

export function evidenceVersionKey(
  evidence: TurnReadEvidence,
  options: EvidenceVersionOptions = {},
): string {
  const sourcePosition = evidence.ownerKind === "source" && evidence.sourcePosition !== undefined
    ? {
        sourceRef: evidence.sourcePosition.sourceRef,
        sequence: evidence.sourcePosition.sequence,
      }
    : undefined
  const sourceDigest = evidence.ownerKind === "source" ? evidence.digest : undefined
  if (evidence.visibility === "pending") {
    return JSON.stringify([
      "pending",
      options.scopeId ?? "",
      evidence.ownerKind,
      evidence.ownerId,
      evidence.revisionId ?? "",
      sourcePosition,
      sourceDigest,
    ])
  }
  if (evidence.revisionId !== undefined) {
    return JSON.stringify(["revision", evidence.ownerKind, evidence.ownerId, evidence.revisionId, sourcePosition, sourceDigest])
  }
  return JSON.stringify(["immutable", evidence.ownerKind, evidence.ownerId, sourcePosition, sourceDigest ?? evidence.digest])
}

export function canonicalizeEvidenceReadId(
  readId: string,
  evidence: readonly (TurnReadEvidence & Readonly<{
    canonicalReadId?: string
    readIdAliases?: readonly string[]
  }>)[],
): string {
  for (const item of evidence) {
    const canonicalReadId = item.canonicalReadId ?? item.readId
    if (readId === item.readId || readId === canonicalReadId || item.readIdAliases?.includes(readId) === true) {
      return canonicalReadId
    }
  }
  return readId
}

export function collectReadableEvidenceIds(
  ledger: Readonly<{
    committedReadIds: readonly string[]
    visiblePendingIds: readonly string[]
  }>,
  evidence: readonly TurnReadEvidence[],
): ReadableEvidenceIds {
  const canonicalEvidence = mergeEvidenceVersions(evidence)
  return {
    committedReadIds: uniqueValues([
      ...ledger.committedReadIds,
      ...canonicalEvidence
        .filter((item) => item.visibility === "committed")
        .map((item) => item.readId),
    ]),
    visiblePendingIds: uniqueValues([
      ...ledger.visiblePendingIds,
      ...canonicalEvidence
        .filter((item) => item.visibility === "pending")
        .map((item) => item.readId),
    ]),
  }
}

function mergeEvidence(
  canonical: CanonicalTurnReadEvidence,
  incoming: TurnReadEvidence,
): CanonicalTurnReadEvidence {
  const relatedOwnerRefs = mergeRelatedOwnerRefs(canonical.relatedOwnerRefs, incoming.relatedOwnerRefs)
  return {
    ...canonical,
    ...(incoming.stateRole === undefined ? {} : { stateRole: incoming.stateRole }),
    exactKeys: uniqueValues([...canonical.exactKeys, ...incoming.exactKeys]),
    sourceRefs: uniqueStructuredValues([...canonical.sourceRefs, ...incoming.sourceRefs]),
    ...(relatedOwnerRefs === undefined ? {} : { relatedOwnerRefs }),
    readIdAliases: uniqueValues([
      ...canonical.readIdAliases,
      ...collectAliases(canonical.canonicalReadId, incoming),
    ]),
  }
}

function readCanonicalId(evidence: TurnReadEvidence): string {
  return "canonicalReadId" in evidence && typeof evidence.canonicalReadId === "string"
    ? evidence.canonicalReadId
    : evidence.readId
}

function collectAliases(canonicalReadId: string, evidence: TurnReadEvidence): string[] {
  const aliases = [
    evidence.readId,
    ...("readIdAliases" in evidence && Array.isArray(evidence.readIdAliases)
      ? evidence.readIdAliases.filter((value): value is string => typeof value === "string")
      : []),
  ]
  return uniqueValues(aliases.filter((readId) => readId !== canonicalReadId))
}

function mergeRelatedOwnerRefs(
  left: readonly RelatedOwnerRef[] | undefined,
  right: readonly RelatedOwnerRef[] | undefined,
): readonly RelatedOwnerRef[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])]
  if (values.length === 0) return undefined
  const merged = new Map<string, RelatedOwnerRef>()
  for (const value of values) {
    const key = JSON.stringify([value.ownerKind, value.ownerId, value.revisionId ?? ""])
    const existing = merged.get(key)
    const exactKeys = uniqueValues([...(existing?.exactKeys ?? []), ...(value.exactKeys ?? [])])
    const semanticText = existing?.semanticText ?? value.semanticText
    merged.set(key, existing === undefined ? value : {
      ...existing,
      ...(exactKeys.length === 0 ? {} : { exactKeys }),
      ...(semanticText === undefined ? {} : { semanticText }),
    })
  }
  return [...merged.values()]
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function uniqueStructuredValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
