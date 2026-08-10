import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { ProjectId, ScopeId } from "@worldseed/contracts"

import type {
  RetrievalProjection,
  RetrievalRepository,
  RetrievalSearchScope,
  SourceSequenceAnchor,
} from "../../../application/index.js"
import type { ProjectDatabase, RetrievalProjectionRow } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteRetrievalRepository implements RetrievalRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async stageProjection(
    projection: Omit<RetrievalProjection, "visibility">,
  ): Promise<RetrievalProjection> {
    await assertPendingScope(this.database, projection.projectId, projection.scopeId)
    await this.insertProjection(projection, "pending")
    return { ...projection, visibility: "pending" as const }
  }

  public async indexCommittedSourceProjection(
    projection: Omit<RetrievalProjection, "visibility">,
  ): Promise<void> {
    if (projection.ownerKind !== "source") {
      throw new Error("Committed source indexing only accepts source projections")
    }
    const committedSource = await this.database.selectFrom("source_units")
      .innerJoin("document_versions", "document_versions.source_id", "source_units.source_id")
      .select("document_versions.scope_id")
      .where("source_units.project_id", "=", projection.projectId)
      .where("source_units.id", "=", projection.ownerId)
      .where("document_versions.visibility", "=", "committed")
      .executeTakeFirst()
    if (committedSource?.scope_id !== projection.scopeId) {
      throw new Error(`Cannot index an uncommitted source unit: ${projection.ownerId}`)
    }
    const existing = await this.database.selectFrom("retrieval_projections")
      .select("id")
      .where("project_id", "=", projection.projectId)
      .where("owner_kind", "=", "source")
      .where("owner_id", "=", projection.ownerId)
      .where("owner_revision_id", "=", projection.ownerRevisionId)
      .where("visibility", "=", "committed")
      .executeTakeFirst()
    if (existing !== undefined) return
    await this.insertProjection(projection, "committed")
  }

  public async listUnindexedCommittedSourceUnits(projectId: ProjectId): Promise<readonly Readonly<{
    sourceUnitId: string
    sourceId: string
    scopeId: ScopeId
    sequence: number
    contentRef: string
    digest: string
  }>[]> {
    const rows = await this.database.selectFrom("source_units")
      .innerJoin("document_versions", "document_versions.source_id", "source_units.source_id")
      .leftJoin("retrieval_projections", (join) => join
        .onRef("retrieval_projections.owner_id", "=", "source_units.id")
        .on("retrieval_projections.owner_kind", "=", "source")
        .on("retrieval_projections.visibility", "=", "committed"))
      .select([
        "source_units.id as source_unit_id",
        "source_units.source_id",
        "document_versions.scope_id",
        "source_units.sequence_no",
        "source_units.content_ref",
        "source_units.digest",
      ])
      .where("source_units.project_id", "=", projectId)
      .where("document_versions.visibility", "=", "committed")
      .where("retrieval_projections.id", "is", null)
      .orderBy("document_versions.created_at")
      .orderBy("source_units.sequence_no")
      .execute()
    return rows.map((row) => ({
      sourceUnitId: row.source_unit_id,
      sourceId: row.source_id,
      scopeId: row.scope_id,
      sequence: row.sequence_no,
      contentRef: row.content_ref,
      digest: row.digest,
    }))
  }

  private async insertProjection(
    projection: Omit<RetrievalProjection, "visibility">,
    visibility: "pending" | "committed",
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("retrieval_projections").values({
        id: projection.projectionId,
        project_id: projection.projectId,
        scope_id: projection.scopeId,
        owner_kind: projection.ownerKind,
        owner_id: projection.ownerId,
        owner_revision_id: projection.ownerRevisionId,
        visibility,
        exact_keys_json: encodeJson(projection.exactKeys),
        semantic_text: projection.semanticText,
        source_refs_json: encodeJson(projection.sourceRefs),
        digest: projection.digest,
      }).executeTakeFirstOrThrow()

      if (projection.exactKeys.length > 0) {
        await transaction.insertInto("retrieval_exact_keys").values(projection.exactKeys.map((key) => ({
          project_id: projection.projectId,
          projection_id: projection.projectionId,
          exact_key: key,
          owner_id: projection.ownerId,
        }))).execute()
      }
      await sql`
        INSERT INTO retrieval_fts(projection_id, project_id, scope_id, visibility, semantic_text)
        VALUES (
          ${projection.projectionId}, ${projection.projectId}, ${projection.scopeId},
          ${visibility}, ${projection.semanticText}
        )
      `.execute(transaction)
    })
  }

  public async findForOwnerRevision(
    projectId: ProjectId,
    ownerKind: "node" | "link",
    ownerId: string,
    ownerRevisionId: string,
  ): Promise<RetrievalProjection | undefined> {
    const row = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("project_id", "=", projectId)
      .where("owner_kind", "=", ownerKind)
      .where("owner_id", "=", ownerId)
      .where("owner_revision_id", "=", ownerRevisionId)
      .where("visibility", "!=", "retired")
      .orderBy("id", "desc")
      .executeTakeFirst()
    if (row === undefined) return undefined
    const projection = mapProjection(row)
    const current = await this.findCurrentGraphProjections({ projectId }, [ownerId])
    return {
      ...projection,
      stateRole: current.some((candidate) => candidate.ownerRevisionId === ownerRevisionId)
        ? "current"
        : "historical",
    }
  }

  public async findCurrentForOwners(
    scope: RetrievalSearchScope,
    ownerIds: readonly string[],
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    if (ownerIds.length === 0 || limit <= 0) return []
    return (await this.findCurrentGraphProjections(scope, ownerIds)).slice(0, limit)
  }

  public async searchExact(
    scope: RetrievalSearchScope,
    keys: readonly string[],
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    if (keys.length === 0 || limit <= 0) {
      return []
    }
    let query = this.database.selectFrom("retrieval_exact_keys")
      .innerJoin("retrieval_projections", "retrieval_projections.id", "retrieval_exact_keys.projection_id")
      .selectAll("retrieval_projections")
      .where("retrieval_exact_keys.project_id", "=", scope.projectId)
      .where("retrieval_exact_keys.exact_key", "in", [...keys])

    query = scope.pendingScopeId === undefined
      ? query.where("retrieval_projections.visibility", "=", "committed")
      : query.where((expressions) => expressions.or([
          expressions("retrieval_projections.visibility", "=", "committed"),
          expressions.and([
            expressions("retrieval_projections.visibility", "=", "pending"),
            expressions("retrieval_projections.scope_id", "=", scope.pendingScopeId as string),
          ]),
        ]))

    const rows = await query.limit(limit).execute()
    const currentProjections = await this.findCurrentGraphProjections(scope)
    const currentMatches = currentProjections
      .filter((projection) => projection.exactKeys.some((key) => keys.includes(key)))
    return closeGraphProjectionCandidates([
      ...currentMatches,
      ...rows.map(mapProjection),
    ], currentProjections, limit)
  }

  public async searchText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedExpression = expression.trim()
    if (normalizedExpression.length === 0 || limit <= 0) {
      return []
    }
    const currentProjections = await this.findCurrentGraphProjections(scope)
    const matches = codePointLength(normalizedExpression) <= 2
      ? await this.searchShortText(scope, normalizedExpression, limit)
      : await this.searchFts(scope, normalizedExpression, limit)
    const currentMatches = codePointLength(normalizedExpression) <= 2
      ? currentProjections.filter((projection) => projection.semanticText.includes(normalizedExpression))
      : await this.searchCurrentFts(
        scope,
        normalizedExpression,
        Math.max(limit, currentProjections.length),
        currentProjections.map((projection) => projection.projectionId),
      )
    const shortTerms = extractShortSearchTerms(normalizedExpression)
    const shortTextMatches = shortTerms.length === 0
      ? []
      : (await Promise.all(shortTerms.map((term) => this.searchShortText(scope, term, limit)))).flat()
    const currentShortMatches = shortTerms.length === 0
      ? []
      : currentProjections.filter((projection) => shortTerms.some((term) => projection.semanticText.includes(term)))
    const projectionIds = matches.map((row) => row.projection_id)
    if (projectionIds.length === 0 && currentMatches.length === 0 && shortTextMatches.length === 0 && currentShortMatches.length === 0) {
      return []
    }
    const rows = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("id", "in", [...new Set([
        ...projectionIds,
        ...currentMatches.map((projection) => projection.projectionId),
        ...shortTextMatches.map((row) => row.projection_id),
        ...currentShortMatches.map((projection) => projection.projectionId),
      ])])
      .execute()
    const byId = new Map(rows.map((row) => [row.id, mapProjection(row)]))
    return closeGraphProjectionCandidates([
      ...currentMatches,
      ...currentShortMatches,
      ...projectionIds.flatMap((projectionId) => {
        const projection = byId.get(projectionId)
        return projection === undefined ? [] : [projection]
      }),
      ...shortTextMatches.flatMap((match) => {
        const projection = byId.get(match.projection_id)
        return projection === undefined ? [] : [projection]
      }),
    ], currentProjections, limit)
  }

  public async searchSourceText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    sourceIds?: readonly string[],
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedExpression = expression.trim()
    if (normalizedExpression.length === 0 || limit <= 0 || sourceIds?.length === 0) {
      return []
    }
    const matches = codePointLength(normalizedExpression) <= 2
      ? await this.searchShortSourceText(scope, normalizedExpression, limit, sourceIds)
      : await this.searchFts(scope, normalizedExpression, limit, sourceIds)
    const shortTerms = extractShortSearchTerms(normalizedExpression)
    const shortTextMatches = shortTerms.length === 0
      ? []
      : (await Promise.all(shortTerms.map((term) => this.searchShortSourceText(scope, term, limit, sourceIds)))).flat()
    if (matches.length === 0 && shortTextMatches.length === 0) return []
    const rows = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("id", "in", [...new Set([
        ...matches.map((match) => match.projection_id),
        ...shortTextMatches.map((match) => match.projection_id),
      ])])
      .execute()
    const byId = new Map(rows.map((row) => [row.id, mapProjection(row)]))
    return uniqueProjections([...matches, ...shortTextMatches].flatMap((match) => {
      const projection = byId.get(match.projection_id)
      return projection === undefined ? [] : [projection]
    }), limit)
  }

  public async expandSourceNeighborhood(
    scope: RetrievalSearchScope,
    anchors: readonly SourceSequenceAnchor[],
    maxDistance: number,
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedDistance = Math.max(0, Math.floor(maxDistance))
    const normalizedAnchors = [...new Map(anchors
      .filter((anchor) => anchor.sourceId.length > 0 && Number.isSafeInteger(anchor.sequence) && anchor.sequence >= 0)
      .map((anchor) => [`${anchor.sourceId}:${String(anchor.sequence)}`, anchor])).values()]
    if (normalizedAnchors.length === 0 || limit <= 0) return []

    const neighborhoods = await Promise.all(normalizedAnchors.map(async (anchor, anchorIndex) => {
      let query = this.database.selectFrom("retrieval_projections")
        .innerJoin("source_units", "source_units.id", "retrieval_projections.owner_id")
        .selectAll("retrieval_projections")
        .select("source_units.sequence_no as source_sequence")
        .where("retrieval_projections.project_id", "=", scope.projectId)
        .where("retrieval_projections.owner_kind", "=", "source")
        .where("source_units.project_id", "=", scope.projectId)
        .where("source_units.source_id", "=", anchor.sourceId)
        .where("source_units.sequence_no", ">=", Math.max(0, anchor.sequence - normalizedDistance))
        .where("source_units.sequence_no", "<=", anchor.sequence + normalizedDistance)
      query = scope.pendingScopeId === undefined
        ? query.where("retrieval_projections.visibility", "=", "committed")
        : query.where((expressions) => expressions.or([
            expressions("retrieval_projections.visibility", "=", "committed"),
            expressions.and([
              expressions("retrieval_projections.visibility", "=", "pending"),
              expressions("retrieval_projections.scope_id", "=", scope.pendingScopeId as string),
            ]),
          ]))
      const rows = await query.orderBy("source_units.sequence_no").execute()
      return rows.map((row) => ({
        projection: mapProjection(row),
        anchorIndex,
        sequence: row.source_sequence,
        distance: Math.abs(row.source_sequence - anchor.sequence),
      }))
    }))

    const nearestByProjectionId = new Map<string, (typeof neighborhoods)[number][number]>()
    for (const candidate of neighborhoods.flat()) {
      const existing = nearestByProjectionId.get(candidate.projection.projectionId)
      if (existing === undefined
        || candidate.distance < existing.distance
        || (candidate.distance === existing.distance && candidate.anchorIndex < existing.anchorIndex)) {
        nearestByProjectionId.set(candidate.projection.projectionId, candidate)
      }
    }
    const selected = [...nearestByProjectionId.values()]
      .sort((left, right) => left.distance - right.distance
        || left.anchorIndex - right.anchorIndex
        || left.sequence - right.sequence)
      .slice(0, limit)
    return selected
      .sort((left, right) => left.anchorIndex - right.anchorIndex || left.sequence - right.sequence)
      .map((candidate) => candidate.projection)
  }

  private async searchFts(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    sourceIds?: readonly string[],
  ): Promise<readonly { projection_id: string }[]> {
    const semanticQuery = buildSemanticFtsQuery(expression)
    if (semanticQuery.length === 0) return []
    const sourceFilter = sourceProjectionFilter(scope.projectId, sourceIds)
    const matches = scope.pendingScopeId === undefined
      ? await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND visibility = 'committed'
            ${sourceFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
      : await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND (visibility = 'committed' OR (visibility = 'pending' AND scope_id = ${scope.pendingScopeId}))
            ${sourceFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
    return matches.rows
  }

  private async searchShortSourceText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    sourceIds?: readonly string[],
  ): Promise<readonly { projection_id: string }[]> {
    let query = this.database.selectFrom("retrieval_projections")
      .innerJoin("source_units", "source_units.id", "retrieval_projections.owner_id")
      .select("retrieval_projections.id as projection_id")
      .where("retrieval_projections.project_id", "=", scope.projectId)
      .where("retrieval_projections.owner_kind", "=", "source")
      .where(sql<boolean>`instr(retrieval_projections.semantic_text, ${expression}) > 0`)
    if (sourceIds !== undefined) {
      query = query.where("source_units.source_id", "in", [...sourceIds])
    }
    query = scope.pendingScopeId === undefined
      ? query.where("retrieval_projections.visibility", "=", "committed")
      : query.where((expressions) => expressions.or([
          expressions("retrieval_projections.visibility", "=", "committed"),
          expressions.and([
            expressions("retrieval_projections.visibility", "=", "pending"),
            expressions("retrieval_projections.scope_id", "=", scope.pendingScopeId as string),
          ]),
        ]))
    return query.limit(limit).execute()
  }

  private async searchCurrentFts(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    projectionIds: readonly string[],
  ): Promise<readonly RetrievalProjection[]> {
    if (projectionIds.length === 0 || limit <= 0) return []
    const semanticQuery = buildSemanticFtsQuery(expression)
    if (semanticQuery.length === 0) return []
    const projectionFilter = sql`AND projection_id IN (${sql.join(
      projectionIds.map((projectionId) => sql`${projectionId}`),
      sql`, `,
    )})`
    const matches = scope.pendingScopeId === undefined
      ? await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND visibility = 'committed'
            ${projectionFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
      : await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND (visibility = 'committed' OR (visibility = 'pending' AND scope_id = ${scope.pendingScopeId}))
            ${projectionFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
    const rows = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("id", "in", matches.rows.map((match) => match.projection_id))
      .execute()
    const byId = new Map(rows.map((row) => [row.id, mapProjection(row)]))
    return matches.rows.flatMap((match) => {
      const projection = byId.get(match.projection_id)
      return projection === undefined ? [] : [projection]
    })
  }

  private async searchShortText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
  ): Promise<readonly { projection_id: string }[]> {
    const query = this.database.selectFrom("retrieval_projections")
      .select("id as projection_id")
      .where("project_id", "=", scope.projectId)
      .where(sql<boolean>`instr(semantic_text, ${expression}) > 0`)
    const visibleQuery = scope.pendingScopeId === undefined
      ? query.where("visibility", "=", "committed")
      : query.where((expressions) => expressions.or([
          expressions("visibility", "=", "committed"),
          expressions.and([
            expressions("visibility", "=", "pending"),
            expressions("scope_id", "=", scope.pendingScopeId as string),
          ]),
        ]))
    return visibleQuery.limit(limit).execute()
  }

  private async findCurrentGraphProjections(
    scope: RetrievalSearchScope,
    ownerIds?: readonly string[],
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedOwnerIds = ownerIds === undefined ? undefined : [...new Set(ownerIds)]
    if (normalizedOwnerIds?.length === 0) return []
    let committedNodeQuery = this.database.selectFrom("node_heads").select(["node_id", "revision_id", "visibility"])
      .where("project_id", "=", scope.projectId)
      .where("scope_key", "=", "committed")
    let committedLinkQuery = this.database.selectFrom("link_heads").select(["link_id", "revision_id", "visibility"])
      .where("project_id", "=", scope.projectId)
      .where("scope_key", "=", "committed")
    if (normalizedOwnerIds !== undefined) {
      committedNodeQuery = committedNodeQuery.where("node_id", "in", normalizedOwnerIds)
      committedLinkQuery = committedLinkQuery.where("link_id", "in", normalizedOwnerIds)
    }
    const [committedNodeHeads, committedLinkHeads] = await Promise.all([
      committedNodeQuery.execute(),
      committedLinkQuery.execute(),
    ])
    const currentRevisions = new Map<string, string>()
    for (const head of committedNodeHeads) {
      if (head.visibility !== "retired") currentRevisions.set(`node:${head.node_id}`, head.revision_id)
    }
    for (const head of committedLinkHeads) {
      if (head.visibility !== "retired") currentRevisions.set(`link:${head.link_id}`, head.revision_id)
    }

    if (scope.pendingScopeId !== undefined && await pendingScopeIsVisible(this.database, scope.pendingScopeId)) {
      let pendingNodeQuery = this.database.selectFrom("node_heads").select(["node_id", "revision_id", "visibility"])
          .where("project_id", "=", scope.projectId)
          .where("scope_key", "=", scope.pendingScopeId)
      let pendingLinkQuery = this.database.selectFrom("link_heads").select(["link_id", "revision_id", "visibility"])
          .where("project_id", "=", scope.projectId)
          .where("scope_key", "=", scope.pendingScopeId)
      if (normalizedOwnerIds !== undefined) {
        pendingNodeQuery = pendingNodeQuery.where("node_id", "in", normalizedOwnerIds)
        pendingLinkQuery = pendingLinkQuery.where("link_id", "in", normalizedOwnerIds)
      }
      const [pendingNodeHeads, pendingLinkHeads] = await Promise.all([
        pendingNodeQuery.execute(),
        pendingLinkQuery.execute(),
      ])
      for (const head of pendingNodeHeads) {
        const key = `node:${head.node_id}`
        if (head.visibility === "retired") currentRevisions.delete(key)
        else currentRevisions.set(key, head.revision_id)
      }
      for (const head of pendingLinkHeads) {
        const key = `link:${head.link_id}`
        if (head.visibility === "retired") currentRevisions.delete(key)
        else currentRevisions.set(key, head.revision_id)
      }
    }
    const revisionIds = [...currentRevisions.values()]
    if (revisionIds.length === 0) return []
    let query = this.database.selectFrom("retrieval_projections").selectAll()
      .where("project_id", "=", scope.projectId)
      .where("owner_revision_id", "in", revisionIds)
    query = scope.pendingScopeId === undefined
      ? query.where("visibility", "=", "committed")
      : query.where((expressions) => expressions.or([
          expressions("visibility", "=", "committed"),
          expressions.and([
            expressions("visibility", "=", "pending"),
            expressions("scope_id", "=", scope.pendingScopeId as string),
          ]),
        ]))
    const rows = await query.execute()
    return rows
      .map(mapProjection)
      .filter((projection) => currentRevisions.get(`${projection.ownerKind}:${projection.ownerId}`) === projection.ownerRevisionId)
      .map((projection) => ({ ...projection, stateRole: "current" as const }))
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function buildSemanticFtsQuery(expression: string): string {
  const normalized = expression.normalize("NFKC").trim()
  const phrases = new Set<string>([normalized])
  for (const term of normalized.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)) {
    const characters = Array.from(term)
    if (characters.length <= 8) {
      phrases.add(term)
      continue
    }
    for (let index = 0; index <= characters.length - 3 && phrases.size < 18; index += 1) {
      phrases.add(characters.slice(index, index + 3).join(""))
    }
  }
  return [...phrases]
    .filter((phrase) => codePointLength(phrase) >= 2)
    .map((phrase) => `"${phrase.replaceAll('"', '""')}"`)
    .join(" OR ")
}

function extractShortSearchTerms(expression: string): readonly string[] {
  return [...new Set(expression
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => codePointLength(term) === 2))]
}

function sourceProjectionFilter(
  projectId: ProjectId,
  sourceIds?: readonly string[],
): ReturnType<typeof sql> {
  const sourceIdFilter = sourceIds === undefined
    ? sql``
    : sql`AND source_units.source_id IN (${sql.join(sourceIds.map((sourceId) => sql`${sourceId}`), sql`, `)})`
  return sql`
    AND projection_id IN (
      SELECT retrieval_projections.id
      FROM retrieval_projections
      INNER JOIN source_units ON source_units.id = retrieval_projections.owner_id
      WHERE retrieval_projections.project_id = ${projectId}
        AND retrieval_projections.owner_kind = 'source'
        ${sourceIdFilter}
    )
  `
}

async function assertPendingScope(
  database: Kysely<ProjectDatabase>,
  projectId: ProjectId,
  scopeId: ScopeId,
): Promise<void> {
  const scope = await database.selectFrom("artifact_scopes")
    .select(["project_id", "visibility"])
    .where("id", "=", scopeId)
    .executeTakeFirst()
  if (scope?.project_id !== projectId || scope.visibility !== "pending") {
    throw new Error(`Pending scope is not writable: ${scopeId}`)
  }
}

async function pendingScopeIsVisible(
  database: Kysely<ProjectDatabase>,
  scopeId: ScopeId,
): Promise<boolean> {
  const scope = await database.selectFrom("artifact_scopes")
    .select("visibility")
    .where("id", "=", scopeId)
    .executeTakeFirst()
  return scope?.visibility === "pending"
}

function mapProjection(row: RetrievalProjectionRow): RetrievalProjection {
  return {
    projectionId: row.id,
    projectId: row.project_id,
    scopeId: row.scope_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ownerRevisionId: row.owner_revision_id,
    visibility: row.visibility,
    exactKeys: decodeJson(row.exact_keys_json) as string[],
    semanticText: row.semantic_text,
    sourceRefs: decodeJson(row.source_refs_json) as unknown[],
    digest: row.digest,
  }
}

function uniqueProjections(
  projections: readonly RetrievalProjection[],
  limit: number,
): readonly RetrievalProjection[] {
  return [...new Map(projections.map((projection) => [projection.projectionId, projection])).values()].slice(0, limit)
}

function closeGraphProjectionCandidates(
  candidates: readonly RetrievalProjection[],
  currentProjections: readonly RetrievalProjection[],
  limit: number,
): readonly RetrievalProjection[] {
  const currentByOwner = new Map(currentProjections.map((projection) => [
    `${projection.ownerKind}:${projection.ownerId}`,
    { ...projection, stateRole: "current" as const },
  ]))
  const selected: RetrievalProjection[] = []
  const selectedIds = new Set<string>()
  const append = (projection: RetrievalProjection): boolean => {
    if (selectedIds.has(projection.projectionId)) return true
    if (selected.length >= limit) return false
    selectedIds.add(projection.projectionId)
    selected.push(projection)
    return true
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) break
    if (candidate.ownerKind !== "node" && candidate.ownerKind !== "link") {
      append(candidate)
      continue
    }
    const current = currentByOwner.get(`${candidate.ownerKind}:${candidate.ownerId}`)
    if (current === undefined || current.ownerRevisionId === candidate.ownerRevisionId) {
      append({
        ...candidate,
        stateRole: current === undefined ? "historical" : "current",
      })
      continue
    }
    const currentAlreadySelected = selectedIds.has(current.projectionId)
    const requiredCapacity = currentAlreadySelected ? 1 : 2
    if (selected.length + requiredCapacity > limit) continue
    append(current)
    append({ ...candidate, stateRole: "historical" })
  }
  return selected
}
