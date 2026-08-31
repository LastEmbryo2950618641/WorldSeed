import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"
import type { SynopsisConversationSendResult, SynopsisStagingPromoteListResult } from "@worldseed/contracts"

import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Staging Promote Test")
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

describe("synopsis staging promote", () => {
  it("approve writes 设定集 and clears pending proposal", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      await invoke(harness, "synopsis.conversation.start", base)
      const prepared = await invoke<SynopsisConversationSendResult>(harness, "synopsis.conversation.send", {
        ...base,
        message: "确认落盘到设定集与目标",
      })
      expect(prepared.pendingStagingPromotes?.length).toBeGreaterThan(0)
      const proposalId = prepared.pendingStagingPromotes?.[0]?.proposalId
      expect(proposalId).toBeTruthy()

      const listed = await invoke<SynopsisStagingPromoteListResult>(harness, "synopsis.staging.promote.list", {
        ...base,
        sessionId: prepared.session.sessionId,
      })
      expect(listed.proposals).toHaveLength(1)

      await invoke(harness, "synopsis.staging.promote.approve", {
        ...base,
        proposalIds: [proposalId!],
      })

      const after = await invoke<SynopsisStagingPromoteListResult>(harness, "synopsis.staging.promote.list", {
        ...base,
        sessionId: prepared.session.sessionId,
      })
      expect(after.proposals).toHaveLength(0)

      const settings = readFileSync(join(harness.workspaceRootRef, "设定集", "讨论沉淀.md"), "utf8")
      expect(settings).toContain("讨论沉淀")
      const readme = readFileSync(join(harness.workspaceRootRef, "设定集", "readme.md"), "utf8")
      expect(readme).toContain("讨论沉淀")
    })
  }, 30_000)
})
