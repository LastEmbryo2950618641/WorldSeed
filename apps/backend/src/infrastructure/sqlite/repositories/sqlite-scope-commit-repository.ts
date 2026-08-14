import type { Kysely, Transaction } from "kysely"
import { sql } from "kysely"

import type { ScopeId } from "@worldseed/contracts"

import type {
  ScopeCommitRepository,
  ScopeCommitResult,
} from "../../../application/index.js"
import type { ProjectDatabase } from "../database-types.js"

type ProjectTransaction = Transaction<ProjectDatabase>

export class SqliteScopeCommitRepository implements ScopeCommitRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async resetPending(scopeId: ScopeId): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const scope = await transaction.selectFrom("artifact_scopes")
        .select("visibility")
        .where("id", "=", scopeId)
        .executeTakeFirstOrThrow()
      if (scope.visibility !== "pending") return

      await sql`DELETE FROM retrieval_fts WHERE scope_id = ${scopeId}`.execute(transaction)
      await transaction.deleteFrom("retrieval_exact_keys")
        .where("projection_id", "in", transaction.selectFrom("retrieval_projections").select("id").where("scope_id", "=", scopeId))
        .execute()
      await transaction.deleteFrom("retrieval_projections").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("graph_revision_spacetime").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("scene_spacetime_bindings").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("settlement_records").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("frontier_refs").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("ai_decision_records").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("document_versions").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("node_heads").where("scope_key", "=", scopeId).execute()
      await transaction.deleteFrom("link_heads").where("scope_key", "=", scopeId).execute()
      await transaction.deleteFrom("nodes").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("links").where("scope_id", "=", scopeId).execute()
      await transaction.deleteFrom("graph_revisions").where("scope_id", "=", scopeId).execute()
    })
  }

  public async commit(scopeId: ScopeId): Promise<ScopeCommitResult> {
    return this.database.transaction().execute(async (transaction) => {
      const scope = await transaction.selectFrom("artifact_scopes").selectAll().where("id", "=", scopeId).executeTakeFirstOrThrow()
      if (scope.visibility !== "pending") {
        if (scope.visibility === "committed" && scope.committed_sequence !== null) {
          return {
            projectId: scope.project_id,
            scopeId,
            committedSequence: scope.committed_sequence,
          }
        }
        throw new Error(`Only pending scopes can be committed: ${scopeId}`)
      }
      const project = await transaction.selectFrom("projects")
        .select(["committed_sequence", "active_generation"])
        .where("id", "=", scope.project_id)
        .executeTakeFirstOrThrow()
      if (project.committed_sequence !== scope.base_committed_sequence) {
        throw new Error(`Scope was created from stale committed sequence: ${scopeId}`)
      }
      if (project.active_generation !== scope.base_generation) {
        throw new Error(`Scope was created from stale active generation: ${scopeId}`)
      }

      await promoteNodeHeads(transaction, scope.project_id, scopeId)
      await promoteLinkHeads(transaction, scope.project_id, scopeId)
      await transaction.updateTable("nodes").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await transaction.updateTable("links").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await transaction.updateTable("document_versions").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await transaction.updateTable("scene_spacetime_bindings").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await transaction.updateTable("graph_revision_spacetime").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await transaction.updateTable("retrieval_projections").set({ visibility: "committed" })
        .where("scope_id", "=", scopeId).where("visibility", "=", "pending").execute()
      await sql`UPDATE retrieval_fts SET visibility = 'committed' WHERE scope_id = ${scopeId} AND visibility = 'pending'`
        .execute(transaction)
      const committedSequence = project.committed_sequence + 1
      await transaction.updateTable("artifact_scopes").set({
        visibility: "committed",
        committed_sequence: committedSequence,
      }).where("id", "=", scopeId).execute()
      await transaction.updateTable("projects")
        .set({ committed_sequence: committedSequence })
        .where("id", "=", scope.project_id)
        .executeTakeFirstOrThrow()
      await transaction.insertInto("active_scope_refs").values({
        project_id: scope.project_id,
        scope_id: scopeId,
      }).onConflict((conflict) => conflict.columns(["project_id", "scope_id"]).doNothing()).execute()
      const documentVersions = await transaction.selectFrom("document_versions")
        .select(["id", "chapter_id", "scope_id"])
        .where("project_id", "=", scope.project_id)
        .where("scope_id", "=", scopeId)
        .where("visibility", "=", "committed")
        .execute()
      for (const document of documentVersions) {
        await transaction.insertInto("active_document_heads").values({
          project_id: scope.project_id,
          chapter_id: document.chapter_id,
          document_version_id: document.id,
          scope_id: document.scope_id,
        }).onConflict((conflict) => conflict.columns(["project_id", "chapter_id"]).doUpdateSet({
          document_version_id: document.id,
          scope_id: document.scope_id,
        })).execute()
      }

      return {
        projectId: scope.project_id,
        scopeId,
        committedSequence,
      }
    })
  }

  public async retire(scopeId: ScopeId, retiredAtMs: number): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const scope = await transaction.selectFrom("artifact_scopes").select("visibility").where("id", "=", scopeId).executeTakeFirstOrThrow()
      if (scope.visibility !== "pending") {
        throw new Error(`Only pending scopes can be retired: ${scopeId}`)
      }
      await transaction.updateTable("nodes").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await transaction.updateTable("links").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await transaction.updateTable("node_heads").set({ visibility: "retired" }).where("scope_key", "=", scopeId).execute()
      await transaction.updateTable("link_heads").set({ visibility: "retired" }).where("scope_key", "=", scopeId).execute()
      await transaction.updateTable("document_versions").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await transaction.updateTable("scene_spacetime_bindings").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await transaction.updateTable("graph_revision_spacetime").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await transaction.updateTable("retrieval_projections").set({ visibility: "retired" }).where("scope_id", "=", scopeId).execute()
      await sql`UPDATE retrieval_fts SET visibility = 'retired' WHERE scope_id = ${scopeId}`.execute(transaction)
      await transaction.updateTable("artifact_scopes")
        .set({ visibility: "retired", retired_at: retiredAtMs })
        .where("id", "=", scopeId)
        .executeTakeFirstOrThrow()
    })
  }
}

async function promoteNodeHeads(transaction: ProjectTransaction, projectId: string, scopeId: ScopeId): Promise<void> {
  const heads = await transaction.selectFrom("node_heads").selectAll()
    .where("project_id", "=", projectId).where("scope_key", "=", scopeId).execute()
  for (const head of heads) {
    const visibility = head.visibility === "retired" ? "retired" as const : "committed" as const
    await transaction.insertInto("node_heads").values({
      ...head,
      scope_key: "committed",
      visibility,
    }).onConflict((conflict) => conflict.columns(["project_id", "scope_key", "node_id"]).doUpdateSet({
      source_scope_id: head.source_scope_id,
      revision_id: head.revision_id,
      visibility,
      effective_at: head.effective_at,
      digest: head.digest,
    })).execute()
  }
}

async function promoteLinkHeads(transaction: ProjectTransaction, projectId: string, scopeId: ScopeId): Promise<void> {
  const heads = await transaction.selectFrom("link_heads").selectAll()
    .where("project_id", "=", projectId).where("scope_key", "=", scopeId).execute()
  for (const head of heads) {
    const visibility = head.visibility === "retired" ? "retired" as const : "committed" as const
    await transaction.insertInto("link_heads").values({
      ...head,
      scope_key: "committed",
      visibility,
    }).onConflict((conflict) => conflict.columns(["project_id", "scope_key", "link_id"]).doUpdateSet({
      source_scope_id: head.source_scope_id,
      revision_id: head.revision_id,
      visibility,
      effective_at: head.effective_at,
      digest: head.digest,
    })).execute()
  }
}
