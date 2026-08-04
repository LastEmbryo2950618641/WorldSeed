import type { Kysely, Transaction } from "kysely"

import type {
  GraphLink,
  GraphNode,
  ProjectId,
  ScopeId,
} from "@worldseed/contracts"

import {
  digest,
  type GraphReadScope,
  type GraphRepository,
  type GraphRevision,
  type GraphSlice,
  type NeighborhoodRead,
  type PersistedGraphRevision,
} from "../../../index.js"
import type {
  GraphRevisionRow,
  LinkHeadRow,
  LinkRow,
  NodeHeadRow,
  NodeRow,
  ProjectDatabase,
} from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

type ProjectTransaction = Transaction<ProjectDatabase>

export class SqliteGraphRepository implements GraphRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async stageRevisions(
    projectId: ProjectId,
    scopeId: ScopeId,
    revisions: readonly GraphRevision[],
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await assertPendingScope(transaction, projectId, scopeId)
      for (const revision of revisions) {
        if (revision.scopeId !== scopeId) {
          throw new Error(`Revision ${revision.revisionId} belongs to a different scope`)
        }
        await stageRevision(transaction, projectId, scopeId, revision)
      }
    })
  }

  public async getNode(scope: GraphReadScope, nodeId: string): Promise<GraphNode | undefined> {
    const head = await resolveNodeHead(this.database, scope, nodeId)
    if (head === undefined || head.visibility === "retired") {
      return undefined
    }
    const row = await this.database.selectFrom("nodes")
      .selectAll()
      .where("project_id", "=", scope.projectId)
      .where("id", "=", nodeId)
      .where("revision_id", "=", head.revision_id)
      .executeTakeFirst()
    return row === undefined ? undefined : mapNode(row)
  }

  public async getLink(scope: GraphReadScope, linkId: string): Promise<GraphLink | undefined> {
    const head = await resolveLinkHead(this.database, scope, linkId)
    if (head === undefined || head.visibility === "retired") {
      return undefined
    }
    const row = await this.database.selectFrom("links")
      .selectAll()
      .where("project_id", "=", scope.projectId)
      .where("id", "=", linkId)
      .where("revision_id", "=", head.revision_id)
      .executeTakeFirst()
    return row === undefined ? undefined : mapLink(row)
  }

  public async getNeighborhood(input: NeighborhoodRead): Promise<GraphSlice> {
    const visibleLinks = await listVisibleLinks(this.database, input.scope)
    const visitedNodeIds = new Set<string>()
    const collectedLinks = new Map<string, GraphLink>()
    let frontier = [...new Set(input.anchorIds)]
    let truncated = false

    for (const anchorId of frontier) {
      if (visitedNodeIds.size >= input.maxNodes) {
        truncated = true
        break
      }
      visitedNodeIds.add(anchorId)
    }

    for (let depth = 0; depth < input.maxDepth && frontier.length > 0; depth += 1) {
      const frontierSet = new Set(frontier)
      const nextFrontier: string[] = []
      for (const link of visibleLinks) {
        if (collectedLinks.has(link.id)) {
          continue
        }
        const matchesOut = input.direction !== "in" && frontierSet.has(link.fromNodeId)
        const matchesIn = input.direction !== "out" && frontierSet.has(link.toNodeId)
        if (!matchesOut && !matchesIn) {
          continue
        }
        if (collectedLinks.size >= input.maxLinks) {
          truncated = true
          break
        }

        collectedLinks.set(link.id, link)
        const candidateIds = matchesOut && matchesIn
          ? [link.fromNodeId, link.toNodeId]
          : matchesOut ? [link.toNodeId] : [link.fromNodeId]
        for (const candidateId of candidateIds) {
          if (visitedNodeIds.has(candidateId)) {
            continue
          }
          if (visitedNodeIds.size >= input.maxNodes) {
            truncated = true
            break
          }
          visitedNodeIds.add(candidateId)
          nextFrontier.push(candidateId)
        }
      }
      frontier = nextFrontier
    }

    const nodes = (await Promise.all(
      [...visitedNodeIds].map((nodeId) => this.getNode(input.scope, nodeId)),
    )).filter((node): node is GraphNode => node !== undefined)

    return {
      nodes,
      links: [...collectedLinks.values()],
      visitedNodeIds: [...visitedNodeIds],
      truncated,
    }
  }

  public async listRevisions(
    projectId: ProjectId,
    targetKind: "node" | "link",
    targetId: string,
  ): Promise<readonly PersistedGraphRevision[]> {
    const rows = await this.database.selectFrom("graph_revisions")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("target_kind", "=", targetKind)
      .where("target_id", "=", targetId)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
    return rows.map(mapRevision)
  }
}

async function assertPendingScope(database: ProjectTransaction, projectId: ProjectId, scopeId: ScopeId): Promise<void> {
  const scope = await database.selectFrom("artifact_scopes")
    .select(["project_id", "visibility"])
    .where("id", "=", scopeId)
    .executeTakeFirst()
  if (scope?.project_id !== projectId || scope.visibility !== "pending") {
    throw new Error(`Pending scope is not writable: ${scopeId}`)
  }
}

async function stageRevision(
  transaction: ProjectTransaction,
  projectId: ProjectId,
  scopeId: ScopeId,
  revision: GraphRevision,
): Promise<void> {
  await transaction.insertInto("graph_revisions").values({
    id: revision.revisionId,
    project_id: projectId,
    scope_id: scopeId,
    target_kind: revision.targetKind,
    target_id: revision.targetId,
    operation: revision.operation,
    before_json: revision.before === null ? null : encodeJson(revision.before),
    after_json: revision.after === null ? null : encodeJson(revision.after),
    reason: revision.reason,
    self_review: revision.selfReview,
    predecessor_revision_id: revision.predecessorRevisionId ?? null,
    archive_outlet_ids_json: encodeJson(revision.archiveOutletIds),
    evidence_ids_json: encodeJson(revision.evidenceIds),
    created_at: revision.createdAtMs,
  }).executeTakeFirstOrThrow()

  const visibility = revision.operation === "retire" ? "retired" as const : "pending" as const
  const headDigest = digest({
    targetKind: revision.targetKind,
    targetId: revision.targetId,
    revisionId: revision.revisionId,
    after: revision.after,
  })

  if (revision.targetKind === "node") {
    if (revision.after !== null) {
      const node = revision.after as GraphNode
      await transaction.insertInto("nodes").values({
        id: node.id,
        project_id: projectId,
        scope_id: scopeId,
        visibility: "pending",
        content_json: encodeJson(node.content),
        metadata_json: node.metadata === undefined ? null : encodeJson(node.metadata),
        source_refs_json: node.sourceRefs === undefined ? null : encodeJson(node.sourceRefs),
        revision_id: revision.revisionId,
        created_at: revision.createdAtMs,
      }).executeTakeFirstOrThrow()
    }
    await transaction.insertInto("node_heads").values({
      project_id: projectId,
      scope_key: scopeId,
      source_scope_id: scopeId,
      node_id: revision.targetId,
      revision_id: revision.revisionId,
      visibility,
      effective_at: revision.createdAtMs,
      digest: headDigest,
    }).onConflict((conflict) => conflict.columns(["project_id", "scope_key", "node_id"]).doUpdateSet({
      revision_id: revision.revisionId,
      visibility,
      effective_at: revision.createdAtMs,
      digest: headDigest,
    })).execute()
    return
  }

  if (revision.after !== null) {
    const link = revision.after as GraphLink
    await transaction.insertInto("links").values({
      id: link.id,
      project_id: projectId,
      scope_id: scopeId,
      visibility: "pending",
      from_node_id: link.fromNodeId,
      to_node_id: link.toNodeId,
      content_json: link.content === undefined ? null : encodeJson(link.content),
      metadata_json: link.metadata === undefined ? null : encodeJson(link.metadata),
      source_refs_json: link.sourceRefs === undefined ? null : encodeJson(link.sourceRefs),
      revision_id: revision.revisionId,
      created_at: revision.createdAtMs,
    }).executeTakeFirstOrThrow()
  }
  await transaction.insertInto("link_heads").values({
    project_id: projectId,
    scope_key: scopeId,
    source_scope_id: scopeId,
    link_id: revision.targetId,
    revision_id: revision.revisionId,
    visibility,
    effective_at: revision.createdAtMs,
    digest: headDigest,
  }).onConflict((conflict) => conflict.columns(["project_id", "scope_key", "link_id"]).doUpdateSet({
    revision_id: revision.revisionId,
    visibility,
    effective_at: revision.createdAtMs,
    digest: headDigest,
  })).execute()
}

async function pendingScopeIsVisible(database: Kysely<ProjectDatabase>, scopeId: ScopeId): Promise<boolean> {
  const scope = await database.selectFrom("artifact_scopes").select("visibility").where("id", "=", scopeId).executeTakeFirst()
  return scope?.visibility === "pending"
}

async function resolveNodeHead(
  database: Kysely<ProjectDatabase>,
  scope: GraphReadScope,
  nodeId: string,
): Promise<NodeHeadRow | undefined> {
  if (scope.pendingScopeId !== undefined && await pendingScopeIsVisible(database, scope.pendingScopeId)) {
    const pending = await database.selectFrom("node_heads").selectAll()
      .where("project_id", "=", scope.projectId)
      .where("scope_key", "=", scope.pendingScopeId)
      .where("node_id", "=", nodeId)
      .executeTakeFirst()
    if (pending !== undefined) {
      return pending
    }
  }
  return database.selectFrom("node_heads").selectAll()
    .where("project_id", "=", scope.projectId)
    .where("scope_key", "=", "committed")
    .where("node_id", "=", nodeId)
    .executeTakeFirst()
}

async function resolveLinkHead(
  database: Kysely<ProjectDatabase>,
  scope: GraphReadScope,
  linkId: string,
): Promise<LinkHeadRow | undefined> {
  if (scope.pendingScopeId !== undefined && await pendingScopeIsVisible(database, scope.pendingScopeId)) {
    const pending = await database.selectFrom("link_heads").selectAll()
      .where("project_id", "=", scope.projectId)
      .where("scope_key", "=", scope.pendingScopeId)
      .where("link_id", "=", linkId)
      .executeTakeFirst()
    if (pending !== undefined) {
      return pending
    }
  }
  return database.selectFrom("link_heads").selectAll()
    .where("project_id", "=", scope.projectId)
    .where("scope_key", "=", "committed")
    .where("link_id", "=", linkId)
    .executeTakeFirst()
}

async function listVisibleLinks(database: Kysely<ProjectDatabase>, scope: GraphReadScope): Promise<readonly GraphLink[]> {
  const committedHeads = await database.selectFrom("link_heads").selectAll()
    .where("project_id", "=", scope.projectId)
    .where("scope_key", "=", "committed")
    .execute()
  const heads = new Map(committedHeads.map((head) => [head.link_id, head]))

  if (scope.pendingScopeId !== undefined && await pendingScopeIsVisible(database, scope.pendingScopeId)) {
    const pendingHeads = await database.selectFrom("link_heads").selectAll()
      .where("project_id", "=", scope.projectId)
      .where("scope_key", "=", scope.pendingScopeId)
      .execute()
    for (const head of pendingHeads) {
      heads.set(head.link_id, head)
    }
  }

  const activeHeads = [...heads.values()].filter((head) => head.visibility !== "retired")
  if (activeHeads.length === 0) {
    return []
  }
  const revisionIds = activeHeads.map((head) => head.revision_id)
  const rows = await database.selectFrom("links").selectAll()
    .where("project_id", "=", scope.projectId)
    .where("revision_id", "in", revisionIds)
    .execute()
  const rowsByRevision = new Map(rows.map((row) => [row.revision_id, row]))
  return activeHeads.flatMap((head) => {
    const row = rowsByRevision.get(head.revision_id)
    return row === undefined ? [] : [mapLink(row)]
  })
}

function mapNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    content: decodeJson(row.content_json),
    ...(row.metadata_json === null ? {} : { metadata: decodeJson(row.metadata_json) as Record<string, unknown> }),
    ...(row.source_refs_json === null ? {} : { sourceRefs: decodeJson(row.source_refs_json) as NonNullable<GraphNode["sourceRefs"]> }),
  }
}

function mapLink(row: LinkRow): GraphLink {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    ...(row.content_json === null ? {} : { content: decodeJson(row.content_json) }),
    ...(row.metadata_json === null ? {} : { metadata: decodeJson(row.metadata_json) as Record<string, unknown> }),
    ...(row.source_refs_json === null ? {} : { sourceRefs: decodeJson(row.source_refs_json) as NonNullable<GraphLink["sourceRefs"]> }),
  }
}

function mapRevision(row: GraphRevisionRow): PersistedGraphRevision {
  return {
    revisionId: row.id,
    scopeId: row.scope_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    operation: row.operation,
    before: row.before_json === null ? null : decodeJson(row.before_json) as GraphNode | GraphLink,
    after: row.after_json === null ? null : decodeJson(row.after_json) as GraphNode | GraphLink,
    ...(row.predecessor_revision_id === null ? {} : { predecessorRevisionId: row.predecessor_revision_id }),
    archiveOutletIds: decodeJson(row.archive_outlet_ids_json) as string[],
    reason: row.reason,
    selfReview: row.self_review,
    evidenceIds: decodeJson(row.evidence_ids_json) as string[],
    createdAtMs: row.created_at,
  }
}
