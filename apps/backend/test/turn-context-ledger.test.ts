import { describe, expect, it } from "vitest"

import {
  appendContextSegments,
  assertCitationsWereRead,
  canUseContextFact,
  createTurnContext,
  recordContextRead,
  TurnContextLedgerError,
} from "../src/index.js"

const ids = {
  context: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000002",
  task: "00000000-0000-4000-8000-000000000003",
  turn: "00000000-0000-4000-8000-000000000004",
  request: "00000000-0000-4000-8000-000000000005",
  read: "00000000-0000-4000-8000-000000000006",
  unread: "00000000-0000-4000-8000-000000000007",
  segment: "00000000-0000-4000-8000-000000000008",
}

function context(maxTokens = 100) {
  return createTurnContext({
    contextId: ids.context,
    projectId: ids.project,
    taskId: ids.task,
    turnId: ids.turn,
    taskKind: "turn",
    baseCommittedSequence: 3,
    maxTokens,
  })
}

describe("TurnContext read ledger", () => {
  it("grants fact access only after an actual returned read is appended", () => {
    const initial = context()
    expect(canUseContextFact(initial, ids.read)).toBe(false)

    const next = recordContextRead(initial, {
      requestId: ids.request,
      returned: [{
        readId: ids.read,
        reason: "Required to resolve an existing reference",
        segment: {
          segmentId: ids.segment,
          kind: "committed_read",
          ownerIds: [ids.read],
          visibility: "committed",
          canonicalDigest: "abc123",
          tokenEstimate: 25,
          sequence: 0,
        },
      }],
      rejectedReadIds: [ids.unread],
    })

    expect(canUseContextFact(next, ids.read)).toBe(true)
    expect(canUseContextFact(next, ids.unread)).toBe(false)
    expect(next.readLedger.requestedReadIds).toEqual([ids.request])
    expect(next.readLedger.returnedReadIds).toEqual([ids.read])
    expect(next.readLedger.rejectedReadIds).toEqual([ids.unread])
    expect(next.budget.usedTokens).toBe(25)
    expect(() => {
      assertCitationsWereRead(next, [ids.read])
    }).not.toThrow()
    expect(() => {
      assertCitationsWereRead(next, [ids.unread])
    }).toThrow(TurnContextLedgerError)
  })

  it("rejects fabricated read segments and token overflow", () => {
    expect(() => recordContextRead(context(), {
      requestId: ids.request,
      returned: [{
        readId: ids.read,
        reason: "Mismatched segment",
        segment: {
          segmentId: ids.segment,
          kind: "pending_artifact",
          ownerIds: [ids.unread],
          visibility: "pending",
          canonicalDigest: "abc123",
          tokenEstimate: 10,
          sequence: 0,
        },
      }],
      rejectedReadIds: [],
    })).toThrow(TurnContextLedgerError)

    expect(() => appendContextSegments(context(5), [{
      segmentId: ids.segment,
      kind: "user_input",
      ownerIds: [ids.turn],
      visibility: "pending",
      canonicalDigest: "abc123",
      tokenEstimate: 6,
      sequence: 0,
    }])).toThrow(TurnContextLedgerError)
  })
})
