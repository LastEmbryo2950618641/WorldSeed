import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION, SCHEMA_VERSION } from "@worldseed/contracts"
import { revisionAssistArtifactSchema } from "@worldseed/prompt-contracts"

import { openProjectDatabase } from "../src/index.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"
import {
  conversationList,
  conversationSend,
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

describe("chapter revision conversation (P4 design §4.3 / §8.1)", () => {
  it("lists empty messages before any agent revision exists", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const listed = await conversationList(harness, chapter.chapterId)
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect(listed.data).toEqual({ messages: [] })
    })
  })

  it("creates agent revision, persists ordered messages, and exposes revisionTaskId via list", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const sent = await conversationSend(harness, chapter.chapterId, "把灯芯颜色写得更明显一些")
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error(sent.error.message)

      const data = sent.data as {
        revision: { revisionTaskId: string; inputMode?: string }
        messages: Array<{ role: string; content: string; createdAtMs: number; proposal?: { body: string } }>
      }
      expect(data.revision.inputMode).toBe("agent")
      expect(data.messages).toHaveLength(2)
      expect(data.messages[0]?.role).toBe("user")
      expect(data.messages[1]?.role).toBe("assistant")
      expect(data.messages[1]?.proposal?.body.length ?? 0).toBeGreaterThan(0)
      expect(data.messages[0]?.createdAtMs).toBeLessThanOrEqual(data.messages[1]?.createdAtMs ?? 0)

      const listed = await conversationList(harness, chapter.chapterId)
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect((listed.data as { revisionTaskId?: string }).revisionTaskId).toBe(data.revision.revisionTaskId)
      expect((listed.data as { messages: unknown[] }).messages).toHaveLength(2)

      const databasePath = join(harness.applicationDataRoot, "projects", harness.projectId, "project.sqlite")
      const database = new Database(databasePath, { readonly: true, fileMustExist: true })
      try {
        const rows = database.prepare(`
          select role, content_text, proposal_json
          from revision_conversation_messages
          where revision_task_id = ?
          order by created_at_ms asc
        `).all(data.revision.revisionTaskId) as Array<{ role: string; content_text: string; proposal_json: string | null }>
        expect(rows).toHaveLength(2)
        expect(rows[1]?.proposal_json).not.toBeNull()
        const inputMode = database.prepare(
          "select input_mode from chapter_revision_tasks where id = ?",
        ).get(data.revision.revisionTaskId) as { input_mode: string } | undefined
        expect(inputMode?.input_mode).toBe("agent")
      } finally {
        database.close()
      }
    })
  })

  it("reuses the active agent revision and accumulates multi-turn history", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const first = await conversationSend(harness, chapter.chapterId, "把灯芯颜色写得更明显一些")
      const second = await conversationSend(harness, chapter.chapterId, "再加强一点雨夜氛围")
      expect(first.ok && second.ok).toBe(true)
      if (!first.ok || !second.ok) throw new Error("conversation send failed")

      const firstTaskId = (first.data as { revision: { revisionTaskId: string } }).revision.revisionTaskId
      const secondTaskId = (second.data as { revision: { revisionTaskId: string } }).revision.revisionTaskId
      expect(secondTaskId).toBe(firstTaskId)

      const messages = (second.data as { messages: Array<{ role: string; content: string }> }).messages
      expect(messages).toHaveLength(4)
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2)
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2)
    })
  })

  it("returns intent-specific revision_assist responses instead of a single hardcoded reply", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const colorSend = await conversationSend(harness, chapter.chapterId, "把灯芯颜色写得更明显一些")
      const wordCountSend = await conversationSend(harness, chapter.chapterId, "字数太少了，需要2000字左右")
      const suspenseSend = await conversationSend(harness, chapter.chapterId, "让开头更悬疑一些")
      expect(colorSend.ok && wordCountSend.ok && suspenseSend.ok).toBe(true)
      if (!colorSend.ok || !wordCountSend.ok || !suspenseSend.ok) throw new Error("send failed")

      const colorAssistant = findLastAssistant(colorSend.data)
      const wordCountAssistant = findLastAssistant(wordCountSend.data)
      const suspenseAssistant = findLastAssistant(suspenseSend.data)

      expect(colorAssistant?.content).toMatch(/灯芯|要求/)
      expect(wordCountAssistant?.content).toMatch(/2000|扩展|字/)
      expect(suspenseAssistant?.content).toMatch(/悬疑|开头/)

      const assistantBodies = [colorAssistant, wordCountAssistant, suspenseAssistant].map((message) => message?.content)
      expect(new Set(assistantBodies).size).toBe(3)

      expect((wordCountAssistant?.proposal?.body.length ?? 0)).toBeGreaterThan(
        (colorAssistant?.proposal?.body.length ?? 0),
      )
      expect(suspenseAssistant?.proposal?.body).toMatch(/风先停了一瞬|屏住了呼吸/)
    })
  })

  it("does not write conversation content into model_context_messages", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const userMessage = "补充一段旅人心理描写"
      const sent = await conversationSend(harness, chapter.chapterId, userMessage)
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error(sent.error.message)

      const assistant = findLastAssistant(sent.data)
      const databasePath = join(harness.applicationDataRoot, "projects", harness.projectId, "project.sqlite")
      const database = new Database(databasePath, { readonly: true, fileMustExist: true })
      try {
        const chainMessages = database.prepare(`
          select kind, content_text, metadata_json
          from model_context_messages
          where content_text is not null
        `).all() as Array<{ kind: string; content_text: string; metadata_json: string | null }>
        const serialized = chainMessages.map((row) => `${row.kind}:${row.content_text}:${row.metadata_json ?? ""}`).join("\n")
        expect(serialized).not.toContain(userMessage)
        expect(serialized).not.toContain(assistant?.content ?? "")
        const conversationInChain = database.prepare(`
          select count(*) as count from model_context_messages where kind = 'revision_conversation'
        `).get() as { count: number }
        expect(conversationInChain.count).toBe(0)

        const conversationRows = database.prepare(`
          select count(*) as count from revision_conversation_messages
        `).get() as { count: number }
        expect(conversationRows.count).toBe(2)
      } finally {
        database.close()
      }
    })
  })

  it("keeps committed and proposed revision isolated until apply", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const sent = await conversationSend(harness, chapter.chapterId, "字数太少了，需要2000字左右")
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error(sent.error.message)

      const revisionTaskId = (sent.data as { revision: { revisionTaskId: string } }).revision.revisionTaskId
      const assistant = findLastAssistant(sent.data)
      if (assistant?.proposal === undefined) throw new Error("assistant proposal missing")

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
      expect(committed.ok).toBe(true)
      if (!committed.ok) throw new Error(committed.error.message)
      expect((committed.data as { body: string }).body).toBe(chapter.body)

      const revisionBeforeApply = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.readRevision",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
        },
      })
      expect(revisionBeforeApply.ok).toBe(true)
      if (!revisionBeforeApply.ok) throw new Error(revisionBeforeApply.error.message)
      expect((revisionBeforeApply.data as { proposedBody: string }).proposedBody).toBe(chapter.body)

      const applied = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.conversation.apply",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
          messageId: assistant.messageId,
        },
      })
      expect(applied.ok).toBe(true)

      const revisionAfterApply = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.readRevision",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
        },
      })
      expect(revisionAfterApply.ok).toBe(true)
      if (!revisionAfterApply.ok) throw new Error(revisionAfterApply.error.message)
      expect((revisionAfterApply.data as { proposedBody: string }).proposedBody).toBe(assistant.proposal.body)
      expect((committed.data as { body: string }).body).toBe(chapter.body)
    })
  })

  it("rejects apply for messages without proposals or from another revision", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const sent = await conversationSend(harness, chapter.chapterId, "把灯芯颜色写得更明显一些")
      expect(sent.ok).toBe(true)
      if (!sent.ok) throw new Error(sent.error.message)

      const revisionTaskId = (sent.data as { revision: { revisionTaskId: string } }).revision.revisionTaskId
      const userMessageId = (sent.data as { messages: Array<{ messageId: string; role: string }> }).messages
        .find((message) => message.role === "user")?.messageId
      if (userMessageId === undefined) throw new Error("user message missing")

      const missingProposal = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.conversation.apply",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId,
          messageId: userMessageId,
        },
      })
      expect(missingProposal.ok).toBe(false)
      if (missingProposal.ok) throw new Error("apply should fail for user message")
      expect(missingProposal.error.code).toBe("revision_invalid_state")

      const wrongRevision = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.revision.conversation.apply",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          revisionTaskId: randomUUID(),
          messageId: randomUUID(),
        },
      })
      expect(wrongRevision.ok).toBe(false)
      if (wrongRevision.ok) throw new Error("apply should fail for unknown revision")
      expect(wrongRevision.error.code).toBe("revision_invalid_state")
    })
  })

  it("blocks conversation.send while a direct revision is active", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const direct = await harness.facade.handle({
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
        },
      })
      expect(direct.ok).toBe(true)

      const blocked = await conversationSend(harness, chapter.chapterId, "尝试在直接修订中使用对话")
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error("conversation should be blocked during direct revision")
      expect(blocked.error.code).toBe("revision_conflict")
    })
  })

  it("updates suggestedUiMode to chapter_revision_agent after send and chapter_read before", async () => {
    await withHarness(async (harness) => {
      const chapter = await seedCommittedChapter(harness)
      const before = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.resolve",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          chapterId: chapter.chapterId,
        },
      })
      expect(before.ok).toBe(true)
      if (!before.ok) throw new Error(before.error.message)
      expect((before.data as { suggestedUiMode: string }).suggestedUiMode).toBe("chapter_read")

      const sent = await conversationSend(harness, chapter.chapterId, "把灯芯颜色写得更明显一些")
      expect(sent.ok).toBe(true)

      const after = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "chapter.resolve",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          chapterId: chapter.chapterId,
        },
      })
      expect(after.ok).toBe(true)
      if (!after.ok) throw new Error(after.error.message)
      expect((after.data as { suggestedUiMode: string }).suggestedUiMode).toBe("chapter_revision_agent")
    })
  })
})

describe("FakeAiModelAdapter revision_assist", () => {
  it("branches on word-count, suspense, and generic user intents", async () => {
    const adapter = new FakeAiModelAdapter(randomUUID)
    const workingBody = "雨夜里，旧站台尽头亮起一盏无人认领的灯。\n\n旅人停下了脚步。"
    const wordCount = await adapter.execute(createRevisionAssistRequest("字数太少了，需要2000字左右", workingBody))
    const suspense = await adapter.execute(createRevisionAssistRequest("让开头更悬疑一些", workingBody))
    const generic = await adapter.execute(createRevisionAssistRequest("把灯芯颜色写得更明显一些", workingBody))

    const wordCountArtifact = revisionAssistArtifactSchema.parse(wordCount.result.artifact)
    const suspenseArtifact = revisionAssistArtifactSchema.parse(suspense.result.artifact)
    const genericArtifact = revisionAssistArtifactSchema.parse(generic.result.artifact)

    expect(wordCountArtifact.assistantMessage).toMatch(/2000|扩展|字/)
    expect(suspenseArtifact.assistantMessage).toMatch(/悬疑|开头/)
    expect(genericArtifact.assistantMessage).toMatch(/灯芯|要求/)

    expect(wordCountArtifact.proposedBody.length).toBeGreaterThan(workingBody.length)
    expect(suspenseArtifact.proposedBody).toMatch(/风先停了一瞬|屏住了呼吸/)
    expect(genericArtifact.proposedBody).toContain("按你的要求")
  })
})

function findLastAssistant(data: unknown) {
  const messages = (data as { messages: Array<{
    messageId: string
    role: string
    content: string
    proposal?: { body: string }
  }> }).messages
  return messages.findLast((message) => message.role === "assistant")
}

function createRevisionAssistRequest(userMessage: string, workingBody: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    envelopeId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    turnId: randomUUID(),
    contextId: randomUUID(),
    scopeId: randomUUID(),
    phase: "revision_assist" as const,
    protocolVersion: PROTOCOL_VERSION,
    promptRef: "revision_assist@v1",
    promptDigest: "test-digest",
    contextViewRef: "test",
    committedReadIds: [],
    visiblePendingIds: [],
    remainingBudget: {
      maxCalls: 1,
      remainingCalls: 1,
      maxInputTokens: 1_000_000,
      remainingInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      remainingOutputTokens: 64_000,
      deadlineAtMs: Date.now() + 60_000,
      modelRequestDeadlineAtMs: Date.now() + 60_000,
    },
    input: {
      workflow: "revision" as const,
      userInput: userMessage,
      chapterSequence: 0,
      allowWorkspaceChapterReads: false,
      sourceUnitIds: [],
      phaseRunIds: [],
      readEvidence: [],
      retrievalGaps: [],
      artifacts: {},
      revisionAssist: {
        chapterId: randomUUID(),
        heading: "第一章",
        committedBody: workingBody,
        workingBody,
        conversationHistory: [],
      },
    },
  }
}
