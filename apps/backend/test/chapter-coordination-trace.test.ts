import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  BackendContainer,
  BackendFacade,
  ChapterContextResolver,
  NodeInternalStoreAdapter,
  SqliteDocumentRepository,
  SqliteTurnPersistence,
  openProjectDatabase,
} from "../src/index.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("chapter coordination trace", () => {
  it("tracks index, revision metadata, hydration supersession, and graph-sync blocking", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-chapter-trace-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const projectId = randomUUID()
    const container = await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    })
    const facade = new BackendFacade(container)
    try {
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Trace Test", workspaceRootRef },
    })

    await runTurn(facade, projectId, workspaceRootRef, "雨夜里，旧站台尽头亮起一盏无人认领的灯。", 1)
    await runTurn(facade, projectId, workspaceRootRef, "旅人循着灯光走进雾气弥漫的月台。", 2)

    const listed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.list",
      payload: { projectId, workspaceRootRef },
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok || !Array.isArray(listed.data)) throw new Error("chapter.list failed")
    expect(listed.data.map((chapter) => (chapter as { sequence?: number }).sequence)).toEqual([1, 2])

    const chapterOne = listed.data[0] as { chapterId: string; sourceId: string; publishPath: string }
    const original = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.read",
      payload: { projectId, workspaceRootRef, chapterId: chapterOne.chapterId },
    })
    expect(original.ok).toBe(true)
    if (!original.ok) throw new Error(original.error.message)
    const originalBody = (original.data as { body: string }).body
    const revisedBody = `${originalBody.trim()}\n\n修订痕迹：灯芯换成了蓝色。`

    const revision = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.startRevision",
      payload: {
        projectId,
        workspaceRootRef,
        chapterId: chapterOne.chapterId,
        baseSourceId: chapterOne.sourceId,
        heading: "第一章 世界种子",
        body: originalBody,
      },
    })
    expect(revision.ok).toBe(true)
    if (!revision.ok) throw new Error(revision.error.message)
    const revisionTaskId = (revision.data as { revisionTaskId: string }).revisionTaskId

    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.updateRevision",
      payload: {
        projectId,
        workspaceRootRef,
        revisionTaskId,
        heading: "第一章 蓝灯初现",
        body: revisedBody,
      },
    })

    const submitted = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, mode: "direct", forced: true },
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) throw new Error(submitted.error.message)
    expect((submitted.data as { graphSyncStatus: string }).graphSyncStatus).toBe("pending")

    const blocked = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: {
        projectId,
        workspaceRootRef,
        userInput: "图同步未完成时，不应允许继续推演。",
        chapterSequence: 99,
      },
    })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) throw new Error("turn.start should be blocked during graph sync")
    expect(blocked.error.code).toBe("revision_invalid_state")

    await waitForRevisionGraphSync(facade, projectId, workspaceRootRef, revisionTaskId)

    const resolved = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.resolve",
      payload: { projectId, workspaceRootRef, chapterId: chapterOne.chapterId },
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error(resolved.error.message)
    expect(resolved.data).toMatchObject({
      index: { sequence: 1 },
      suggestedUiMode: "chapter_read",
      graphSyncBlocking: false,
      revisionStale: false,
    })
    expect((resolved.data as { committed: { body: string } }).committed.body).toContain("修订痕迹：灯芯换成了蓝色。")

    await runTurn(facade, projectId, workspaceRootRef, "第三夜，蓝灯照见了站台尽头被封存的旧信箱。", 3)

    const databasePath = join(applicationDataRoot, "projects", projectId, "project.sqlite")
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    const kysely = await openProjectDatabase(databasePath)
    try {
      const indexRows = database.prepare(
        "select chapter_id, sequence, current_source_id from chapter_index order by sequence",
      ).all() as Array<{ chapter_id: string; sequence: number; current_source_id: string }>
      expect(indexRows).toHaveLength(3)
      expect(indexRows.map((row) => row.sequence)).toEqual([1, 2, 3])
      expect(indexRows[0]?.current_source_id).not.toBe(chapterOne.sourceId)

      const revisionMessage = database.prepare(`
        select metadata_json, content_digest
        from model_context_messages
        where task_id = ? and kind = 'chapter_revision'
      `).get(revisionTaskId) as { metadata_json: string; content_digest: string } | undefined
      expect(revisionMessage).toBeDefined()
      const metadata = JSON.parse(revisionMessage?.metadata_json ?? "{}") as {
        chapterId: string
        replacedSourceId: string
        sourceId: string
      }
      expect(metadata).toMatchObject({
        chapterId: chapterOne.chapterId,
        replacedSourceId: chapterOne.sourceId,
      })
      expect(metadata.sourceId).toBe(indexRows[0]?.current_source_id)

      const internalStorePort = new NodeInternalStoreAdapter(applicationDataRoot)
      const persistence = new SqliteTurnPersistence(kysely, randomUUID)
      const chain = await persistence.ensureModelContextChain({ projectId, createdAtMs: Date.now() })
      const messages = await persistence.listModelContextMessages(chain.chainId)
      const resolver = new ChapterContextResolver({
        documents: new SqliteDocumentRepository(kysely),
        internalStore: internalStorePort,
        persistence,
      })
      const hydrated = await resolver.hydrateNarrativeMessages(projectId, messages)
      const canonical = hydrated.find((message) => message.kind === "canonical_chapter")
      const rawCanonical = messages.find((message) => message.kind === "canonical_chapter")
      const rawContent = rawCanonical?.contentRef === undefined
        ? rawCanonical?.content
        : await internalStorePort.readDocument(rawCanonical.contentRef)
      expect(canonical?.content).toContain("修订痕迹：灯芯换成了蓝色。")
      expect(canonical?.content).not.toBe(rawContent)
    } finally {
      await kysely.destroy()
      database.close()
    }
    } finally {
      await container.close()
    }
  })
})

async function runTurn(
  facade: BackendFacade,
  projectId: string,
  workspaceRootRef: string,
  userInput: string,
  chapterSequence: number,
): Promise<string> {
  const started = await facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "turn.start",
    payload: { projectId, workspaceRootRef, userInput, chapterSequence },
  })
  expect(started.ok).toBe(true)
  if (!started.ok) throw new Error(started.error.message)
  const taskId = (started.data as { taskId: string }).taskId
  await waitForTask(facade, taskId)
  return taskId
}

async function waitForTask(facade: BackendFacade, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.status",
      payload: { taskId },
    })
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.error.message)
    const snapshot = status.data as { status: string }
    if (snapshot.status === "completed") return
    if (["failed", "cancelled"].includes(snapshot.status)) {
      throw new Error(`Task ${taskId} ended with ${snapshot.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Task ${taskId} did not complete`)
}

async function waitForRevisionGraphSync(
  facade: BackendFacade,
  projectId: string,
  workspaceRootRef: string,
  revisionTaskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const revision = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.readRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId },
    })
    expect(revision.ok).toBe(true)
    if (!revision.ok) throw new Error(revision.error.message)
    if ((revision.data as { graphSyncStatus: string }).graphSyncStatus === "completed") return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Revision ${revisionTaskId} graph sync did not complete`)
}
