import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"

import {
  clearSynopsisSendCancellation,
  isSynopsisSendCancelled,
} from "../src/application/chapters/synopsis-send-cancellation.js"
import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Synopsis Discard Turn Test")
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

describe("synopsis.conversation.discardLastUserTurn", () => {
  it("marks in-flight send cancelled and returns the conversation list", async () => {
    await withHarness(async (harness) => {
      const started = await invoke<{ session: { sessionId: string } }>(harness, "synopsis.conversation.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      })
      clearSynopsisSendCancellation(harness.projectId)
      expect(isSynopsisSendCancelled(harness.projectId)).toBe(false)

      const discarded = await invoke<{ messages: readonly unknown[] }>(
        harness,
        "synopsis.conversation.discardLastUserTurn",
        {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          sessionId: started.session.sessionId,
        },
      )

      expect(isSynopsisSendCancelled(harness.projectId)).toBe(true)
      expect(Array.isArray(discarded.messages)).toBe(true)
      clearSynopsisSendCancellation(harness.projectId)
    })
  })
})
