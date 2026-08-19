import { describe, expect, it } from "vitest"

import * as backend from "../src/index.js"
import type { TurnReadEvidence } from "../src/application/turns/ports/ai-model-port.js"

type EvidenceVersionModule = Readonly<{
  mergeEvidenceVersions(
    evidence: readonly TurnReadEvidence[],
    options?: Readonly<{ scopeId?: string }>,
  ): readonly (TurnReadEvidence & Readonly<{
    canonicalReadId: string
    readIdAliases: readonly string[]
    versionKey: string
  }>)[]
  canonicalizeEvidenceReadId(
    readId: string,
    evidence: readonly (TurnReadEvidence & Readonly<{
      canonicalReadId?: string
      readIdAliases?: readonly string[]
    }>)[],
  ): string
  collectReadableEvidenceIds(
    ledger: Readonly<{
      committedReadIds: readonly string[]
      visiblePendingIds: readonly string[]
    }>,
    evidence: readonly TurnReadEvidence[],
  ): Readonly<{
    committedReadIds: readonly string[]
    visiblePendingIds: readonly string[]
  }>
}>

const evidenceVersions = backend as unknown as EvidenceVersionModule

describe("Evidence version identity", () => {
  it("merges repeated reads of one immutable workspace version under the first read ID", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", ownerKind: "workspace:setting", ownerId: "设定集/readme.md", digest: "digest-a", exactKeys: ["索引"] }),
      evidence({ readId: "evidence_2", ownerKind: "workspace:setting", ownerId: "设定集/readme.md", digest: "digest-a", exactKeys: ["人物"] }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      readId: "evidence_1",
      canonicalReadId: "evidence_1",
      readIdAliases: ["evidence_2"],
      exactKeys: ["索引", "人物"],
    })
  })

  it("keeps distinct graph revisions while merging repeated reads of each revision", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-a" }),
      evidence({ readId: "evidence_2", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-b" }),
      evidence({ readId: "evidence_3", ownerKind: "node", ownerId: "node_1", revisionId: "revision_2", digest: "projection-c" }),
    ])

    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.revisionId)).toEqual(["revision_1", "revision_2"])
    expect(merged[0]?.readIdAliases).toEqual(["evidence_2"])
  })

  it("keeps distinct source positions while merging repeated reads of one position", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({
        readId: "evidence_1",
        ownerKind: "source",
        ownerId: "source_unit_1",
        revisionId: "revision_1",
        digest: "projection-a",
        sourcePosition: sourcePosition(1),
      }),
      evidence({
        readId: "evidence_2",
        ownerKind: "source",
        ownerId: "source_unit_1",
        revisionId: "revision_1",
        digest: "projection-a",
        sourcePosition: sourcePosition(1),
      }),
      evidence({
        readId: "evidence_3",
        ownerKind: "source",
        ownerId: "source_unit_1",
        revisionId: "revision_1",
        digest: "projection-b",
        sourcePosition: sourcePosition(2),
      }),
    ])

    expect(merged).toHaveLength(2)
    expect(merged[0]?.readIdAliases).toEqual(["evidence_2"])
    expect(merged.map((item) => item.sourcePosition?.sequence)).toEqual([1, 2])
  })

  it("does not merge equal text from different owners", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", ownerKind: "source", ownerId: "source_1", digest: "same-digest" }),
      evidence({ readId: "evidence_2", ownerKind: "source", ownerId: "source_2", digest: "same-digest" }),
    ])

    expect(merged).toHaveLength(2)
  })

  it("includes pending scope in the version identity", () => {
    const first = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", visibility: "pending", ownerKind: "node", ownerId: "local:state", digest: "candidate" }),
    ], { scopeId: "scope-a" })
    const second = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_2", visibility: "pending", ownerKind: "node", ownerId: "local:state", digest: "candidate" }),
    ], { scopeId: "scope-b" })

    expect(first[0]?.versionKey).not.toBe(second[0]?.versionKey)
  })

  it("normalizes every historical alias to its canonical read ID", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-a" }),
      evidence({ readId: "evidence_2", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-a" }),
    ])

    expect(evidenceVersions.canonicalizeEvidenceReadId("evidence_1", merged)).toBe("evidence_1")
    expect(evidenceVersions.canonicalizeEvidenceReadId("evidence_2", merged)).toBe("evidence_1")
    expect(evidenceVersions.canonicalizeEvidenceReadId("evidence_9", merged)).toBe("evidence_9")
  })

  it("keeps the canonical ID while accepting the latest mechanical state role", () => {
    const merged = evidenceVersions.mergeEvidenceVersions([
      evidence({ readId: "evidence_1", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-a", stateRole: "current" }),
      evidence({ readId: "evidence_2", ownerKind: "node", ownerId: "node_1", revisionId: "revision_1", digest: "projection-a", stateRole: "historical" }),
    ])

    expect(merged[0]).toMatchObject({
      readId: "evidence_1",
      canonicalReadId: "evidence_1",
      stateRole: "historical",
    })
  })

  it("keeps ledger evidence readable when the current evidence window no longer carries it", () => {
    const ids = evidenceVersions.collectReadableEvidenceIds({
      committedReadIds: ["evidence_2550"],
      visiblePendingIds: ["evidence_3000"],
    }, [
      evidence({
        readId: "evidence_3100",
        ownerKind: "source",
        ownerId: "source_1",
        digest: "new-source-window",
      }),
    ])

    expect(ids.committedReadIds).toEqual(["evidence_2550", "evidence_3100"])
    expect(ids.visiblePendingIds).toEqual(["evidence_3000"])
  })
})

function evidence(overrides: Partial<TurnReadEvidence> & Pick<TurnReadEvidence, "readId" | "ownerKind" | "ownerId" | "digest">): TurnReadEvidence {
  return {
    visibility: "committed",
    exactKeys: [],
    semanticText: "同一事实的模型可见投影",
    sourceRefs: [],
    ...overrides,
  }
}

function sourcePosition(sequence: number): NonNullable<TurnReadEvidence["sourcePosition"]> {
  return {
    sourceRef: "source_1",
    sequence,
    firstSequence: 1,
    lastSequence: 3,
    unitCount: 3,
    isStart: sequence === 1,
    isEnd: sequence === 3,
  }
}
