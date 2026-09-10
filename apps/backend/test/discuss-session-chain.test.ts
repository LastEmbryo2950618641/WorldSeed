import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PROTOCOL_VERSION } from "@worldseed/contracts"
import { afterEach, describe, expect, it } from "vitest"

import {
  FakeAiModelAdapter,
  MODEL_CONTEXT_DELTA_HEADER,
  SqliteProjectRepository,
  SqliteSynopsisConversationRepository,
  digest,
  fixedWorkspaceEntries,
  openProjectDatabase,
  type AIModelPort,
  type ModelExecutionOptions,
  type PhaseModelExecution,
  type PhaseRequestEnvelope,
  type ProjectManifest,
} from "../src/index.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-discuss-chain-"))
  temporaryDirectories.push(directory)
  return directory
}

async function createDiscussStoreFixture() {
  const directory = temporaryDirectory()
  const database = await openProjectDatabase(join(directory, "discuss-chain.sqlite"))
  const projectId = "00000000-0000-4000-8000-000000000101"
  const sessionId = "00000000-0000-4000-8000-000000000102"
  const projectRepository = new SqliteProjectRepository(
    database,
    join(directory, "workspace"),
    join(directory, "internal"),
  )
  const manifest: ProjectManifest = {
    id: projectId,
    protocolVersion: "worldseed.v1",
    manifestVersion: 1,
    displayName: "Discuss Chain",
    workspaceRootRef: join(directory, "workspace"),
    fixedEntries: fixedWorkspaceEntries,
    internalStoreRef: join(directory, "internal"),
    manifestDigest: digest(fixedWorkspaceEntries),
  }
  await projectRepository.create({
    projectId,
    name: manifest.displayName,
    manifestVersion: 1,
    committedSequence: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  }, manifest)
  const conversation = new SqliteSynopsisConversationRepository(database)
  await conversation.createSession({
    sessionId,
    projectId,
    chapterSequence: 1,
    synopsisPath: "章节正文/第一卷 待命名/第一章 测试 [剧情梗概].md",
    title: "测试",
    createdAtMs: 2,
  })
  return { database, projectId, sessionId, conversation }
}

function parseDeltaContent(content: string | undefined): Record<string, unknown> {
  if (content === undefined || !content.startsWith(`${MODEL_CONTEXT_DELTA_HEADER}\n`)) return {}
  return JSON.parse(content.slice(MODEL_CONTEXT_DELTA_HEADER.length + 1)) as Record<string, unknown>
}

class RecordingFakeModel implements AIModelPort {
  public readonly calls: Array<Readonly<{
    turnId: string
    envelopeId: string
    contextKinds: readonly string[]
    contextTurnIds: readonly (string | undefined)[]
    delta: Record<string, unknown>
    evidenceOwnerIds: readonly string[]
    conversationHistory: unknown
    synopsisMarkdown: unknown
  }>> = []

  public constructor(private readonly inner: FakeAiModelAdapter = new FakeAiModelAdapter()) {}

  public get info() {
    return this.inner.info
  }

  public async execute(
    request: PhaseRequestEnvelope,
    options?: ModelExecutionOptions,
  ): Promise<PhaseModelExecution> {
    const execution = await this.inner.execute(request, options)
    const delta = parseDeltaContent(execution.contextExchange?.requestMessages[0]?.content)
    const input = (delta.input ?? {}) as Record<string, unknown>
    const discuss = (input.synopsisDiscuss ?? {}) as Record<string, unknown>
    const evidence = [
      ...asRecords(input.readEvidence),
      ...asRecords(input.presentationEvidence),
    ]
    this.calls.push({
      turnId: request.turnId,
      envelopeId: request.envelopeId,
      contextKinds: (options?.contextMessages ?? []).map((message) => message.kind),
      contextTurnIds: (options?.contextMessages ?? []).map((message) => message.turnId),
      delta,
      evidenceOwnerIds: evidence.flatMap((item) => (
        typeof item.ownerId === "string" ? [item.ownerId] : []
      )),
      conversationHistory: discuss.conversationHistory,
      synopsisMarkdown: discuss.synopsisMarkdown,
    })
    return execution
  }
}

class ReactThenContinueModel implements AIModelPort {
  public readonly recorder = new RecordingFakeModel()
  private firstDiscussCall = true

  public get info() {
    return this.recorder.info
  }

  public async execute(
    request: PhaseRequestEnvelope,
    options?: ModelExecutionOptions,
  ): Promise<PhaseModelExecution> {
    const execution = await this.recorder.execute(request, options)
    if (request.phase !== "synopsis_discuss" || !this.firstDiscussCall) return execution
    this.firstDiscussCall = false
    return {
      ...execution,
      result: {
        ...execution.result,
        outcome: "request_read",
        artifact: undefined,
        requestedReads: [{
          requestId: randomUUID(),
          reason: "Read staging notes after bootstrap evidence is already visible",
          expectedEvidence: "暂存区说明",
          query: {
            exactKeys: ["暂存区/readme.md"],
            semanticTexts: ["暂存区"],
            anchorIds: [],
            directions: ["both"],
            maxCandidates: 2,
            maxDepth: 1,
            sourceKinds: ["reference"],
          },
        }],
      },
    }
  }
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : []
}

async function invoke<T>(
  harness: ChapterHarness,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) throw new Error(JSON.stringify(response.error))
  return response.data as T
}

describe("discuss session chain store", () => {
  it("stores visible discuss context messages per session without touching model_context_chains", async () => {
    const fixture = await createDiscussStoreFixture()
    await fixture.conversation.appendDiscussContextMessages({
      sessionId: fixture.sessionId,
      projectId: fixture.projectId,
      createdAtMs: 10,
      messages: [{
        role: "system",
        kind: "system_rules",
        content: "创作台讨论规则",
      }, {
        role: "user",
        kind: "phase_request",
        taskId: fixture.sessionId,
        turnId: "00000000-0000-4000-8000-000000000201",
        phase: "synopsis_discuss",
        content: "Worldseed context delta JSON:\n{\"input\":{\"userInput\":\"第一轮\"}}",
      }],
    })

    const visible = await fixture.conversation.listDiscussContextMessages(fixture.sessionId)
    expect(visible).toHaveLength(2)
    expect(visible[0]).toMatchObject({
      chainId: fixture.sessionId,
      role: "system",
      kind: "system_rules",
      sequence: 0,
    })
    expect(visible[1]?.turnId).toBe("00000000-0000-4000-8000-000000000201")

    await fixture.conversation.hideDiscussContextMessages(
      fixture.sessionId,
      [visible[1]?.messageId as string],
      20,
    )
    const afterHide = await fixture.conversation.listDiscussContextMessages(fixture.sessionId)
    expect(afterHide.map((message) => message.kind)).toEqual(["system_rules"])

    const chainCount = await fixture.database.selectFrom("model_context_chains").selectAll().execute()
    const turnMessages = await fixture.database.selectFrom("model_context_messages").selectAll().execute()
    expect(chainCount).toEqual([])
    expect(turnMessages).toEqual([])
    await fixture.database.destroy()
  })

  it("deletes the last send's discuss context messages by turn id", async () => {
    const fixture = await createDiscussStoreFixture()
    const firstTurn = "00000000-0000-4000-8000-000000000301"
    const secondTurn = "00000000-0000-4000-8000-000000000302"
    await fixture.conversation.appendDiscussContextMessages({
      sessionId: fixture.sessionId,
      projectId: fixture.projectId,
      createdAtMs: 10,
      messages: [
        { role: "system", kind: "system_rules", content: "rules" },
        {
          role: "user",
          kind: "phase_request",
          turnId: firstTurn,
          phase: "synopsis_discuss",
          content: "delta-one",
        },
        {
          role: "user",
          kind: "phase_request",
          turnId: secondTurn,
          phase: "synopsis_discuss",
          content: "delta-two",
        },
      ],
    })
    await fixture.conversation.deleteDiscussContextMessagesForTurn(fixture.sessionId, secondTurn)
    const remaining = await fixture.conversation.listDiscussContextMessages(fixture.sessionId)
    expect(remaining.map((message) => message.turnId)).toEqual([undefined, firstTurn])
    await fixture.database.destroy()
  })

  it("lets the active session reuse a completed chapter sequence", async () => {
    const fixture = await createDiscussStoreFixture()
    await fixture.conversation.updateSession({
      sessionId: fixture.sessionId,
      status: "completed",
      updatedAtMs: 3,
    })
    const activeSessionId = "00000000-0000-4000-8000-000000000103"
    await fixture.conversation.createSession({
      sessionId: activeSessionId,
      projectId: fixture.projectId,
      chapterSequence: 2,
      synopsisPath: "章节正文/第一卷 待命名/第二章 测试 [剧情梗概].md",
      title: "测试",
      createdAtMs: 4,
    })
    await fixture.conversation.updateSession({
      sessionId: activeSessionId,
      chapterSequence: 1,
      synopsisPath: "章节正文/第一卷 待命名/第一章 测试 [剧情梗概].md",
      updatedAtMs: 5,
    })
    const active = await fixture.conversation.findActiveSession(fixture.projectId)
    expect(active?.sessionId).toBe(activeSessionId)
    expect(active?.chapterSequence).toBe(1)
    await fixture.database.destroy()
  })
})

describe("discuss session chain", () => {
  it("keeps one turnId across ReAct rounds and only deltas new evidence", async () => {
    const model = new ReactThenContinueModel()
    const harness = await openChapterHarness("Discuss ReAct Chain", { model })
    temporaryDirectories.push(harness.root)
    try {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这一章从雨夜站台开始",
      })
      const discussCalls = model.recorder.calls.filter((call) => call.delta.phase === "synopsis_discuss"
        || call.contextKinds.includes("system_rules"))
      expect(discussCalls.length).toBeGreaterThanOrEqual(2)
      expect(discussCalls[1]?.turnId).toBe(discussCalls[0]?.turnId)
      expect(discussCalls[1]?.envelopeId).not.toBe(discussCalls[0]?.envelopeId)
      expect(discussCalls[1]?.contextTurnIds).toContain(discussCalls[0]?.turnId)
      expect(discussCalls[1]?.evidenceOwnerIds.some((ownerId) => ownerId.includes("描写规则"))).toBe(false)
      expect(discussCalls[0]?.conversationHistory).toBeUndefined()
    } finally {
      await harness.container.close()
    }
  }, 20_000)

  it("reuses the session chain on the second send without conversationHistory or unchanged synopsis", async () => {
    const model = new RecordingFakeModel()
    const harness = await openChapterHarness("Discuss Second Send", { model })
    temporaryDirectories.push(harness.root)
    try {
      await invoke(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "这一章从雨夜站台开始",
      })
      const afterFirst = model.calls.length
      await invoke(harness, "synopsis.conversation.send", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        message: "把站台雨声再压一点",
      })
      const secondSend = model.calls.slice(afterFirst)
      expect(secondSend.length).toBeGreaterThan(0)
      expect(secondSend[0]?.contextKinds).toContain("phase_request")
      expect(secondSend[0]?.conversationHistory).toBeUndefined()
      expect(secondSend[0]?.evidenceOwnerIds.some((ownerId) => ownerId.includes("描写规则"))).toBe(false)

      const database = await openProjectDatabase(join(
        harness.applicationDataRoot,
        "projects",
        harness.projectId,
        "project.sqlite",
      ))
      try {
        const turnChains = await database.selectFrom("model_context_chains").selectAll().execute()
        expect(turnChains).toEqual([])
        const session = await new SqliteSynopsisConversationRepository(database).findActiveSession(harness.projectId)
        expect(session).toBeDefined()
        const stored = await new SqliteSynopsisConversationRepository(database)
          .listDiscussContextMessages(session?.sessionId as string)
        expect(stored.some((message) => message.kind === "system_rules")).toBe(true)
        expect(stored.some((message) => message.kind === "phase_request")).toBe(true)
      } finally {
        await database.destroy()
      }
    } finally {
      await harness.container.close()
    }
  }, 20_000)
})
