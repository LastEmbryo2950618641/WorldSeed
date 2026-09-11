import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import Database from "better-sqlite3"
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
  const harness = await openChapterHarness("Discuss Chapter Draft Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

async function invoke<T>(harness: ChapterHarness, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) expect.fail(JSON.stringify(response.error))
  return response.data as T
}

function bumpCommittedSequence(harness: ChapterHarness): void {
  const database = new Database(join(harness.applicationDataRoot, "projects", harness.projectId, "project.sqlite"))
  try {
    database.prepare("update projects set committed_sequence = committed_sequence + 1").run()
  } finally {
    database.close()
  }
}

function markRevisionCompleted(harness: ChapterHarness, revisionTaskId: string): void {
  const database = new Database(join(harness.applicationDataRoot, "projects", harness.projectId, "project.sqlite"))
  try {
    database.prepare(`
      update chapter_revision_tasks
      set decision = 'submit', status = 'completed', graph_sync_status = 'completed'
      where id = ?
    `).run(revisionTaskId)
  } finally {
    database.close()
  }
}

function markRevisionCommittingContent(harness: ChapterHarness, revisionTaskId: string): void {
  const database = new Database(join(harness.applicationDataRoot, "projects", harness.projectId, "project.sqlite"))
  try {
    database.prepare(`
      update chapter_revision_tasks
      set decision = 'submit', status = 'committing_content'
      where id = ?
    `).run(revisionTaskId)
  } finally {
    database.close()
  }
}

async function startDiscussOnPublishedChapter(harness: ChapterHarness, sequence = 1): Promise<void> {
  await invoke(harness, "synopsis.conversation.start", {
    projectId: harness.projectId,
    workspaceRootRef: harness.workspaceRootRef,
  })
  await invoke(harness, "synopsis.conversation.setFocus", {
    projectId: harness.projectId,
    workspaceRootRef: harness.workspaceRootRef,
    chapterSequence: sequence,
    focusKind: "chapter_body",
  })
}

describe("discuss auto-append chapter drafts", () => {
  it("appends a draft from discuss send without changing the official body", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const publishedPath = (await invoke<{ publishPath: string }>(harness, "chapter.read", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: chapter.chapterId,
      })).publishPath
      const before = readFileSync(join(harness.workspaceRootRef, publishedPath), "utf8")

      await startDiscussOnPublishedChapter(harness)
      const sent = await invoke<{
        session: { chapterSequence: number }
        appendedDraft?: { revisionTaskId: string; chapterId: string; draftLabel: string }
        messages: Array<{ role: string; choices?: Array<{ action: string }> }>
      }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "改正文，把开头写得更冷",
      })

      expect(sent.appendedDraft?.chapterId).toBe(chapter.chapterId)
      expect(sent.appendedDraft?.draftLabel).toMatch(/^v\d+$/u)
      const assistant = [...sent.messages].reverse().find((message) => message.role === "assistant")
      expect(assistant?.choices?.some((choice) => choice.action === "promote_draft_to_body")).toBe(true)

      const after = readFileSync(join(harness.workspaceRootRef, publishedPath), "utf8")
      expect(after).toBe(before)

      const listed = await invoke<{
        versions: Array<{ label: string; source: string; isLatest: boolean; body: string }>
      }>(harness, "chapter.revision.draftVersion.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId: sent.appendedDraft!.revisionTaskId,
      })
      expect(listed.versions.some((version) => version.isLatest && version.source === "agent")).toBe(true)
      expect(listed.versions.at(-1)?.body).toContain("雨停之后，巷口的灯还亮着。")
    })
  })

  it("parents a second discuss draft on the previous node", async () => {
    await withHarness(async (harness) => {
      await seedCommittedChapter(harness)
      await startDiscussOnPublishedChapter(harness)
      const first = await invoke<{ appendedDraft?: { revisionTaskId: string; draftVersionId: string } }>(
        harness,
        "synopsis.conversation.send",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          message: "改正文，把开头写得更冷",
        },
      )
      const second = await invoke<{ appendedDraft?: { revisionTaskId: string; draftVersionId: string } }>(
        harness,
        "synopsis.conversation.send",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          message: "改正文，再改一次开头",
        },
      )
      expect(second.appendedDraft?.revisionTaskId).toBe(first.appendedDraft?.revisionTaskId)
      const listed = await invoke<{
        versions: Array<{ versionId: string; parentVersionId?: string; isLatest: boolean }>
      }>(harness, "chapter.revision.draftVersion.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId: first.appendedDraft!.revisionTaskId,
      })
      const latest = listed.versions.find((version) => version.isLatest)
      expect(latest?.versionId).toBe(second.appendedDraft?.draftVersionId)
      expect(latest?.parentVersionId).toBeDefined()
      expect(listed.versions.some((version) => version.versionId === first.appendedDraft?.draftVersionId)).toBe(true)
    })
  })

  it("pins a locked chapter send even if the session focus had moved", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      await invoke(harness, "synopsis.conversation.setFocus", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterSequence: 2,
        focusKind: "plot_synopsis",
      })
      const sent = await invoke<{
        session: { chapterSequence: number }
        appendedDraft?: { chapterId: string }
        messages: Array<{ role: string; choices?: Array<{ action: string }> }>
      }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "改正文，把开头写得更冷，并把焦点调到第2章",
        focusLocked: true,
        lockedChapterSequence: 1,
        lockedFocusKind: "chapter_body",
      })
      expect(sent.session.chapterSequence).toBe(1)
      expect(sent.appendedDraft?.chapterId).toBe(chapter.chapterId)
      const assistant = [...sent.messages].reverse().find((message) => message.role === "assistant")
      expect(assistant?.choices?.some((choice) => choice.action === "set_focus")).toBeFalsy()
    })
  })

  it("promotes a discuss draft after a later committed sequence", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      await startDiscussOnPublishedChapter(harness)
      const sent = await invoke<{ appendedDraft?: { revisionTaskId: string } }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "改正文，把开头写得更冷",
      })
      expect(sent.appendedDraft?.revisionTaskId).toBeDefined()
      bumpCommittedSequence(harness)

      const submitted = await invoke<{ status: string }>(harness, "chapter.submitRevision", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId: sent.appendedDraft!.revisionTaskId,
        mode: "direct",
        forced: true,
      })
      expect(submitted.status).toBe("graph_sync_pending")
      const after = await invoke<{ body: string; publishPath: string }>(harness, "chapter.read", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: chapter.chapterId,
      })
      expect(after.body).toContain("雨停之后，巷口的灯还亮着。")
      expect(readFileSync(join(harness.workspaceRootRef, after.publishPath), "utf8")).toContain("雨停之后，巷口的灯还亮着。")
    })
  })

  it("keeps discuss drafts after covering the official body", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      await startDiscussOnPublishedChapter(harness)
      const sent = await invoke<{ appendedDraft?: { revisionTaskId: string } }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "改正文，把开头写得更冷",
      })
      expect(sent.appendedDraft?.revisionTaskId).toBeDefined()
      const revisionTaskId = sent.appendedDraft!.revisionTaskId

      await invoke(harness, "chapter.submitRevision", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId,
        mode: "direct",
        forced: true,
      })
      const published = await invoke<{ sourceId: string; publishPath: string; heading: string; body: string }>(
        harness,
        "chapter.read",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          chapterId: chapter.chapterId,
        },
      )
      const reused = await invoke<{ revisionTaskId: string }>(harness, "chapter.startRevision", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: chapter.chapterId,
        baseSourceId: published.sourceId,
        heading: published.heading,
        body: published.body,
        inputMode: "agent",
      })
      expect(reused.revisionTaskId).toBe(revisionTaskId)

      const resolved = await invoke<{
        activeRevision?: { revisionTaskId: string; status: string }
      }>(harness, "chapter.resolveByPath", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        publishPath: published.publishPath,
      })
      expect(resolved.activeRevision?.revisionTaskId).toBe(revisionTaskId)

      const listed = await invoke<{
        versions: Array<{ source: string; isLatest: boolean; isCurrentOfficial?: boolean }>
      }>(harness, "chapter.revision.draftVersion.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId,
      })
      expect(listed.versions.some((version) => version.source === "agent" && version.isLatest)).toBe(true)
      expect(listed.versions.some((version) => version.source === "agent" && version.isCurrentOfficial === true)).toBe(true)
      expect(listed.versions.some((version) => version.source === "baseline" && version.isCurrentOfficial !== true)).toBe(true)

      markRevisionCompleted(harness, revisionTaskId)
      const afterComplete = await invoke<{
        activeRevision?: { revisionTaskId: string; status: string }
      }>(harness, "chapter.resolveByPath", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        publishPath: published.publishPath,
      })
      expect(afterComplete.activeRevision?.revisionTaskId).toBe(revisionTaskId)
      expect(afterComplete.activeRevision?.status).toBe("completed")

      const stray = await invoke<{ revisionTaskId: string }>(harness, "chapter.startRevision", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: chapter.chapterId,
        baseSourceId: published.sourceId,
        heading: published.heading,
        body: published.body,
        inputMode: "agent",
      })
      expect(stray.revisionTaskId).not.toBe(revisionTaskId)
      const afterStray = await invoke<{
        activeRevision?: { revisionTaskId: string }
      }>(harness, "chapter.resolveByPath", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        publishPath: published.publishPath,
      })
      expect(afterStray.activeRevision?.revisionTaskId).toBe(revisionTaskId)
      const history = await invoke<{
        versions: Array<{ source: string; isLatest: boolean; isCurrentOfficial?: boolean }>
      }>(harness, "chapter.revision.draftVersion.list", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId: stray.revisionTaskId,
        includeChapterHistory: true,
      })
      expect(history.versions.some((version) => version.source === "baseline" && version.isCurrentOfficial !== true)).toBe(true)
      expect(history.versions.some((version) => version.source === "agent" && version.isCurrentOfficial === true)).toBe(true)
    })
  })

  it("resumes a revision left in committing_content", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      await startDiscussOnPublishedChapter(harness)
      const sent = await invoke<{ appendedDraft?: { revisionTaskId: string } }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "改正文，把开头写得更冷",
      })
      expect(sent.appendedDraft?.revisionTaskId).toBeDefined()
      markRevisionCommittingContent(harness, sent.appendedDraft!.revisionTaskId)

      const submitted = await invoke<{ status: string }>(harness, "chapter.submitRevision", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        revisionTaskId: sent.appendedDraft!.revisionTaskId,
        mode: "direct",
        forced: true,
      })
      expect(submitted.status).toBe("graph_sync_pending")
      const after = await invoke<{ body: string }>(harness, "chapter.read", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        chapterId: chapter.chapterId,
      })
      expect(after.body).toContain("雨停之后，巷口的灯还亮着。")
    })
  })

  it("does not append a draft when the discuss turn has no chapterDraftProposal", async () => {
    await withHarness(async (harness) => {
      await seedCommittedChapter(harness)
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      const sent = await invoke<{ appendedDraft?: unknown }>(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "继续讨论下一章节奏与人物关系",
      })
      expect(sent.appendedDraft).toBeUndefined()
    })
  })
})
