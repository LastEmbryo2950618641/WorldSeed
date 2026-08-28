import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION, type SettingsExtractionSnapshot } from "@worldseed/contracts"

import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []
const previousSettingsFixture = process.env.WORLDSEED_FAKE_SETTINGS_EXTRACTION

afterEach(() => {
  if (previousSettingsFixture === undefined) delete process.env.WORLDSEED_FAKE_SETTINGS_EXTRACTION
  else process.env.WORLDSEED_FAKE_SETTINGS_EXTRACTION = previousSettingsFixture
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Settings Extraction Test")
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

describe("settings extraction", () => {
  it("approves create proposals and writes markdown into the settings workspace", async () => {
    await withHarness(async (harness) => {
      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createSettingsExtractionService()
      const taskId = randomUUID()
      const created = await service.createProposalsFromArtifact({
        projectId: harness.projectId,
        taskId,
        phaseRunId: randomUUID(),
        proposals: [{
          payload: {
            kind: "create",
            relativePath: "设定集/人物/林照.md",
            markdown: "# 林照\n\n> 适用范围：第 1 章起\n",
            readmeEntry: "`设定集/人物/林照.md` · 林照 · 第 1 章",
          },
          reason: "正文首次出现该人物",
        }],
      })
      expect(created).toHaveLength(1)

      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        taskId,
      }
      const listed = await invoke<SettingsExtractionSnapshot>(harness, "settings.extraction.list", base)
      expect(listed.proposals.filter((proposal) => proposal.status === "pending")).toHaveLength(1)

      const approved = await invoke<SettingsExtractionSnapshot>(harness, "settings.extraction.proposal.approve", {
        ...base,
        proposalIds: [created[0]!.proposalId],
      })
      expect(approved.proposals.every((proposal) => proposal.status === "approved")).toBe(true)

      const content = await runtime.readMarkdown("设定集/人物/林照.md")
      expect(content).toContain("# 林照")
      const readme = await runtime.readMarkdown("设定集/readme.md")
      expect(readme).toContain("设定集/人物/林照.md")
    })
  })

  it("rejects pending proposals without writing workspace files", async () => {
    await withHarness(async (harness) => {
      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createSettingsExtractionService()
      const taskId = randomUUID()
      const created = await service.createProposalsFromArtifact({
        projectId: harness.projectId,
        taskId,
        phaseRunId: randomUUID(),
        proposals: [{
          payload: {
            kind: "create",
            relativePath: "设定集/地点/盐雾城.md",
            markdown: "# 盐雾城\n",
          },
        }],
      })

      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        taskId,
      }
      const rejected = await invoke<SettingsExtractionSnapshot>(harness, "settings.extraction.proposal.reject", {
        ...base,
        proposalIds: [created[0]!.proposalId],
      })
      expect(rejected.proposals.every((proposal) => proposal.status === "rejected")).toBe(true)

      await expect(runtime.readMarkdown("设定集/地点/盐雾城.md")).rejects.toThrow()
    })
  })

  it("filters create proposals under strict world divergence mode", async () => {
    await withHarness(async (harness) => {
      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const service = runtime.createSettingsExtractionService()
      const taskId = randomUUID()
      const created = await service.createProposalsFromArtifact({
        projectId: harness.projectId,
        taskId,
        phaseRunId: randomUUID(),
        worldDivergenceMode: "strict",
        proposals: [
          {
            payload: {
              kind: "create",
              relativePath: "设定集/人物/新角色.md",
              markdown: "# 新角色\n",
            },
          },
          {
            payload: {
              kind: "update",
              relativePath: "设定集/readme.md",
              markdown: "# 设定集索引\n\n- 已有索引\n",
            },
          },
        ],
      })
      expect(created).toHaveLength(1)
      expect(created[0]?.kind).toBe("update")
    })
  })

  it("pauses a turn at settings extraction when the fake fixture emits proposals", { timeout: 120_000 }, async () => {
    process.env.WORLDSEED_FAKE_SETTINGS_EXTRACTION = "1"
    await withHarness(async (harness) => {
      const handle = await invoke<{ taskId: string }>(harness, "turn.start", {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
        userInput: "雨夜里，旧站台尽头亮起一盏无人认领的灯。",
        chapterSequence: 1,
      })
      let snapshot: { status: string; lastPhase?: string; interruption?: { kind?: string } } | undefined
      for (let attempt = 0; attempt < 120; attempt += 1) {
        snapshot = await invoke(harness, "turn.status", { taskId: handle.taskId })
        if (snapshot.status === "waiting_for_review" || snapshot.status === "completed" || snapshot.status === "failed") break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(snapshot?.status).toBe("waiting_for_review")
      expect(snapshot?.lastPhase).toBe("settings_extraction")
      expect(snapshot?.interruption?.kind).toBe("settings_extraction_review")
    })
  })
})
