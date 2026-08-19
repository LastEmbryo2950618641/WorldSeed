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
    const existing = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("project_id", "=", projection.projectId)
      .where("scope_id", "=", projection.scopeId)
      .where("owner_kind", "=", projection.ownerKind)
      .where("owner_id", "=", projection.ownerId)
      .where("owner_revision_id", "=", projection.ownerRevisionId)
      .where("visibility", "=", "pending")
      .executeTakeFirst()
    if (existing !== undefined) {
      if (!sameProjectionContent(existing, projection)) {
        throw new Error(
          `Pending retrieval projection conflicts with canonical owner revision: ${projection.ownerKind}:${projection.ownerId}@${projection.ownerRevisionId}`,
        )
      }
      return mapProjection(existing)
    }
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
      .innerJoin("active_document_heads", "active_document_heads.document_version_id", "document_versions.id")
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
      .where(visibleRetrievalProjection({ projectId: projection.projectId }))
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
      .innerJoin("active_document_heads", "active_document_heads.document_version_id", "document_versions.id")
      .leftJoin("retrieval_projections", (join) => join
        .onRef("retrieval_projections.owner_id", "=", "source_units.id")
        .on("retrieval_projections.owner_kind", "=", "source")
        .on("retrieval_projections.visibility", "=", "committed"))
      .leftJoin("active_scope_refs", (join) => join
        .onRef("active_scope_refs.scope_id", "=", "retrieval_projections.scope_id")
        .onRef("active_scope_refs.project_id", "=", "retrieval_projections.project_id"))
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
      .where("active_scope_refs.scope_id", "is", null)
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
    const currentProjection = current.find((candidate) => candidate.ownerRevisionId === ownerRevisionId)
    return {
      ...projection,
      stateRole: currentProjection === undefined ? "historical" : "current",
      ...(currentProjection?.committedSequence === undefined
        ? {}
        : { committedSequence: currentProjection.committedSequence }),
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

    query = query.where(visibleRetrievalProjection(scope))

    const rows = await query.limit(limit).execute()
    const currentProjections = await this.findCurrentGraphProjections(scope)
    const currentMatches = currentProjections
      .filter((projection) => projection.exactKeys.some((key) => keys.includes(key)))
    return this.attachSourcePositions(closeGraphProjectionCandidates([
      ...currentMatches,
      ...rows.map(mapProjection),
    ], currentProjections, limit))
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
    const shortTerms = extractSubstringSearchTerms(normalizedExpression)
    const shortTextMatchesByTerm = shortTerms.length === 0
      ? []
      : await Promise.all(shortTerms.map((term) => this.searchShortText(scope, term, limit)))
    const currentShortMatchesByTerm = shortTerms.map((term) => (
      currentProjections.filter((projection) => projection.semanticText.includes(term))
    ))
    const shortTextMatches = shortTextMatchesByTerm.flat()
    const currentShortMatches = currentShortMatchesByTerm.flat()
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
    const candidates = interleaveUnique([
      currentMatches,
      projectionIds.flatMap((projectionId) => {
        const projection = byId.get(projectionId)
        return projection === undefined ? [] : [projection]
      }),
      ...currentShortMatchesByTerm,
      ...shortTextMatchesByTerm.map((termMatches) => termMatches.flatMap((match) => {
        const projection = byId.get(match.projection_id)
        return projection === undefined ? [] : [projection]
      })),
    ], (projection) => projection.projectionId)
    return this.attachSourcePositions(closeGraphProjectionCandidates(candidates, currentProjections, limit))
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
    const substringMatches = await this.searchSourceSubstring(scope, normalizedExpression, limit, sourceIds)
    const matches = codePointLength(normalizedExpression) <= 2
      ? await this.searchShortSourceText(scope, normalizedExpression, limit, sourceIds)
      : await this.searchFts(scope, normalizedExpression, limit, sourceIds)
    const shortTerms = extractSubstringSearchTerms(normalizedExpression)
    const shortTextMatchesByTerm = shortTerms.length === 0
      ? []
      : await Promise.all(shortTerms.map((term) => this.searchShortSourceText(scope, term, limit, sourceIds)))
    const shortTextMatches = shortTextMatchesByTerm.flat()
    if (substringMatches.length === 0 && matches.length === 0 && shortTextMatches.length === 0) return []
    const rows = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("id", "in", [...new Set([
        ...substringMatches.map((match) => match.projection_id),
        ...matches.map((match) => match.projection_id),
        ...shortTextMatches.map((match) => match.projection_id),
      ])])
      .execute()
    const byId = new Map(rows.map((row) => [row.id, mapProjection(row)]))
    const rankedMatches = interleaveUnique([
      substringMatches,
      matches,
      ...shortTextMatchesByTerm,
    ], (match) => match.projection_id)
    return this.attachSourcePositions(uniqueProjections(rankedMatches.flatMap((match) => {
      const projection = byId.get(match.projection_id)
      return projection === undefined ? [] : [projection]
    }), limit))
  }

  private async searchSourceSubstring(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    sourceIds?: readonly string[],
  ): Promise<readonly { projection_id: string }[]> {
    let query = this.database.selectFrom("retrieval_projections")
      .innerJoin("source_units", "source_units.id", "retrieval_projections.owner_id")
      .innerJoin("artifact_scopes", "artifact_scopes.id", "retrieval_projections.scope_id")
      .select("retrieval_projections.id as projection_id")
      .where("retrieval_projections.project_id", "=", scope.projectId)
      .where("retrieval_projections.owner_kind", "=", "source")
      .where(sql<boolean>`instr(retrieval_projections.semantic_text, ${expression}) > 0`)
    if (sourceIds !== undefined) query = query.where("source_units.source_id", "in", [...sourceIds])
    return query.where(visibleRetrievalProjection(scope))
      .orderBy(sql`CASE WHEN retrieval_projections.visibility = 'pending' THEN 1 ELSE 0 END`, "desc")
      .orderBy("artifact_scopes.committed_sequence", "desc")
      .orderBy("retrieval_projections.id", "desc")
      .limit(limit)
      .execute()
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
      query = query.where(visibleRetrievalProjection(scope))
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
    return this.attachSourcePositions(selected
      .sort((left, right) => left.anchorIndex - right.anchorIndex || left.sequence - right.sequence)
      .map((candidate) => candidate.projection))
  }

  public async readSourceBoundary(
    scope: RetrievalSearchScope,
    sourceRefs: readonly string[],
    boundary: "start" | "end",
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedSourceRefs = [...new Set(sourceRefs.filter((sourceRef) => sourceRef.length > 0))]
    if (normalizedSourceRefs.length === 0 || limit <= 0) return []
    let query = this.database.selectFrom("retrieval_projections")
      .innerJoin("source_units", "source_units.id", "retrieval_projections.owner_id")
      .selectAll("retrieval_projections")
      .select(["source_units.source_id as source_id", "source_units.sequence_no as source_sequence"])
      .where("retrieval_projections.project_id", "=", scope.projectId)
      .where("retrieval_projections.owner_kind", "=", "source")
      .where("source_units.project_id", "=", scope.projectId)
      .where("source_units.source_id", "in", normalizedSourceRefs)
    query = query.where(visibleRetrievalProjection(scope))
    const rows = await query.execute()
    const ordered = rows.sort((left, right) => {
      const sourceOrder = normalizedSourceRefs.indexOf(left.source_id) - normalizedSourceRefs.indexOf(right.source_id)
      if (sourceOrder !== 0) return sourceOrder
      return boundary === "start"
        ? left.source_sequence - right.source_sequence
        : right.source_sequence - left.source_sequence
    }).slice(0, limit)
    const projections = await this.attachSourcePositions(ordered.map(mapProjection))
    return [...projections].sort((left, right) => {
      const leftPosition = left.sourcePosition
      const rightPosition = right.sourcePosition
      if (leftPosition === undefined || rightPosition === undefined) return 0
      const sourceOrder = normalizedSourceRefs.indexOf(leftPosition.sourceRef)
        - normalizedSourceRefs.indexOf(rightPosition.sourceRef)
      return sourceOrder !== 0 ? sourceOrder : leftPosition.sequence - rightPosition.sequence
    })
  }

  private async attachSourcePositions(
    projections: readonly RetrievalProjection[],
  ): Promise<readonly RetrievalProjection[]> {
    const sourceUnitIds = [...new Set(projections
      .filter((projection) => projection.ownerKind === "source")
      .map((projection) => projection.ownerId))]
    if (sourceUnitIds.length === 0) return projections
    const sourceRows = await this.database.selectFrom("source_units")
      .select(["id", "source_id", "sequence_no"])
      .where("id", "in", sourceUnitIds)
      .execute()
    const sourceRefs = [...new Set(sourceRows.map((row) => row.source_id))]
    const boundaryRows = await this.database.selectFrom("source_units")
      .select(["source_id"])
      .select((expression) => [
        expression.fn.min("sequence_no").as("first_sequence"),
        expression.fn.max("sequence_no").as("last_sequence"),
        expression.fn.count<number>("id").as("unit_count"),
      ])
      .where("project_id", "=", projections[0]!.projectId)
      .where("source_id", "in", sourceRefs)
      .groupBy("source_id")
      .execute()
    const sourceUnits = new Map(sourceRows.map((row) => [row.id, row]))
    const boundaries = new Map(boundaryRows.map((row) => [row.source_id, row]))
    return projections.map((projection) => {
      if (projection.ownerKind !== "source") return projection
      const sourceUnit = sourceUnits.get(projection.ownerId)
      const sourceBoundary = sourceUnit === undefined ? undefined : boundaries.get(sourceUnit.source_id)
      if (sourceUnit === undefined || sourceBoundary === undefined) return projection
      const firstSequence = Number(sourceBoundary.first_sequence)
      const lastSequence = Number(sourceBoundary.last_sequence)
      return {
        ...projection,
        sourcePosition: {
          sourceRef: sourceUnit.source_id,
          sequence: sourceUnit.sequence_no,
          firstSequence,
          lastSequence,
          unitCount: Number(sourceBoundary.unit_count),
          isStart: sourceUnit.sequence_no === firstSequence,
          isEnd: sourceUnit.sequence_no === lastSequence,
        },
      }
    })
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
            AND scope_id IN (SELECT scope_id FROM active_scope_refs WHERE project_id = ${scope.projectId})
            ${sourceFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
      : await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND ((visibility = 'committed' AND scope_id IN (
              SELECT scope_id FROM active_scope_refs WHERE project_id = ${scope.projectId}
            )) OR (visibility = 'pending' AND scope_id = ${scope.pendingScopeId}))
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
      .innerJoin("artifact_scopes", "artifact_scopes.id", "retrieval_projections.scope_id")
      .select("retrieval_projections.id as projection_id")
      .where("retrieval_projections.project_id", "=", scope.projectId)
      .where("retrieval_projections.owner_kind", "=", "source")
      .where(sql<boolean>`instr(retrieval_projections.semantic_text, ${expression}) > 0`)
    if (sourceIds !== undefined) {
      query = query.where("source_units.source_id", "in", [...sourceIds])
    }
    query = query.where(visibleRetrievalProjection(scope))
    return query
      .orderBy(sql`CASE WHEN retrieval_projections.visibility = 'pending' THEN 1 ELSE 0 END`, "desc")
      .orderBy("artifact_scopes.committed_sequence", "desc")
      .orderBy("retrieval_projections.id", "desc")
      .limit(limit)
      .execute()
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
            AND scope_id IN (SELECT scope_id FROM active_scope_refs WHERE project_id = ${scope.projectId})
            ${projectionFilter}
          ORDER BY bm25(retrieval_fts)
          LIMIT ${limit}
        `.execute(this.database)
      : await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${semanticQuery}
            AND project_id = ${scope.projectId}
            AND ((visibility = 'committed' AND scope_id IN (
              SELECT scope_id FROM active_scope_refs WHERE project_id = ${scope.projectId}
            )) OR (visibility = 'pending' AND scope_id = ${scope.pendingScopeId}))
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
      .innerJoin("artifact_scopes", "artifact_scopes.id", "retrieval_projections.scope_id")
      .select("retrieval_projections.id as projection_id")
      .where("retrieval_projections.project_id", "=", scope.projectId)
      .where(sql<boolean>`instr(retrieval_projections.semantic_text, ${expression}) > 0`)
    const visibleQuery = query.where(visibleRetrievalProjection(scope))
    return visibleQuery
      .orderBy(sql`CASE WHEN retrieval_projections.visibility = 'pending' THEN 1 ELSE 0 END`, "desc")
      .orderBy("artifact_scopes.committed_sequence", "desc")
      .orderBy("retrieval_projections.id", "desc")
      .limit(limit)
      .execute()
  }

  private async findCurrentGraphProjections(
    scope: RetrievalSearchScope,
    ownerIds?: readonly string[],
  ): Promise<readonly RetrievalProjection[]> {
    const normalizedOwnerIds = ownerIds === undefined ? undefined : [...new Set(ownerIds)]
    if (normalizedOwnerIds?.length === 0) return []
    let committedNodeQuery = this.database.selectFrom("node_heads")
      .innerJoin("artifact_scopes", "artifact_scopes.id", "node_heads.source_scope_id")
      .select(["node_heads.node_id", "node_heads.revision_id", "node_heads.visibility", "artifact_scopes.committed_sequence"])
      .where("node_heads.project_id", "=", scope.projectId)
      .where("node_heads.scope_key", "=", "committed")
    let committedLinkQuery = this.database.selectFrom("link_heads")
      .innerJoin("artifact_scopes", "artifact_scopes.id", "link_heads.source_scope_id")
      .select(["link_heads.link_id", "link_heads.revision_id", "link_heads.visibility", "artifact_scopes.committed_sequence"])
      .where("link_heads.project_id", "=", scope.projectId)
      .where("link_heads.scope_key", "=", "committed")
    if (normalizedOwnerIds !== undefined) {
      committedNodeQuery = committedNodeQuery.where("node_heads.node_id", "in", normalizedOwnerIds)
      committedLinkQuery = committedLinkQuery.where("link_heads.link_id", "in", normalizedOwnerIds)
    }
    const [committedNodeHeads, committedLinkHeads] = await Promise.all([
      committedNodeQuery.execute(),
      committedLinkQuery.execute(),
    ])
    const currentRevisions = new Map<string, Readonly<{ revisionId: string; committedSequence?: number }>>()
    for (const head of committedNodeHeads) {
      if (head.visibility !== "retired") currentRevisions.set(`node:${head.node_id}`, {
        revisionId: head.revision_id,
        ...(head.committed_sequence === null ? {} : { committedSequence: head.committed_sequence }),
      })
    }
    for (const head of committedLinkHeads) {
      if (head.visibility !== "retired") currentRevisions.set(`link:${head.link_id}`, {
        revisionId: head.revision_id,
        ...(head.committed_sequence === null ? {} : { committedSequence: head.committed_sequence }),
      })
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
        else currentRevisions.set(key, { revisionId: head.revision_id })
      }
      for (const head of pendingLinkHeads) {
        const key = `link:${head.link_id}`
        if (head.visibility === "retired") currentRevisions.delete(key)
        else currentRevisions.set(key, { revisionId: head.revision_id })
      }
    }
    const revisionIds = [...currentRevisions.values()].map((current) => current.revisionId)
    if (revisionIds.length === 0) return []
    let query = this.database.selectFrom("retrieval_projections").selectAll()
      .where("project_id", "=", scope.projectId)
      .where("owner_revision_id", "in", revisionIds)
    query = query.where(visibleRetrievalProjection(scope))
    const rows = await query.execute()
    return rows
      .map(mapProjection)
      .filter((projection) => currentRevisions.get(`${projection.ownerKind}:${projection.ownerId}`)?.revisionId === projection.ownerRevisionId)
      .map((projection) => {
        const current = currentRevisions.get(`${projection.ownerKind}:${projection.ownerId}`)
        return {
          ...projection,
          stateRole: "current" as const,
          ...(current?.committedSequence === undefined ? {} : { committedSequence: current.committedSequence }),
        }
      })
      .sort((left, right) => (right.committedSequence ?? Number.MAX_SAFE_INTEGER)
        - (left.committedSequence ?? Number.MAX_SAFE_INTEGER))
  }
}

function sameProjectionContent(
  row: RetrievalProjectionRow,
  projection: Omit<RetrievalProjection, "visibility">,
): boolean {
  return row.exact_keys_json === encodeJson(projection.exactKeys)
    && row.semantic_text === projection.semanticText
    && row.source_refs_json === encodeJson(projection.sourceRefs)
    && row.digest === projection.digest
}

function visibleRetrievalProjection(scope: RetrievalSearchScope) {
  const committed = sql<boolean>`(
    retrieval_projections.visibility = 'committed'
    AND EXISTS (
      SELECT 1 FROM active_scope_refs
      WHERE active_scope_refs.project_id = ${scope.projectId}
        AND active_scope_refs.scope_id = retrieval_projections.scope_id
    )
  )`
  return scope.pendingScopeId === undefined
    ? committed
    : sql<boolean>`(${committed} OR (
        retrieval_projections.visibility = 'pending'
        AND retrieval_projections.scope_id = ${scope.pendingScopeId}
      ))`
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

function extractSubstringSearchTerms(expression: string): readonly string[] {
  return [...new Set(expression
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => {
      const length = codePointLength(term)
      return length >= 2 && length <= 24
    }))].slice(0, 12)
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

function interleaveUnique<T>(
  groups: readonly (readonly T[])[],
  key: (value: T) => string,
): readonly T[] {
  const result: T[] = []
  const seen = new Set<string>()
  const maximumLength = groups.reduce((maximum, group) => Math.max(maximum, group.length), 0)
  for (let index = 0; index < maximumLength; index += 1) {
    for (const group of groups) {
      const value = group[index]
      if (value === undefined || seen.has(key(value))) continue
      seen.add(key(value))
      result.push(value)
    }
  }
  return result
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
        ...(current?.committedSequence === undefined ? {} : { committedSequence: current.committedSequence }),
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
