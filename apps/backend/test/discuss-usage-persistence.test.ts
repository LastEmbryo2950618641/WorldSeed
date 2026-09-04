import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import { synopsisConversationStreamHub } from "../src/application/chapters/synopsis-conversation-stream-hub.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Discuss Usage Persistence")
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

describe("discuss usage persistence", () => {
  it("persists cumulative discuss usage across hub clear and list hydrate", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      const sent = await invoke<{
        usage?: { inputTokens?: number; outputTokens?: number }
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台开场",
      })
      expect((sent.usage?.inputTokens ?? 0) + (sent.usage?.outputTokens ?? 0)).toBeGreaterThan(0)

      synopsisConversationStreamHub.resetCumulativeUsage(harness.projectId)
      expect(synopsisConversationStreamHub.readCumulativeUsage(harness.projectId)).toBeUndefined()

      const listed = await invoke<{
        usage?: { inputTokens?: number; outputTokens?: number }
      }>(harness, "synopsis.conversation.list", base)
      expect(listed.usage?.inputTokens).toBe(sent.usage?.inputTokens)
      expect(listed.usage?.outputTokens).toBe(sent.usage?.outputTokens)
      expect(synopsisConversationStreamHub.readCumulativeUsage(harness.projectId)?.inputTokens)
        .toBe(sent.usage?.inputTokens)
    })
  })

  it("persists usage after refreshChoices", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      const sent = await invoke<{
        usage?: { inputTokens?: number; outputTokens?: number }
        messages: Array<{ messageId: string; role: string; choices?: unknown[] }>
      }>(harness, "synopsis.conversation.send", {
        ...base,
        message: "雨夜站台开场",
      })
      const assistant = sent.messages.find((message) => message.role === "assistant" && (message.choices?.length ?? 0) > 0)
      expect(assistant).toBeDefined()
      const before = (sent.usage?.inputTokens ?? 0) + (sent.usage?.outputTokens ?? 0)

      const refreshed = await invoke<{
        usage?: { inputTokens?: number; outputTokens?: number }
      }>(harness, "synopsis.conversation.refreshChoices", {
        ...base,
        messageId: assistant!.messageId,
      })
      const after = (refreshed.usage?.inputTokens ?? 0) + (refreshed.usage?.outputTokens ?? 0)
      expect(after).toBeGreaterThanOrEqual(before)

      synopsisConversationStreamHub.resetCumulativeUsage(harness.projectId)
      const listed = await invoke<{
        usage?: { inputTokens?: number; outputTokens?: number }
      }>(harness, "synopsis.conversation.list", base)
      expect((listed.usage?.inputTokens ?? 0) + (listed.usage?.outputTokens ?? 0)).toBe(after)
    })
  })
})

describe("turn.latest.get", () => {
  it("returns null when the project has no tasks", async () => {
    await withHarness(async (harness) => {
      const latest = await invoke(harness, "turn.latest.get", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      expect(latest).toBeNull()
    })
  })
})
