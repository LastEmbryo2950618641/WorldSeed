import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  BackendContainer,
  BackendFacade,
  type BackendContainer as BackendContainerType,
} from "../../src/index.js"
import { FakeAiModelAdapter } from "../../src/infrastructure/models/fake-ai-model-adapter.js"

export type ChapterHarness = Readonly<{
  root: string
  workspaceRootRef: string
  applicationDataRoot: string
  projectId: string
  container: BackendContainerType
  facade: BackendFacade
}>

export async function openChapterHarness(displayName = "Conversation Test"): Promise<ChapterHarness> {
  const root = mkdtempSync(join(tmpdir(), "worldseed-chapter-harness-"))
  const workspaceRootRef = join(root, "workspace")
  const applicationDataRoot = join(root, "application-data")
  const promptPackageRoot = fileURLToPath(new URL("../../../../packages/prompt-contracts/", import.meta.url))
  const projectId = randomUUID()
  const container = await BackendContainer.open({
    applicationDataRoot,
    promptPackageRoot,
    model: new FakeAiModelAdapter(randomUUID),
  })
  const facade = new BackendFacade(container)
  await facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "project.create",
    payload: { projectId, displayName, workspaceRootRef },
  })
  return { root, workspaceRootRef, applicationDataRoot, projectId, container, facade }
}

export async function runTurn(
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
  if (!started.ok) throw new Error(started.error.message)
  const taskId = (started.data as { taskId: string }).taskId
  await waitForTask(facade, taskId)
  return taskId
}

export async function waitForTask(facade: BackendFacade, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.status",
      payload: { taskId },
    })
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

export async function waitForRevisionGraphSync(
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
    if (!revision.ok) throw new Error(revision.error.message)
    if ((revision.data as { graphSyncStatus: string }).graphSyncStatus === "completed") return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Revision ${revisionTaskId} graph sync did not complete`)
}

export async function listFirstChapter(facade: BackendFacade, projectId: string, workspaceRootRef: string) {
  const listed = await facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "chapter.list",
    payload: { projectId, workspaceRootRef },
  })
  if (!listed.ok || !Array.isArray(listed.data) || listed.data.length === 0) {
    throw new Error("chapter.list failed or returned no chapters")
  }
  return listed.data[0] as { chapterId: string; sourceId: string; publishPath: string; heading?: string }
}

export async function seedCommittedChapter(harness: ChapterHarness): Promise<{
  chapterId: string
  sourceId: string
  body: string
  heading: string
}> {
  await runTurn(
    harness.facade,
    harness.projectId,
    harness.workspaceRootRef,
    "雨夜里，旧站台尽头亮起一盏无人认领的灯。",
    1,
  )
  const chapter = await listFirstChapter(harness.facade, harness.projectId, harness.workspaceRootRef)
  const read = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "chapter.read",
    payload: {
      projectId: harness.projectId,
      workspaceRootRef: harness.workspaceRootRef,
      chapterId: chapter.chapterId,
    },
  })
  if (!read.ok) throw new Error(read.error.message)
  const data = read.data as { body: string; heading: string }
  return { chapterId: chapter.chapterId, sourceId: chapter.sourceId, body: data.body, heading: data.heading }
}

export async function conversationSend(
  harness: ChapterHarness,
  chapterId: string,
  message: string,
) {
  return harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "chapter.revision.conversation.send",
    payload: {
      projectId: harness.projectId,
      workspaceRootRef: harness.workspaceRootRef,
      chapterId,
      message,
    },
  })
}

export async function conversationList(harness: ChapterHarness, chapterId: string) {
  return harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: "chapter.revision.conversation.list",
    payload: {
      projectId: harness.projectId,
      workspaceRootRef: harness.workspaceRootRef,
      chapterId,
    },
  })
}
