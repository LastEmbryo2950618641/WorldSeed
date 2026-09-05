import type { Kysely, Transaction } from "kysely"
import { sql } from "kysely"

import type { ProjectId, ScopeId } from "@worldseed/contracts"

import type {
  DocumentRepository,
  DocumentVersion,
  SourceUnit,
} from "../../../application/index.js"
import type { DocumentVersionRow, ProjectDatabase, SourceUnitRow } from "../database-types.js"

type ProjectDb = Kysely<ProjectDatabase> | Transaction<ProjectDatabase>

export class SqliteDocumentRepository implements DocumentRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async stageVersion(version: Omit<DocumentVersion, "visibility">): Promise<DocumentVersion> {
    await assertPendingScope(this.database, version.projectId, version.scopeId)
    await this.database.insertInto("document_versions").values({
      id: version.id,
      project_id: version.projectId,
      scope_id: version.scopeId,
      source_id: version.sourceId,
      chapter_id: version.chapterId,
      visibility: "pending",
      content_ref: version.contentRef,
      heading: version.heading,
      publish_path: version.publishPath,
      digest: version.digest,
      predecessor_source_id: version.predecessorSourceId ?? null,
      created_at: version.createdAtMs,
    }).executeTakeFirstOrThrow()
    return { ...version, visibility: "pending" }
  }

  public async stageSourceUnits(units: readonly SourceUnit[]): Promise<void> {
    if (units.length === 0) {
      return
    }
    await this.database.insertInto("source_units").values(units.map((unit) => ({
      id: unit.id,
      project_id: unit.projectId,
      source_id: unit.sourceId,
      sequence_no: unit.sequence,
      content_ref: unit.contentRef,
      digest: unit.digest,
      created_at: unit.createdAtMs,
    }))).executeTakeFirstOrThrow()
  }

  public async replaceUncommittedSourceUnits(
    projectId: ProjectId,
    sourceId: string,
    units: readonly SourceUnit[],
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      if (await isCommittedSource(transaction, projectId, sourceId)) {
        throw new Error(`Cannot replace source units for committed source: ${sourceId}`)
      }
      await deleteSourceUnitsAndDependents(transaction, projectId, [sourceId])
      if (units.length === 0) return
      for (const unit of units) {
        if (unit.projectId !== projectId || unit.sourceId !== sourceId) {
          throw new Error("replaceUncommittedSourceUnits received units for a different project/source")
        }
      }
      await transaction.insertInto("source_units").values(units.map((unit) => ({
        id: unit.id,
        project_id: unit.projectId,
        source_id: unit.sourceId,
        sequence_no: unit.sequence,
        content_ref: unit.contentRef,
        digest: unit.digest,
        created_at: unit.createdAtMs,
      }))).executeTakeFirstOrThrow()
    })
  }

  public async clearUncommittedSourceUnits(projectId: ProjectId, sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return
    await this.database.transaction().execute(async (transaction) => {
      await clearUncommittedSourceUnitsInTransaction(transaction, projectId, sourceIds)
    })
  }

  public async listSourceUnits(projectId: ProjectId, sourceId: string): Promise<readonly SourceUnit[]> {
    const rows = await this.database.selectFrom("source_units").selectAll()
      .where("project_id", "=", projectId).where("source_id", "=", sourceId)
      .orderBy("sequence_no").execute()
    return rows.map(mapSourceUnit)
  }

  public async findVersion(
    projectId: ProjectId,
    sourceId: string,
    pendingScopeId?: ScopeId,
  ): Promise<DocumentVersion | undefined> {
    if (pendingScopeId !== undefined) {
      const pending = await this.database.selectFrom("document_versions").selectAll()
        .where("project_id", "=", projectId)
        .where("source_id", "=", sourceId)
        .where("scope_id", "=", pendingScopeId)
        .where("visibility", "=", "pending")
        .executeTakeFirst()
      if (pending !== undefined) {
        return mapDocumentVersion(pending)
      }
    }

    const committed = await this.database.selectFrom("active_document_heads")
      .innerJoin("document_versions", "document_versions.id", "active_document_heads.document_version_id")
      .selectAll("document_versions")
      .where("active_document_heads.project_id", "=", projectId)
      .where("document_versions.source_id", "=", sourceId)
      .executeTakeFirst()
    return committed === undefined ? undefined : mapDocumentVersion(committed)
  }

  public async listCommittedChapters(projectId: ProjectId): Promise<readonly DocumentVersion[]> {
    const rows = await this.database.selectFrom("active_document_heads")
      .innerJoin("document_versions", "document_versions.id", "active_document_heads.document_version_id")
      .selectAll("document_versions")
      .where("active_document_heads.project_id", "=", projectId)
      .orderBy("document_versions.created_at")
      .orderBy("document_versions.id")
      .execute()
    return rows.map(mapDocumentVersion)
  }

  public async findStoredVersion(projectId: ProjectId, sourceId: string): Promise<DocumentVersion | undefined> {
    const row = await this.database.selectFrom("document_versions").selectAll()
      .where("project_id", "=", projectId)
      .where("source_id", "=", sourceId)
      .orderBy("created_at", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : mapDocumentVersion(row)
  }

  public async findCurrentChapter(projectId: ProjectId, chapterId: string): Promise<DocumentVersion | undefined> {
    const row = await this.database.selectFrom("active_document_heads")
      .innerJoin("document_versions", "document_versions.id", "active_document_heads.document_version_id")
      .selectAll("document_versions")
      .where("active_document_heads.project_id", "=", projectId)
      .where("active_document_heads.chapter_id", "=", chapterId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapDocumentVersion(row)
  }
}

export async function clearUncommittedSourceUnitsInTransaction(
  database: ProjectDb,
  projectId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return
  const replaceable: string[] = []
  for (const sourceId of [...new Set(sourceIds)]) {
    if (!(await isCommittedSource(database, projectId, sourceId))) {
      replaceable.push(sourceId)
    }
  }
  if (replaceable.length === 0) return
  await deleteSourceUnitsAndDependents(database, projectId, replaceable)
}

async function isCommittedSource(
  database: ProjectDb,
  projectId: string,
  sourceId: string,
): Promise<boolean> {
  const committed = await database.selectFrom("document_versions")
    .select("id")
    .where("project_id", "=", projectId)
    .where("source_id", "=", sourceId)
    .where("visibility", "=", "committed")
    .executeTakeFirst()
  if (committed !== undefined) return true

  const activeHead = await database.selectFrom("active_document_heads")
    .innerJoin("document_versions", "document_versions.id", "active_document_heads.document_version_id")
    .select("document_versions.id")
    .where("active_document_heads.project_id", "=", projectId)
    .where("document_versions.source_id", "=", sourceId)
    .executeTakeFirst()
  return activeHead !== undefined
}

async function deleteSourceUnitsAndDependents(
  database: ProjectDb,
  projectId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return
  const units = await database.selectFrom("source_units")
    .select("id")
    .where("project_id", "=", projectId)
    .where("source_id", "in", [...sourceIds])
    .execute()
  const unitIds = units.map((unit) => unit.id)
  if (unitIds.length === 0) return

  await database.deleteFrom("settlement_records")
    .where("source_unit_id", "in", unitIds)
    .execute()

  const projections = await database.selectFrom("retrieval_projections")
    .select("id")
    .where("project_id", "=", projectId)
    .where("owner_kind", "=", "source")
    .where("owner_id", "in", unitIds)
    .execute()
  const projectionIds = projections.map((projection) => projection.id)
  if (projectionIds.length > 0) {
    await database.deleteFrom("retrieval_exact_keys")
      .where("projection_id", "in", projectionIds)
      .execute()
    for (const projectionId of projectionIds) {
      await sql`DELETE FROM retrieval_fts WHERE projection_id = ${projectionId}`.execute(database)
    }
    await database.deleteFrom("retrieval_projections")
      .where("id", "in", projectionIds)
      .execute()
  }

  await database.deleteFrom("source_units")
    .where("project_id", "=", projectId)
    .where("source_id", "in", [...sourceIds])
    .execute()
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

function mapDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    scopeId: row.scope_id,
    sourceId: row.source_id,
    chapterId: row.chapter_id,
    visibility: row.visibility,
    contentRef: row.content_ref,
    heading: row.heading,
    publishPath: row.publish_path,
    digest: row.digest,
    ...(row.predecessor_source_id === null ? {} : { predecessorSourceId: row.predecessor_source_id }),
    createdAtMs: row.created_at,
  }
}

function mapSourceUnit(row: SourceUnitRow): SourceUnit {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sequence: row.sequence_no,
    contentRef: row.content_ref,
    digest: row.digest,
    createdAtMs: row.created_at,
  }
}
