export function deduplicateEvidenceByVersion(evidence) {
  const merged = new Map()
  for (const item of evidence) {
    const key = evidenceVersionKey(item)
    const existing = merged.get(key)
    const canonicalReadId = typeof existing?.canonicalReadId === "string"
      ? existing.canonicalReadId
      : typeof item.canonicalReadId === "string" ? item.canonicalReadId : item.readId
    const aliases = uniqueStrings([
      ...(existing?.readIdAliases ?? []),
      ...(item.readIdAliases ?? []),
      existing?.readId,
      item.readId,
    ]).filter((readId) => readId !== canonicalReadId)
    merged.set(key, {
      ...(existing ?? {}),
      ...item,
      readId: canonicalReadId,
      canonicalReadId,
      readIdAliases: aliases,
      versionKey: key,
    })
  }
  return [...merged.values()]
}

export function readEvidenceProjectionText(database, projectId, evidence) {
  if (typeof evidence.revisionId === "string") {
    return database.prepare(`
      select semantic_text from retrieval_projections
      where project_id = ? and owner_kind = ? and owner_id = ? and owner_revision_id = ? and visibility = 'committed'
      order by rowid desc limit 1
    `).get(projectId, evidence.ownerKind, evidence.ownerId, evidence.revisionId)?.semantic_text ?? evidence.semanticText ?? ""
  }
  return database.prepare(`
    select semantic_text from retrieval_projections
    where project_id = ? and owner_kind = ? and owner_id = ? and visibility = 'committed'
    order by rowid desc limit 1
  `).get(projectId, evidence.ownerKind, evidence.ownerId)?.semantic_text ?? evidence.semanticText ?? ""
}

function evidenceVersionKey(evidence) {
  if (typeof evidence.versionKey === "string" && evidence.versionKey.length > 0) return evidence.versionKey
  const ownerKind = typeof evidence.ownerKind === "string" ? evidence.ownerKind : "unknown"
  const ownerId = typeof evidence.ownerId === "string" ? evidence.ownerId : "unknown"
  const revision = typeof evidence.revisionId === "string"
    ? evidence.revisionId
    : typeof evidence.sourceVersionId === "string" ? evidence.sourceVersionId : undefined
  const pendingScope = typeof evidence.pendingScopeId === "string" ? evidence.pendingScopeId : "committed"
  return revision === undefined ? `read:${String(evidence.readId)}` : `${ownerKind}:${ownerId}:${revision}:${pendingScope}`
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
}
