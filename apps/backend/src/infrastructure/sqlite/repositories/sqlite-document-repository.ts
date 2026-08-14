import type { Kysely } from "kysely"

import type { ProjectId, ScopeId } from "@worldseed/contracts"

import type {
  DocumentRepository,
  DocumentVersion,
  SourceUnit,
} from "../../../application/index.js"
import type { DocumentVersionRow, ProjectDatabase, SourceUnitRow } from "../database-types.js"

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
