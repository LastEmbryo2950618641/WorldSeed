import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { PROTOCOL_VERSION, type ClientResponse } from "@worldseed/contracts"
import { afterEach, describe, expect, it } from "vitest"

import {
  BackendContainer,
  BackendFacade,
  FakeAiModelAdapter,
  MessagePortTransport,
  UnavailableAiModelAdapter,
  type BackendMessagePort,
} from "../src/index.js"

const temporaryDirectories: string[] = []
const openFacades: BackendFacade[] = []

afterEach(async () => {
  for (const facade of openFacades.splice(0)) {
    await facade.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

describe("backend utility runtime", () => {
  it("persists model profiles and the active selection across backend restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-model-profiles-"))
    temporaryDirectories.push(root)
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const firstFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    const saved = await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "model.profiles.save",
      payload: {
        profiles: [{
          id: "deepseek-primary",
          name: "DeepSeek Primary",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          credentialRef: "model-profile:deepseek-primary",
          thinkingModeEnabled: true,
          reasoningEffort: "low",
          jsonModeEnabled: false,
        }],
        activeProfileId: "deepseek-primary",
      },
    })
    expect(saved.ok).toBe(true)
    await firstFacade.close()

    const reopenedFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(reopenedFacade)
    const restored = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "model.profiles.read",
      payload: {},
    })

    expect(restored.ok && restored.data).toEqual({
      profiles: [{
        id: "deepseek-primary",
        name: "DeepSeek Primary",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        credentialRef: "model-profile:deepseek-primary",
        thinkingModeEnabled: true,
        reasoningEffort: "low",
        jsonModeEnabled: false,
      }],
      activeProfileId: "deepseek-primary",
    })
  })

  it("rejects a formal turn when DeepSeek is not configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-no-model-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: new UnavailableAiModelAdapter(),
    }))
    openFacades.push(facade)
    const projectId = randomUUID()

    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "No Model Test", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "必须调用真实模型。", chapterSequence: 1 },
    })

    expect(started.ok).toBe(false)
    if (!started.ok) {
      expect(started.error.code).toBe("model_failure")
      expect(started.error.message).toContain("DEEPSEEK_API_KEY")
    }
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(false)
  })

  it("creates a project, runs a turn asynchronously, and serves the same protocol over MessagePort", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-utility-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(facade)
    const projectId = randomUUID()

    const created = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Utility Test", workspaceRootRef },
    })
    expect(created.ok).toBe(true)

    const listed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "workspace.list",
      payload: { workspaceRootRef },
    })
    expect(listed.ok).toBe(true)

    const saved = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "workspace.save",
      payload: {
        projectId,
        workspaceRootRef,
        relativePath: "设定集/测试设定.md",
        content: "# 测试设定\n",
      },
    })
    expect(saved.ok).toBe(true)
    const read = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "workspace.read",
      payload: { projectId, workspaceRootRef, relativePath: "设定集/测试设定.md" },
    })
    expect(read.ok && read.data).toMatchObject({ content: "# 测试设定\n" })

    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一盏雨夜中的灯开始。", chapterSequence: 1 },
    })
    expect(started.ok).toBe(true)
    const taskId = readTaskId(started)
    const completed = await waitForCompletedTask(facade, taskId)
    expect(completed.ok).toBe(true)
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(true)
    const graphAnchorIds = readGraphAnchorIds(completed)
    const neighborhood = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "graph.neighborhood",
      payload: {
        projectId,
        workspaceRootRef,
        anchorIds: graphAnchorIds,
        direction: "both",
        maxDepth: 2,
        maxNodes: 48,
        maxLinks: 96,
      },
    })
    expect(neighborhood.ok && neighborhood.data).toMatchObject({ truncated: false })

    const oversizedAnchorSet = Array.from({ length: 40 }, (_, index) => (
      graphAnchorIds[index % graphAnchorIds.length]
    ))
    const firstWindow = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "graph.neighborhood",
      payload: {
        projectId,
        workspaceRootRef,
        anchorIds: oversizedAnchorSet,
        anchorOffset: 0,
        direction: "both",
        maxDepth: 2,
        maxNodes: 48,
        maxLinks: 96,
      },
    })
    expect(firstWindow.ok && firstWindow.data).toMatchObject({
      truncated: true,
      anchorWindow: {
        requestedCount: 40,
        processedCount: 32,
        remainingCount: 8,
        nextOffset: 32,
      },
    })
    const finalWindow = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "graph.neighborhood",
      payload: {
        projectId,
        workspaceRootRef,
        anchorIds: oversizedAnchorSet,
        anchorOffset: 32,
        direction: "both",
        maxDepth: 2,
        maxNodes: 48,
        maxLinks: 96,
      },
    })
    expect(finalWindow.ok && finalWindow.data).toMatchObject({
      anchorWindow: {
        requestedCount: 40,
        processedCount: 8,
        remainingCount: 0,
      },
    })

    const responses: ClientResponse[] = []
    const port: BackendMessagePort = {
      postMessage: (response) => responses.push(response),
      on: () => undefined,
    }
    const transport = new MessagePortTransport(port, facade)
    await transport.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.validate",
      payload: { workspaceRootRef },
    })
    expect(responses).toHaveLength(1)
    expect(responses[0]?.ok).toBe(true)

    const mismatch = await facade.handle({
      protocolVersion: "worldseed.v0",
      requestId: randomUUID(),
      method: "project.validate",
      payload: { workspaceRootRef },
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe("protocol_mismatch")
  })
})

function readTaskId(response: ClientResponse): string {
  if (!response.ok || typeof response.data !== "object" || response.data === null || !("taskId" in response.data)) {
    throw new Error("turn.start did not return a task handle")
  }
  const taskId = response.data.taskId
  if (typeof taskId !== "string") throw new Error("task handle has no taskId")
  return taskId
}

function readGraphAnchorIds(response: ClientResponse): string[] {
  if (!response.ok || typeof response.data !== "object" || response.data === null || !("result" in response.data)) {
    throw new Error("turn.status did not return a completed result")
  }
  const result = response.data.result
  if (typeof result !== "object" || result === null || !("graphAnchorIds" in result) || !Array.isArray(result.graphAnchorIds)) {
    throw new Error("completed turn has no graph anchors")
  }
  return result.graphAnchorIds.filter((value): value is string => typeof value === "string")
}

async function waitForCompletedTask(facade: BackendFacade, taskId: string): Promise<ClientResponse> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.status",
      payload: { taskId },
    })
    if (response.ok && typeof response.data === "object" && response.data !== null && "status" in response.data) {
      if (response.data.status === "completed") return response
      if (response.data.status === "failed") throw new Error("background turn failed")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("background turn did not complete")
}
