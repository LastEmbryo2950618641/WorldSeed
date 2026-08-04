import type {
  GraphLink,
  GraphMutation,
  GraphNode,
  ScopeId,
  Visibility,
} from "@worldseed/contracts"

export type GraphTargetKind = "node" | "link"
export type GraphRevisionOperation = "create" | "edit" | "retire"
export type GraphValue = GraphNode | GraphLink

export type GraphRevision = Readonly<{
  revisionId: string
  scopeId: ScopeId
  targetKind: GraphTargetKind
  targetId: string
  operation: GraphRevisionOperation
  predecessorRevisionId?: string
  before: GraphValue | null
  after: GraphValue | null
  archiveOutletIds: readonly string[]
  reason: string
  selfReview: string
  evidenceIds: readonly string[]
  createdAtMs: number
}>

export type GraphHead = Readonly<{
  scopeKey: string
  targetKind: GraphTargetKind
  targetId: string
  revisionId: string
  status: "active" | "retired"
}>

export type GraphScope = Readonly<{
  scopeId: ScopeId
  visibility: Visibility
  baseCommittedSequence: number
}>

export type GraphLedgerState = Readonly<{
  committedSequence: number
  scopes: readonly GraphScope[]
  heads: readonly GraphHead[]
  revisions: readonly GraphRevision[]
}>

export type GraphMutationDecision = Readonly<{
  mutation: GraphMutation
  reason: string
  selfReview: string
  evidenceIds: readonly string[]
}>

export type GraphMutationDependencies = Readonly<{
  createRevisionId: () => string
  now: () => number
}>

export class GraphLedgerError extends Error {
  public constructor(
    public readonly code: "duplicate_target" | "missing_target" | "invalid_scope" | "stale_base" | "missing_endpoint" | "missing_archive_outlet",
    message: string,
  ) {
    super(message)
  }
}

export const emptyGraphLedgerState: GraphLedgerState = Object.freeze({
  committedSequence: 0,
  scopes: Object.freeze([]),
  heads: Object.freeze([]),
  revisions: Object.freeze([]),
})

function findScope(state: GraphLedgerState, scopeId: ScopeId): GraphScope | undefined {
  return state.scopes.find((scope) => scope.scopeId === scopeId)
}

function findHead(state: GraphLedgerState, scopeKey: string, targetKind: GraphTargetKind, targetId: string): GraphHead | undefined {
  return state.heads.find((head) => head.scopeKey === scopeKey && head.targetKind === targetKind && head.targetId === targetId)
}

function findRevision(state: GraphLedgerState, revisionId: string): GraphRevision {
  const revision = state.revisions.find((candidate) => candidate.revisionId === revisionId)
  if (revision === undefined) {
    throw new GraphLedgerError("missing_target", `Revision does not exist: ${revisionId}`)
  }

  return revision
}

function resolveHead(state: GraphLedgerState, targetKind: GraphTargetKind, targetId: string, pendingScopeId?: ScopeId): GraphHead | undefined {
  if (pendingScopeId !== undefined) {
    const scope = findScope(state, pendingScopeId)
    if (scope?.visibility === "pending") {
      const pending = findHead(state, pendingScopeId, targetKind, targetId)
      if (pending !== undefined) {
        return pending
      }
    }
  }

  return findHead(state, "committed", targetKind, targetId)
}

function readTarget(state: GraphLedgerState, targetKind: GraphTargetKind, targetId: string, pendingScopeId?: ScopeId): GraphValue | undefined {
  const head = resolveHead(state, targetKind, targetId, pendingScopeId)
  if (head === undefined || head.status === "retired") {
    return undefined
  }

  return findRevision(state, head.revisionId).after ?? undefined
}

function hasVisibleTarget(state: GraphLedgerState, targetId: string, pendingScopeId: ScopeId): boolean {
  return readTarget(state, "node", targetId, pendingScopeId) !== undefined
    || readTarget(state, "link", targetId, pendingScopeId) !== undefined
}

function replaceHead(heads: readonly GraphHead[], next: GraphHead): readonly GraphHead[] {
  return Object.freeze([
    ...heads.filter((head) => !(head.scopeKey === next.scopeKey && head.targetKind === next.targetKind && head.targetId === next.targetId)),
    Object.freeze(next),
  ])
}

function appendRevision(state: GraphLedgerState, revision: GraphRevision, head: GraphHead): GraphLedgerState {
  return Object.freeze({
    ...state,
    heads: replaceHead(state.heads, head),
    revisions: Object.freeze([...state.revisions, Object.freeze(revision)]),
  })
}

function requirePendingScope(state: GraphLedgerState, scopeId: ScopeId): GraphScope {
  const scope = findScope(state, scopeId)
  if (scope === undefined || scope.visibility !== "pending") {
    throw new GraphLedgerError("invalid_scope", `Pending scope does not exist: ${scopeId}`)
  }

  return scope
}

function applyDecision(
  state: GraphLedgerState,
  scopeId: ScopeId,
  decision: GraphMutationDecision,
  dependencies: GraphMutationDependencies,
): GraphLedgerState {
  const { mutation } = decision
  let targetKind: GraphTargetKind
  let targetId: string
  let operation: GraphRevisionOperation
  let before: GraphValue | null = null
  let after: GraphValue | null = null
  let archiveOutletIds: readonly string[] = Object.freeze([])

  switch (mutation.operation) {
    case "create_node":
      targetKind = "node"
      targetId = mutation.node.id
      operation = "create"
      if (resolveHead(state, targetKind, targetId, scopeId) !== undefined) {
        throw new GraphLedgerError("duplicate_target", `Node already exists: ${targetId}`)
      }
      after = mutation.node
      break
    case "edit_node": {
      targetKind = "node"
      targetId = mutation.nodeId
      operation = "edit"
      const current = readTarget(state, targetKind, targetId, scopeId)
      if (current === undefined || !("content" in current)) {
        throw new GraphLedgerError("missing_target", `Node does not exist: ${targetId}`)
      }
      before = current
      after = { id: targetId, ...mutation.next }
      break
    }
    case "retire_node":
      targetKind = "node"
      targetId = mutation.nodeId
      operation = "retire"
      before = readTarget(state, targetKind, targetId, scopeId) ?? null
      archiveOutletIds = mutation.archiveOutletIds
      break
    case "create_link":
      targetKind = "link"
      targetId = mutation.link.id
      operation = "create"
      if (resolveHead(state, targetKind, targetId, scopeId) !== undefined) {
        throw new GraphLedgerError("duplicate_target", `Link already exists: ${targetId}`)
      }
      after = mutation.link
      break
    case "edit_link":
      targetKind = "link"
      targetId = mutation.linkId
      operation = "edit"
      before = readTarget(state, targetKind, targetId, scopeId) ?? null
      after = { id: targetId, ...mutation.next }
      break
    case "retire_link":
      targetKind = "link"
      targetId = mutation.linkId
      operation = "retire"
      before = readTarget(state, targetKind, targetId, scopeId) ?? null
      archiveOutletIds = mutation.archiveOutletIds
      break
  }

  if (operation !== "create" && before === null) {
    throw new GraphLedgerError("missing_target", `${targetKind} does not exist: ${targetId}`)
  }

  if (after !== null && targetKind === "link") {
    const link = after as GraphLink
    if (readTarget(state, "node", link.fromNodeId, scopeId) === undefined || readTarget(state, "node", link.toNodeId, scopeId) === undefined) {
      throw new GraphLedgerError("missing_endpoint", `Link endpoints must be visible before writing ${targetId}`)
    }
  }

  for (const outletId of archiveOutletIds) {
    if (!hasVisibleTarget(state, outletId, scopeId)) {
      throw new GraphLedgerError("missing_archive_outlet", `Archive outlet does not exist: ${outletId}`)
    }
  }

  const predecessor = resolveHead(state, targetKind, targetId, scopeId)
  const revisionId = dependencies.createRevisionId()
  const revision: GraphRevision = {
    revisionId,
    scopeId,
    targetKind,
    targetId,
    operation,
    ...(predecessor === undefined ? {} : { predecessorRevisionId: predecessor.revisionId }),
    before,
    after,
    archiveOutletIds,
    reason: decision.reason,
    selfReview: decision.selfReview,
    evidenceIds: Object.freeze([...decision.evidenceIds]),
    createdAtMs: dependencies.now(),
  }

  return appendRevision(state, revision, {
    scopeKey: scopeId,
    targetKind,
    targetId,
    revisionId,
    status: operation === "retire" ? "retired" : "active",
  })
}

export function openPendingGraphScope(state: GraphLedgerState, scopeId: ScopeId): GraphLedgerState {
  if (findScope(state, scopeId) !== undefined) {
    throw new GraphLedgerError("invalid_scope", `Graph scope already exists: ${scopeId}`)
  }

  return Object.freeze({
    ...state,
    scopes: Object.freeze([...state.scopes, Object.freeze({
      scopeId,
      visibility: "pending" as const,
      baseCommittedSequence: state.committedSequence,
    })]),
  })
}

export function applyGraphMutationDecisions(
  state: GraphLedgerState,
  scopeId: ScopeId,
  decisions: readonly GraphMutationDecision[],
  dependencies: GraphMutationDependencies,
): GraphLedgerState {
  requirePendingScope(state, scopeId)
  return decisions.reduce(
    (current, decision) => applyDecision(current, scopeId, decision, dependencies),
    state,
  )
}

export function promotePendingGraphScope(state: GraphLedgerState, scopeId: ScopeId): GraphLedgerState {
  const scope = requirePendingScope(state, scopeId)
  if (scope.baseCommittedSequence !== state.committedSequence) {
    throw new GraphLedgerError("stale_base", `Scope ${scopeId} was created from an older committed sequence`)
  }

  const pendingHeads = state.heads.filter((head) => head.scopeKey === scopeId)
  const committedHeads = pendingHeads.reduce(
    (heads, pending) => replaceHead(heads, { ...pending, scopeKey: "committed" }),
    state.heads,
  )

  return Object.freeze({
    committedSequence: state.committedSequence + 1,
    scopes: Object.freeze(state.scopes.map((candidate) => candidate.scopeId === scopeId
      ? Object.freeze({ ...candidate, visibility: "committed" as const })
      : candidate)),
    heads: committedHeads,
    revisions: state.revisions,
  })
}

export function retirePendingGraphScope(state: GraphLedgerState, scopeId: ScopeId): GraphLedgerState {
  requirePendingScope(state, scopeId)
  return Object.freeze({
    ...state,
    scopes: Object.freeze(state.scopes.map((scope) => scope.scopeId === scopeId
      ? Object.freeze({ ...scope, visibility: "retired" as const })
      : scope)),
  })
}

export function readGraphNode(state: GraphLedgerState, nodeId: string, pendingScopeId?: ScopeId): GraphNode | undefined {
  const value = readTarget(state, "node", nodeId, pendingScopeId)
  return value as GraphNode | undefined
}

export function readGraphLink(state: GraphLedgerState, linkId: string, pendingScopeId?: ScopeId): GraphLink | undefined {
  const value = readTarget(state, "link", linkId, pendingScopeId)
  return value as GraphLink | undefined
}

export function listGraphRevisions(state: GraphLedgerState, targetKind: GraphTargetKind, targetId: string): readonly GraphRevision[] {
  return Object.freeze(state.revisions.filter((revision) => revision.targetKind === targetKind && revision.targetId === targetId))
}
