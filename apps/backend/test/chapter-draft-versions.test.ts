import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  openChapterHarness,
  seedCommittedChapter,
  type ChapterHarness,
} from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness()
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

describe("revision draft versions", () => {
  it("creates a baseline version on startRevision and appends without changing committed body", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const started = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.startRevision",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          chapterId: chapter.chapterId,
          baseSourceId: chapter.sourceId,
          heading: chapter.heading,
          body: chapter.body,
          inputMode: "agent",
        },
      })
      expect(started.ok).toBe(true)
      const revisionTaskId = (started.data as { revisionTaskId: string }).revisionTaskId

      const listed = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.draftVersion.list",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
        },
      })
      expect(listed.ok).toBe(true)
      const versions = (listed.data as { versions: Array<{ label: string; source: string; isLatest: boolean; body: string }> }).versions
      expect(versions).toHaveLength(1)
      expect(versions[0]?.label).toBe("v0")
      expect(versions[0]?.source).toBe("baseline")
      expect(versions[0]?.isLatest).toBe(true)
      expect(versions[0]?.body).toBe(chapter.body)

      const appended = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.draftVersion.append",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
          source: "agent",
          heading: chapter.heading,
          body: `${chapter.body}\n\n他没有回头。`,
        },
      })
      expect(appended.ok).toBe(true)
      const afterAppend = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.draftVersion.list",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
        },
      })
      const nextVersions = (afterAppend.data as { versions: Array<{ versionId: string; label: string; source: string; isLatest: boolean; parentVersionId?: string }> }).versions
      expect(nextVersions).toHaveLength(2)
      expect(nextVersions[1]?.label).toBe("v1")
      expect(nextVersions[1]?.source).toBe("agent")
      expect(nextVersions[1]?.isLatest).toBe(true)
      expect(nextVersions[1]?.parentVersionId).toBe(nextVersions[0]?.versionId)

      const restored = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.draftVersion.restore",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
          versionId: (nextVersions[0] as { versionId: string }).versionId,
        },
      })
      expect(restored.ok).toBe(true)
      expect((restored.data as { source: string }).source).toBe("rollback")

      const committed = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.read",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          chapterId: chapter.chapterId,
        },
      })
      expect((committed.data as { body: string }).body).toBe(chapter.body)
    })
  })
})
