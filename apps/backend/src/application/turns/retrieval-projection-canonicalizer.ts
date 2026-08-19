import type { ProjectId, ScopeId } from "@worldseed/contracts"

import { digest } from "../../core/index.js"

export type CanonicalRetrievalProjectionInput = Readonly<{
  projectId: ProjectId
  scopeId: ScopeId
  ownerKind: string
  ownerId: string
  ownerRevisionId: string
  exactKeys: readonly string[]
  semanticText: string
  sourceRefs: readonly unknown[]
}>

export function canonicalizeRetrievalProjections(
  projections: readonly CanonicalRetrievalProjectionInput[],
): CanonicalRetrievalProjectionInput[] {
  const groups = new Map<string, {
    projection: CanonicalRetrievalProjectionInput
    exactKeys: string[]
    exactKeySet: Set<string>
    semanticTexts: string[]
    semanticTextSet: Set<string>
    sourceRefs: unknown[]
    sourceRefSet: Set<string>
  }>()

  for (const projection of projections) {
    const key = digest({
      projectId: projection.projectId,
      scopeId: projection.scopeId,
      ownerKind: projection.ownerKind,
      ownerId: projection.ownerId,
      ownerRevisionId: projection.ownerRevisionId,
    })
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        projection,
        exactKeys: [],
        exactKeySet: new Set(),
        semanticTexts: [],
        semanticTextSet: new Set(),
        sourceRefs: [],
        sourceRefSet: new Set(),
      }
      groups.set(key, group)
    }
    appendUniqueStrings(group.exactKeys, group.exactKeySet, projection.exactKeys)
    appendUniqueStrings(group.semanticTexts, group.semanticTextSet, [projection.semanticText])
    for (const sourceRef of projection.sourceRefs) {
      const sourceRefKey = digest(sourceRef)
      if (group.sourceRefSet.has(sourceRefKey)) continue
      group.sourceRefSet.add(sourceRefKey)
      group.sourceRefs.push(sourceRef)
    }
  }

  return [...groups.values()].map((group) => ({
    projectId: group.projection.projectId,
    scopeId: group.projection.scopeId,
    ownerKind: group.projection.ownerKind,
    ownerId: group.projection.ownerId,
    ownerRevisionId: group.projection.ownerRevisionId,
    exactKeys: group.exactKeys,
    semanticText: group.semanticTexts.join("\n"),
    sourceRefs: group.sourceRefs,
  }))
}

function appendUniqueStrings(target: string[], seen: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    target.push(value)
  }
}
