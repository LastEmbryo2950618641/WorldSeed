import { describe, expect, it } from "vitest"

import {
  applyGraphMutationDecisions,
  emptyGraphLedgerState,
  GraphLedgerError,
  listGraphRevisions,
  openPendingGraphScope,
  promotePendingGraphScope,
  readGraphLink,
  readGraphNode,
  retirePendingGraphScope,
  type GraphMutationDecision,
} from "../src/index.js"

const ids = {
  scope1: "00000000-0000-4000-8000-000000000001",
  scope2: "00000000-0000-4000-8000-000000000002",
  scope3: "00000000-0000-4000-8000-000000000003",
  node1: "00000000-0000-4000-8000-000000000011",
  node2: "00000000-0000-4000-8000-000000000012",
  link1: "00000000-0000-4000-8000-000000000021",
  evidence: "00000000-0000-4000-8000-000000000031",
}

function dependencies() {
  let revision = 100
  return {
    createRevisionId: () => `00000000-0000-4000-8000-${String(revision++).padStart(12, "0")}`,
    now: () => 1234,
  }
}

function decision(mutation: GraphMutationDecision["mutation"]): GraphMutationDecision {
  return {
    mutation,
    reason: "The actual read set supports this mechanical change",
    selfReview: "Identity, continuity, discoverability, and scope were reviewed",
    evidenceIds: [ids.evidence],
  }
}

describe("graph revision ledger", () => {
  it("isolates pending graph writes and preserves every revision after promotion", () => {
    const deps = dependencies()
    let state = openPendingGraphScope(emptyGraphLedgerState, ids.scope1)
    state = applyGraphMutationDecisions(state, ids.scope1, [
      decision({ operation: "create_node", node: { id: ids.node1, content: { value: "first" } } }),
      decision({ operation: "create_node", node: { id: ids.node2, content: { value: "outlet" } } }),
      decision({
        operation: "create_link",
        link: { id: ids.link1, fromNodeId: ids.node1, toNodeId: ids.node2, content: { note: "discoverable" } },
      }),
      decision({ operation: "edit_node", nodeId: ids.node1, next: { content: { value: "second" } } }),
    ], deps)

    expect(readGraphNode(state, ids.node1)).toBeUndefined()
    expect(readGraphNode(state, ids.node1, ids.scope1)?.content).toEqual({ value: "second" })
    expect(readGraphLink(state, ids.link1, ids.scope1)?.toNodeId).toBe(ids.node2)

    state = promotePendingGraphScope(state, ids.scope1)
    const revisions = listGraphRevisions(state, "node", ids.node1)
    expect(readGraphNode(state, ids.node1)?.content).toEqual({ value: "second" })
    expect(revisions).toHaveLength(2)
    expect(revisions[1]?.before).toMatchObject({ content: { value: "first" } })
    expect(revisions[1]?.predecessorRevisionId).toBe(revisions[0]?.revisionId)
  })

  it("archives through an existing outlet without deleting history", () => {
    const deps = dependencies()
    let state = openPendingGraphScope(emptyGraphLedgerState, ids.scope1)
    state = applyGraphMutationDecisions(state, ids.scope1, [
      decision({ operation: "create_node", node: { id: ids.node1, content: "current" } }),
      decision({ operation: "create_node", node: { id: ids.node2, content: "archive outlet" } }),
      decision({ operation: "retire_node", nodeId: ids.node1, archiveOutletIds: [ids.node2] }),
    ], deps)
    state = promotePendingGraphScope(state, ids.scope1)

    expect(readGraphNode(state, ids.node1)).toBeUndefined()
    expect(listGraphRevisions(state, "node", ids.node1)).toHaveLength(2)
    expect(listGraphRevisions(state, "node", ids.node1)[1]?.archiveOutletIds).toEqual([ids.node2])
  })

  it("keeps retired pending scopes invisible and rejects stale promotion", () => {
    const deps = dependencies()
    let state = openPendingGraphScope(emptyGraphLedgerState, ids.scope1)
    state = applyGraphMutationDecisions(state, ids.scope1, [
      decision({ operation: "create_node", node: { id: ids.node1, content: "retired draft" } }),
    ], deps)
    state = retirePendingGraphScope(state, ids.scope1)
    expect(state.scopes.find((scope) => scope.scopeId === ids.scope1)?.visibility).toBe("retired")
    expect(readGraphNode(state, ids.node1, ids.scope1)).toBeUndefined()

    state = openPendingGraphScope(state, ids.scope2)
    state = openPendingGraphScope(state, ids.scope3)
    state = applyGraphMutationDecisions(state, ids.scope2, [
      decision({ operation: "create_node", node: { id: ids.node1, content: "first winner" } }),
    ], deps)
    state = applyGraphMutationDecisions(state, ids.scope3, [
      decision({ operation: "create_node", node: { id: ids.node2, content: "stale candidate" } }),
    ], deps)
    state = promotePendingGraphScope(state, ids.scope2)

    expect(() => promotePendingGraphScope(state, ids.scope3)).toThrow(GraphLedgerError)
  })

  it("rejects links whose endpoints were not actually visible", () => {
    const deps = dependencies()
    const state = openPendingGraphScope(emptyGraphLedgerState, ids.scope1)

    expect(() => applyGraphMutationDecisions(state, ids.scope1, [decision({
      operation: "create_link",
      link: { id: ids.link1, fromNodeId: ids.node1, toNodeId: ids.node2 },
    })], deps)).toThrow(GraphLedgerError)
  })
})
