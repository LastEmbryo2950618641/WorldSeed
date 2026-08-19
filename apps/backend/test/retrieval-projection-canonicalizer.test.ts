import { describe, expect, it } from "vitest"

import { canonicalizeRetrievalProjections } from "../src/application/turns/retrieval-projection-canonicalizer.js"

describe("retrieval projection canonicalization", () => {
  it("merges proposal and existing-owner projections that resolve to one owner revision", () => {
    const projections = canonicalizeRetrievalProjections([
      projection({
        exactKeys: ["七点整后", "后门第三把锁。老周不知道。"],
        semanticText: "旅人七点后接近雾港并持有钥匙。",
      }),
      projection({
        exactKeys: ["旅人", "陈远", "后门第三把锁。老周不知道。"],
        semanticText: "旅人的当前状态与本章行动入口。",
      }),
    ])

    expect(projections).toEqual([{
      projectId: "project_1",
      scopeId: "scope_1",
      ownerKind: "node",
      ownerId: "node_26",
      ownerRevisionId: "revision_1091",
      exactKeys: ["七点整后", "后门第三把锁。老周不知道。", "旅人", "陈远"],
      semanticText: "旅人七点后接近雾港并持有钥匙。\n旅人的当前状态与本章行动入口。",
      sourceRefs: [{ sourceId: "source_98" }],
    }])
  })

  it("keeps projections for different owner revisions separate", () => {
    const projections = canonicalizeRetrievalProjections([
      projection({ ownerRevisionId: "revision_1091", semanticText: "旧状态" }),
      projection({ ownerRevisionId: "revision_1092", semanticText: "新状态" }),
    ])

    expect(projections.map((item) => item.ownerRevisionId)).toEqual([
      "revision_1091",
      "revision_1092",
    ])
  })
})

function projection(overrides: Partial<{
  ownerRevisionId: string
  exactKeys: readonly string[]
  semanticText: string
}> = {}) {
  return {
    projectId: "project_1",
    scopeId: "scope_1",
    ownerKind: "node",
    ownerId: "node_26",
    ownerRevisionId: overrides.ownerRevisionId ?? "revision_1091",
    exactKeys: overrides.exactKeys ?? ["旅人"],
    semanticText: overrides.semanticText ?? "旅人的当前状态。",
    sourceRefs: [{ sourceId: "source_98" }],
  }
}
