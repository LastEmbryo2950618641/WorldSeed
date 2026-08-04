import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { ProjectId, ScopeId } from "@worldseed/contracts"

import type {
  RetrievalProjection,
  RetrievalRepository,
  RetrievalSearchScope,
} from "../../../application/index.js"
import type { ProjectDatabase, RetrievalProjectionRow } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteRetrievalRepository implements RetrievalRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async stageProjection(
    projection: Omit<RetrievalProjection, "visibility">,
  ): Promise<RetrievalProjection> {
    await assertPendingScope(this.database, projection.projectId, projection.scopeId)
    const staged = { ...projection, visibility: "pending" as const }
    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("retrieval_projections").values({
        id: projection.projectionId,
        project_id: projection.projectId,
        scope_id: projection.scopeId,
        owner_kind: projection.ownerKind,
        owner_id: projection.ownerId,
        owner_revision_id: projection.ownerRevisionId,
        visibility: "pending",
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
          ${"pending"}, ${projection.semanticText}
        )
      `.execute(transaction)
    })
    return staged
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
    return uniqueProjections(rows.map(mapProjection), limit)
  }

  public async searchText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
  ): Promise<readonly RetrievalProjection[]> {
    if (expression.trim().length === 0 || limit <= 0) {
      return []
    }
    const matches = scope.pendingScopeId === undefined
      ? await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${expression}
            AND project_id = ${scope.projectId}
            AND visibility = 'committed'
          LIMIT ${limit}
        `.execute(this.database)
      : await sql<{ projection_id: string }>`
          SELECT projection_id FROM retrieval_fts
          WHERE retrieval_fts MATCH ${expression}
            AND project_id = ${scope.projectId}
            AND (visibility = 'committed' OR (visibility = 'pending' AND scope_id = ${scope.pendingScopeId}))
          LIMIT ${limit}
        `.execute(this.database)
    const projectionIds = matches.rows.map((row) => row.projection_id)
    if (projectionIds.length === 0) {
      return []
    }
    const rows = await this.database.selectFrom("retrieval_projections").selectAll()
      .where("id", "in", projectionIds)
      .execute()
    const byId = new Map(rows.map((row) => [row.id, mapProjection(row)]))
    return projectionIds.flatMap((projectionId) => {
      const projection = byId.get(projectionId)
      return projection === undefined ? [] : [projection]
    })
  }
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
