import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { ChapterTemporalSourceResolver } from "../src/application/chapters/chapter-temporal-source-resolver.js"
import { SqliteChapterIndexRepository } from "../src/infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import { openProjectDatabase } from "../src/infrastructure/sqlite/index.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Chapter Temporal Resolver Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

describe("ChapterTemporalSourceResolver", () => {
  it("prefers lineage snapshot pins over current chapter heads", async () => {
    await withHarness(async (harness) => {
      const store = await harness.container.internalStore.prepareProject(
        harness.projectId,
        harness.workspaceRootRef,
      )
      const database = await openProjectDatabase(store.projectDatabaseRef)
      const chapterIndex = new SqliteChapterIndexRepository(database)
      const resolver = new ChapterTemporalSourceResolver(database, chapterIndex)

      const chapter1Id = randomUUID()
      const chapter2Id = randomUUID()
      const chapter3Id = randomUUID()
      const headSource1 = randomUUID()
      const pinnedSource1 = randomUUID()
      const source2 = randomUUID()
      const source3 = randomUUID()
      const now = Date.now()

      await database.insertInto("chapter_index").values([
        {
          project_id: harness.projectId,
          chapter_id: chapter1Id,
          sequence: 1,
          current_source_id: headSource1,
          current_publish_path: "章节正文/第1章.md",
          assigned_at_ms: now,
        },
        {
          project_id: harness.projectId,
          chapter_id: chapter2Id,
          sequence: 2,
          current_source_id: source2,
          current_publish_path: "章节正文/第2章.md",
          assigned_at_ms: now,
        },
        {
          project_id: harness.projectId,
          chapter_id: chapter3Id,
          sequence: 3,
          current_source_id: source3,
          current_publish_path: "章节正文/第3章.md",
          assigned_at_ms: now,
        },
      ]).execute()

      await database.insertInto("chapter_lineage_snapshots").values({
        id: randomUUID(),
        project_id: harness.projectId,
        chapter_id: chapter3Id,
        source_id: source3,
        prior_chapter_source_ids_json: JSON.stringify([pinnedSource1, source2]),
        created_at_ms: now,
      }).execute()

      const resolved = await resolver.resolve({
        projectId: harness.projectId,
        targetSequence: 1,
        cursorSequence: 4,
      })

      expect(resolved).toEqual({
        sourceId: pinnedSource1,
        publishPath: "章节正文/第1章.md",
        chapterSequence: 1,
        pinned: true,
        pinnedFromChapterSequence: 3,
      })
      await database.destroy()
    })
  })

  it("falls back to current head when no snapshot pin exists", async () => {
    await withHarness(async (harness) => {
      const store = await harness.container.internalStore.prepareProject(
        harness.projectId,
        harness.workspaceRootRef,
      )
      const database = await openProjectDatabase(store.projectDatabaseRef)
      const chapterIndex = new SqliteChapterIndexRepository(database)
      const resolver = new ChapterTemporalSourceResolver(database, chapterIndex)

      const chapter1Id = randomUUID()
      const headSource1 = randomUUID()
      const now = Date.now()

      await database.insertInto("chapter_index").values({
        project_id: harness.projectId,
        chapter_id: chapter1Id,
        sequence: 1,
        current_source_id: headSource1,
        current_publish_path: "章节正文/第1章.md",
        assigned_at_ms: now,
      }).execute()

      const resolved = await resolver.resolve({
        projectId: harness.projectId,
        targetSequence: 1,
        cursorSequence: 2,
      })

      expect(resolved).toEqual({
        sourceId: headSource1,
        publishPath: "章节正文/第1章.md",
        chapterSequence: 1,
        pinned: false,
      })
      await database.destroy()
    })
  })
})
