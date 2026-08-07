import { evidenceSchema, type Evidence } from "@worldseed/contracts"
import type { Kysely } from "kysely"

import type {
  EvidenceStore,
  EvidenceWriteInput,
  InternalProjectStore,
  InternalStorePort,
} from "../../../application/index.js"
import { digest } from "../../../core/index.js"
import type { EvidenceObjectRow, ProjectDatabase } from "../database-types.js"

export class SqliteEvidenceStore implements EvidenceStore {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly internalStore: InternalStorePort,
    private readonly projectStore: InternalProjectStore,
  ) {}

  public async writeImmutable(input: EvidenceWriteInput): Promise<Evidence> {
    if (digest(input.content) !== input.digest) {
      throw new Error("Evidence digest does not match its immutable content")
    }
    const existing = await this.read(input.evidenceId)
    if (existing !== undefined) {
      const expected = evidenceSchema.parse({
        ...input,
        contentRef: existing.contentRef,
        content: undefined,
      })
      if (JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw new Error(`Evidence is immutable: ${input.evidenceId}`)
      }
      return existing
    }

    const contentRef = await this.internalStore.writeImmutableDocument(
      this.projectStore,
      input.evidenceId,
      input.content,
    )
    const evidence = evidenceSchema.parse({ ...input, contentRef, content: undefined })
    await this.database.insertInto("evidence_objects").values({
      id: evidence.evidenceId,
      project_id: evidence.projectId,
      context_id: evidence.contextId ?? null,
      source_kind: evidence.sourceKind,
      owner_id: evidence.ownerId,
      version: evidence.version,
      digest: evidence.digest,
      locator: evidence.locator,
      content_ref: evidence.contentRef,
      read_reason: evidence.readReason,
      created_at: evidence.createdAtMs,
    }).executeTakeFirstOrThrow()
    return evidence
  }

  public async read(evidenceId: string): Promise<Evidence | undefined> {
    const row = await this.database.selectFrom("evidence_objects")
      .selectAll()
      .where("id", "=", evidenceId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapEvidence(row)
  }

  public async listByContext(contextId: string): Promise<readonly Evidence[]> {
    const rows = await this.database.selectFrom("evidence_objects")
      .selectAll()
      .where("context_id", "=", contextId)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
    return rows.map(mapEvidence)
  }
}

function mapEvidence(row: EvidenceObjectRow): Evidence {
  return evidenceSchema.parse({
    evidenceId: row.id,
    projectId: row.project_id,
    ...(row.context_id === null ? {} : { contextId: row.context_id }),
    sourceKind: row.source_kind,
    ownerId: row.owner_id,
    version: row.version,
    digest: row.digest,
    locator: row.locator,
    contentRef: row.content_ref,
    readReason: row.read_reason,
    createdAtMs: row.created_at,
  })
}
