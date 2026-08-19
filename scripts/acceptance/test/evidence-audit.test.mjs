import { createRequire } from "node:module"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { deduplicateEvidenceByVersion, readEvidenceProjectionText } from "../lib/evidence-audit.mjs"

const require = createRequire(import.meta.url)
const Database = require(resolve(import.meta.dirname, "../../../apps/backend/node_modules/better-sqlite3"))
const databases = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe("acceptance evidence version audit", () => {
  it("deduplicates aliases of the same fact version", () => {
    const evidence = deduplicateEvidenceByVersion([
      { readId: "read_old", canonicalReadId: "read_old", versionKey: "node:node_1:revision_1", semanticText: "old" },
      { readId: "read_new", canonicalReadId: "read_old", readIdAliases: ["read_new"], versionKey: "node:node_1:revision_1", semanticText: "new" },
    ])

    expect(evidence).toHaveLength(1)
    expect(evidence[0].readId).toBe("read_old")
    expect(evidence[0].semanticText).toBe("new")
  })

  it("retains different revisions of the same owner", () => {
    const evidence = deduplicateEvidenceByVersion([
      { readId: "read_1", versionKey: "node:node_1:revision_1" },
      { readId: "read_2", versionKey: "node:node_1:revision_2" },
    ])

    expect(evidence.map((item) => item.readId)).toEqual(["read_1", "read_2"])
  })

  it("reads the projection belonging to the recalled revision", () => {
    const database = new Database(":memory:")
    databases.push(database)
    database.exec(`create table retrieval_projections (
      project_id text, owner_kind text, owner_id text, owner_revision_id text,
      visibility text, semantic_text text
    )`)
    const insert = database.prepare("insert into retrieval_projections values ('project_1', 'node', 'node_1', ?, 'committed', ?)")
    insert.run("revision_1", "旧状态")
    insert.run("revision_2", "新状态")

    const text = readEvidenceProjectionText(database, "project_1", {
      ownerKind: "node",
      ownerId: "node_1",
      revisionId: "revision_1",
      semanticText: "证据回退文本",
    })

    expect(text).toBe("旧状态")
  })
})
