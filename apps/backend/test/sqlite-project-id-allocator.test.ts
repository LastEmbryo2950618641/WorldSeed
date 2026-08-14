import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { SqliteProjectIdAllocator, openProjectDatabase } from "../src/index.js"

describe("SqliteProjectIdAllocator", () => {
  it("increments each prefix independently and preserves the sequence across instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worldseed-id-allocator-"))
    const databasePath = join(directory, "project.sqlite")
    const projectId = randomUUID()
    const database = await openProjectDatabase(databasePath)
    try {
      await database.insertInto("projects").values({
        id: projectId,
        name: "allocator-test",
        manifest_version: 1,
        committed_sequence: 0,
        created_at: 1,
        updated_at: 1,
      }).executeTakeFirstOrThrow()
      const first = new SqliteProjectIdAllocator(database, () => 2)
      await expect(first.next(projectId, "node")).resolves.toBe("node_1")
      await expect(first.next(projectId, "node")).resolves.toBe("node_2")
      await expect(first.next(projectId, "link")).resolves.toBe("link_1")
    } finally {
      await database.destroy()
    }

    const reopened = await openProjectDatabase(databasePath)
    try {
      const allocator = new SqliteProjectIdAllocator(reopened, () => 3)
      await expect(allocator.next(projectId, "source")).resolves.toBe("source_1")
      await expect(allocator.next(projectId, "node")).resolves.toBe("node_3")
      const concurrent = await Promise.all(Array.from({ length: 20 }, () => allocator.next(projectId, "node")))
      expect(new Set(concurrent).size).toBe(20)
      expect(concurrent.map((id) => Number(id.slice("node_".length))).sort((left, right) => left - right))
        .toEqual(Array.from({ length: 20 }, (_, index) => index + 4))
    } finally {
      await reopened.destroy()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
