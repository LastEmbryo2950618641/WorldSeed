import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile as writeFileAsync } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"

import {
  historyCheckoutResultSchema,
  PROTOCOL_VERSION,
  runtimeMetricsSnapshotSchema,
  type ClientResponse,
} from "@worldseed/contracts"
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
        apiProtocol: "openai_chat_completions",
        contextWindowTokens: 1_000_000,
        thinkingModeEnabled: true,
        reasoningEffort: "low",
        jsonModeEnabled: false,
        disableResponseStorage: true,
        serviceTier: "auto",
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
    const automaticHistory = await waitForHistoryEntries(facade, projectId, workspaceRootRef, 1)
    expect(automaticHistory).toMatchObject([{
      kind: "automatic",
      state: "complete_world",
      status: "ready",
      taskId,
    }])

    const manualOperationId = randomUUID()
    const manualSaved = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.saveManual",
      payload: {
        projectId,
        workspaceRootRef,
        operationId: manualOperationId,
        name: "雨夜灯火前",
        note: "验证手动保存",
      },
    })
    const manualRetried = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.saveManual",
      payload: {
        projectId,
        workspaceRootRef,
        operationId: manualOperationId,
        name: "雨夜灯火前",
        note: "验证手动保存",
      },
    })
    expect(manualSaved.ok).toBe(true)
    expect(manualRetried.ok && manualRetried.data).toEqual(manualSaved.ok ? manualSaved.data : undefined)
    const allHistory = await waitForHistoryEntries(facade, projectId, workspaceRootRef, 2)
    expect(allHistory.map((entry) => entry.kind)).toEqual(["manual", "automatic"])

    const restored = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.restore",
      payload: {
        projectId,
        workspaceRootRef,
        operationId: randomUUID(),
        entryId: automaticHistory[0]?.entryId,
      },
    })
    expect(restored.ok && restored.data).toMatchObject({
      entry: { entryId: automaticHistory[0]?.entryId },
      branch: { name: "主世界线" },
    })

    const continued = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.continueFrom",
      payload: {
        projectId,
        workspaceRootRef,
        operationId: randomUUID(),
        entryId: automaticHistory[0]?.entryId,
      },
    })
    expect(continued.ok).toBe(true)
    if (!continued.ok) throw new Error(continued.error.message)
    const continuedCheckout = historyCheckoutResultSchema.parse(continued.data)
    expect(continuedCheckout).toMatchObject({
      entry: { entryId: automaticHistory[0]?.entryId },
      branch: { forkEntryId: automaticHistory[0]?.entryId },
    })
    expect(typeof continuedCheckout.branch.parentBranchId).toBe("string")

    const branches = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.branches",
      payload: { projectId, workspaceRootRef },
    })
    expect(branches.ok && branches.data).toMatchObject([
      { name: "主世界线", status: "active" },
      { name: "世界线 2", status: "active", forkEntryId: automaticHistory[0]?.entryId },
    ])
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

    const fallbackResponses: ClientResponse[] = []
    let shouldFailToSend = true
    const failingPort: BackendMessagePort = {
      postMessage: (response) => {
        if (shouldFailToSend) {
          shouldFailToSend = false
          throw new Error("simulated structured clone failure")
        }
        fallbackResponses.push(response)
      },
      on: () => undefined,
    }
    const failingTransport = new MessagePortTransport(failingPort, facade)
    await failingTransport.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.validate",
      payload: { workspaceRootRef },
    })
    expect(fallbackResponses).toHaveLength(1)
    expect(fallbackResponses[0]).toMatchObject({
      ok: false,
      error: { code: "storage_failure", recoverable: true },
    })

    const mismatch = await facade.handle({
      protocolVersion: "worldseed.v0",
      requestId: randomUUID(),
      method: "project.validate",
      payload: { workspaceRootRef },
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe("protocol_mismatch")
  })

  it("resumes an interrupted turn through the backend protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-resume-"))
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

    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Resume Test", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一盏灯开始。", chapterSequence: 1, maxModelCalls: 1 },
    })
    const taskId = readTaskId(started)
    const interrupted = await waitForTaskStatus(facade, taskId, "awaiting_user_decision")
    expect(readPhaseNames(interrupted)).toEqual(["interpret"])
    if (interrupted.ok && typeof interrupted.data === "object" && interrupted.data !== null && "phaseRuns" in interrupted.data) {
      const phaseRuns = interrupted.data.phaseRuns
      expect(Array.isArray(phaseRuns)).toBe(true)
      expect(phaseRuns?.every((run) => typeof run === "object" && run !== null && !("request" in run))).toBe(true)
    }

    const resumed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId, maxModelCalls: 63, resetMetricIds: ["model_calls"] },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })

    const completed = await waitForTaskStatus(facade, taskId, "completed")
    expect(readPhaseNames(completed).filter((phase) => phase === "interpret")).toHaveLength(1)
    expect(readPhaseNames(completed)[1]).toBe("rule_assembly")
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(true)
    expect(await waitForHistoryEntries(facade, projectId, workspaceRootRef, 1)).toMatchObject([{
      kind: "automatic",
      status: "ready",
      taskId,
    }])
  })

  it("commits a user chapter revision without mutating the original source", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-chapter-revision-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }), { automaticEvolutionEnabled: false })
    openFacades.push(facade)
    const projectId = randomUUID()

    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Chapter Revision", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一盏灯开始。", chapterSequence: 1 },
    })
    await waitForTaskStatus(facade, readTaskId(started), "completed")

    const listed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.list",
      payload: { projectId, workspaceRootRef },
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok || !Array.isArray(listed.data)) throw new Error("chapter.list did not return chapters")
    const chapter = listed.data[0] as { chapterId: string; sourceId: string }
    expect(chapter.chapterId).toBeTruthy()

    const original = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.read",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId },
    })
    expect(original.ok).toBe(true)
    if (!original.ok) throw new Error(original.error.message)
    const originalContent = (original.data as { content: string }).content
    const revisedBody = `${originalContent.replace(/^#\s*第一章 世界种子\s*/u, "").trim()}\n\n用户明确修改的结尾。`
    const revisedContent = `# 第一章 灯火新生\n\n${revisedBody}`

    const revision = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.startRevision",
      payload: {
        projectId,
        workspaceRootRef,
        chapterId: chapter.chapterId,
        baseSourceId: chapter.sourceId,
        heading: "第一章 世界种子",
        body: originalContent.replace(/^#\s*第一章 世界种子\s*/u, "").trim(),
      },
    })
    expect(revision.ok).toBe(true)
    if (!revision.ok) throw new Error(revision.error.message)
    const revisionTaskId = (revision.data as { revisionTaskId: string }).revisionTaskId

    const updated = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.updateRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, heading: "第一章 灯火新生", body: revisedBody },
    })
    expect(updated.ok).toBe(true)

    const submitted = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, mode: "direct", forced: true },
    })
    if (!submitted.ok) throw new Error(`${submitted.error.code}: ${submitted.error.message}`)
    expect(submitted.ok && submitted.data).toMatchObject({
      revisionTaskId,
      decision: "submit",
      graphSyncStatus: "pending",
      status: "graph_sync_pending",
    })
    expect(await waitForChapterRevision(facade, {
      projectId,
      workspaceRootRef,
      revisionTaskId,
      graphSyncStatus: "completed",
    })).toMatchObject({ status: "completed", graphSyncStatus: "completed" })

    const current = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.read",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId },
    })
    expect(current.ok).toBe(true)
    if (!current.ok) throw new Error(current.error.message)
    expect((current.data as { content: string }).content).toBe(revisedContent)
    expect(current.data).toMatchObject({
      heading: "第一章 灯火新生",
      publishPath: "章节正文/第一章 灯火新生.md",
    })
    expect((current.data as { sourceId: string }).sourceId).not.toBe(chapter.sourceId)
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(false)
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 灯火新生.md"))).toBe(true)

    const duplicateSubmit = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, mode: "direct", forced: true },
    })
    expect(duplicateSubmit.ok).toBe(true)
    expect(duplicateSubmit.data).toMatchObject({ revisionTaskId, status: "completed" })

    const projectDatabase = new Database(join(root, "application-data", "projects", projectId, "project.sqlite"), {
      readonly: true,
      fileMustExist: true,
    })
    try {
      expect(Number(projectDatabase.prepare(`
        select count(*) count from model_context_messages
        where task_id = ? and kind = 'chapter_revision'
      `).get(revisionTaskId)?.count ?? 0)).toBe(1)
      expect(Number(projectDatabase.prepare(`
        select count(*) count from graph_revisions
        where scope_id in (select scope_id from tasks where kind = 'revision' and id <> ?)
      `).get(revisionTaskId)?.count ?? 0)).toBeGreaterThan(0)
      expect(Number(projectDatabase.prepare(`
        select count(*) count from settlement_records
        where source_unit_id in (select id from source_units where source_id = ?)
      `).get((current.data as { sourceId: string }).sourceId)?.count ?? 0)).toBeGreaterThan(0)
    } finally {
      projectDatabase.close()
    }

    const nextRevision = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.startRevision",
      payload: {
        projectId,
        workspaceRootRef,
        chapterId: chapter.chapterId,
        baseSourceId: (current.data as { sourceId: string }).sourceId,
        heading: "第一章 灯火新生",
        body: (current.data as { body: string }).body,
      },
    })
    expect(nextRevision.ok).toBe(true)
    if (!nextRevision.ok) throw new Error(nextRevision.error.message)
    const nextRevisionTaskId = (nextRevision.data as { revisionTaskId: string }).revisionTaskId
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.updateRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId: nextRevisionTaskId, heading: "第一章 灯火新生", body: "用户的新版本。" },
    })
    const reviewedWithoutReview = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId: nextRevisionTaskId, mode: "reviewed", forced: false },
    })
    expect(reviewedWithoutReview.ok).toBe(false)
    if (reviewedWithoutReview.ok) throw new Error("Reviewed submission bypassed the review requirement")
    expect(reviewedWithoutReview.error.code).toBe("revision_conflict")
    const reviewResult = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.reviewRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId: nextRevisionTaskId },
    })
    expect(reviewResult.ok).toBe(true)
    if (!reviewResult.ok) throw new Error(reviewResult.error.message)
    const reviewId = (reviewResult.data as { review?: { reviewId: string } }).review?.reviewId
    expect(reviewId).toBeTruthy()
    await writeFileAsync(join(workspaceRootRef, "章节正文", "第一章 灯火新生.md"), "外部程序修改。", "utf8")
    const externalConflict = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId: nextRevisionTaskId, mode: "reviewed", forced: false, reviewId },
    })
    expect(externalConflict.ok).toBe(false)
    if (externalConflict.ok) throw new Error("External workspace conflict was not rejected")
    expect(externalConflict.error.code).toBe("storage_failure")
  })

  it("resumes failed revision graph synchronization without rolling back the committed prose", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-chapter-revision-recovery-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const fake = new FakeAiModelAdapter(randomUUID)
    let failRevisionGraph = true
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request, options) => {
          const workflow = (request.input as { workflow?: string }).workflow
          if (failRevisionGraph && workflow === "revision" && request.phase === "graph_structure_plan") {
            throw new Error("simulated revision graph interruption")
          }
          const execution = await fake.execute(request, options)
          if (workflow === "revision" && request.phase === "graph_governance") {
            return {
              ...execution,
              result: {
                ...execution.result,
                artifact: {
                  ...(execution.result.artifact as Record<string, unknown>),
                  executionMode: "full_governance",
                },
              },
            }
          }
          return execution
        },
      },
    }), { automaticEvolutionEnabled: false })
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Chapter Revision Recovery", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一盏灯开始。", chapterSequence: 1 },
    })
    await waitForTaskStatus(facade, readTaskId(started), "completed")
    const chapters = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.list",
      payload: { projectId, workspaceRootRef },
    })
    if (!chapters.ok || !Array.isArray(chapters.data)) throw new Error("chapter.list did not return chapters")
    const chapter = chapters.data[0] as { chapterId: string; sourceId: string }
    const original = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.read",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId },
    })
    if (!original.ok) throw new Error(original.error.message)
    const revisedContent = `# 第一章 世界种子\n\n${(original.data as { body: string }).body}\n\n恢复测试修订。`
    const revision = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.startRevision",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId, baseSourceId: chapter.sourceId, heading: "第一章 世界种子", body: `${(original.data as { body: string }).body}\n\n恢复测试修订。` },
    })
    if (!revision.ok) throw new Error(revision.error.message)
    const revisionTaskId = (revision.data as { revisionTaskId: string }).revisionTaskId
    const accepted = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, mode: "direct", forced: true },
    })
    expect(accepted.ok && accepted.data).toMatchObject({
      revisionTaskId,
      decision: "submit",
      graphSyncStatus: "pending",
      status: "graph_sync_pending",
    })
    const persistedAfterFailure = await waitForChapterRevision(facade, {
      projectId,
      workspaceRootRef,
      revisionTaskId,
      graphSyncStatus: "failed",
    })
    expect(persistedAfterFailure).toMatchObject({
      revisionTaskId,
      decision: "submit",
      graphSyncStatus: "failed",
      status: "awaiting_user_decision",
      finalization: {
        revisionTaskId,
        status: "graph_sync_pending",
      },
    })
    const activeAfterFailure = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.findActiveRevision",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId },
    })
    expect(activeAfterFailure.ok && activeAfterFailure.data).toMatchObject({ revisionTaskId })
    const committedAfterFailure = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.read",
      payload: { projectId, workspaceRootRef, chapterId: chapter.chapterId },
    })
    expect(committedAfterFailure.ok && (committedAfterFailure.data as { content: string }).content).toBe(revisedContent)

    failRevisionGraph = false
    const resumed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.submitRevision",
      payload: { projectId, workspaceRootRef, revisionTaskId, mode: "direct", forced: true },
    })
    if (!resumed.ok) throw new Error(`${resumed.error.code}: ${resumed.error.message}`)
    expect(resumed.data).toMatchObject({ status: "graph_sync_pending", graphSyncStatus: "pending" })
    expect(await waitForChapterRevision(facade, {
      projectId,
      workspaceRootRef,
      revisionTaskId,
      graphSyncStatus: "completed",
    })).toMatchObject({ status: "completed", graphSyncStatus: "completed" })

    const database = new Database(join(applicationDataRoot, "projects", projectId, "project.sqlite"), { readonly: true })
      try {
      expect(Number(database.prepare(`select count(*) count from model_context_messages where task_id = ? and kind = 'chapter_revision'`).get(revisionTaskId)?.count ?? 0)).toBe(1)
        expect(Number(database.prepare(`select count(distinct graph_sync_task_id) count from chapter_revision_tasks where id = ?`).get(revisionTaskId)?.count ?? 0)).toBe(1)
        expect(database.prepare(`select status from chapter_revision_finalizations where revision_task_id = ?`).get(revisionTaskId)).toEqual({ status: "completed" })
      } finally {
      database.close()
    }
  })

  it("persists runtime metric windows and requires an explicit reset before resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-runtime-metrics-"))
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

    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Runtime Metrics", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一束光开始。", chapterSequence: 1, maxModelCalls: 1 },
    })
    const taskId = readTaskId(started)
    const interrupted = await waitForTaskStatus(facade, taskId, "awaiting_user_decision")
    const interruptedMetrics = readRuntimeMetrics(interrupted)
    expect(interruptedMetrics.metrics.find((metric) => metric.metricId === "context_tokens")?.current)
      .toBe(readLatestRequestInputTokens(interrupted))
    expect(interruptedMetrics.metrics.find((metric) => metric.metricId === "model_calls")).toMatchObject({
      metricId: "model_calls",
      current: 1,
      limit: 1,
      cumulative: 1,
      state: "exhausted",
      blocking: true,
      resettable: true,
      resetGeneration: 0,
    })

    const resumeWithoutReset = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId },
    })
    expect(resumeWithoutReset.ok).toBe(false)

    const reset = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.metrics.reset",
      payload: { taskId, metricIds: ["model_calls"] },
    })
    expect(reset.ok).toBe(true)
    if (!reset.ok) throw new Error(reset.error.message)
    const resetMetrics = runtimeMetricsSnapshotSchema.parse(reset.data)
    expect(resetMetrics.metrics.find((metric) => metric.metricId === "model_calls")).toMatchObject({
      metricId: "model_calls",
      current: 0,
      limit: 400,
      cumulative: 1,
      resetGeneration: 1,
    })

    const resumed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })
    await waitForTaskStatus(facade, taskId, "completed")
  })

  it("rehydrates an interrupted turn after the backend process is reopened", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-rehydrate-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const projectId = randomUUID()
    const firstFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))

    await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Rehydrate Test", workspaceRootRef },
    })
    const started = await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "跨进程继续推演。", chapterSequence: 1, maxModelCalls: 1 },
    })
    const taskId = readTaskId(started)
    await waitForTaskStatus(firstFacade, taskId, "awaiting_user_decision")
    await firstFacade.close()

    const reopenedFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(reopenedFacade)
    const opened = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.open",
      payload: { workspaceRootRef },
    })
    expect(opened.ok).toBe(true)

    const recoverableTasks = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.recoverable.list",
      payload: { projectId, workspaceRootRef },
    })
    expect(recoverableTasks.ok && recoverableTasks.data).toHaveLength(1)
    expect(recoverableTasks.ok && recoverableTasks.data).toMatchObject([{
      status: "awaiting_user_decision",
      handle: { taskId, status: "awaiting_user_decision" },
    }])
    if (recoverableTasks.ok && Array.isArray(recoverableTasks.data)) {
      expect(recoverableTasks.data[0]).toMatchObject({ phaseRuns: [{ phase: "interpret", status: "completed" }] })
    }

    const resumed = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId, maxModelCalls: 63, resetMetricIds: ["model_calls"] },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })
    const completed = await waitForTaskStatus(reopenedFacade, taskId, "completed")
    expect(readPhaseNames(completed).filter((phase) => phase === "interpret")).toHaveLength(1)
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(true)
  })

  it("rehydrates a query from a late phase whose checkpoint omits the workspace catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-query-rehydrate-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const projectId = randomUUID()
    const fake = new FakeAiModelAdapter(randomUUID)
    const firstFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request) => {
          if (request.phase === "response_review") throw new Error("simulated response review failure")
          return fake.execute(request)
        },
      },
    }))

    await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Query Resume Test", workspaceRootRef },
    })
    const started = await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "world.query",
      payload: { projectId, workspaceRootRef, question: "查询已知世界事实。", maxModelCalls: 20 },
    })
    const taskId = readTaskId(started)
    const interrupted = await waitForTaskStatus(firstFacade, taskId, "awaiting_user_decision")
    expect(readPhaseNames(interrupted).at(-1)).toBe("response_review")
    await firstFacade.close()

    const reopenedFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(reopenedFacade)
    await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.open",
      payload: { workspaceRootRef },
    })
    const resumed = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId, maxModelCalls: 20 },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })

    const completed = await waitForTaskStatus(reopenedFacade, taskId, "completed")
    expect(readPhaseNames(completed).filter((phase) => phase === "response_review")).toHaveLength(2)
  })

  it("recovers a running turn left behind by a backend restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-stale-running-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const applicationDataRoot = join(root, "application-data")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const projectId = randomUUID()
    const fake = new FakeAiModelAdapter(randomUUID)
    const modelGate = new Promise<void>(() => {})
    const firstFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request) => {
          await modelGate
          return fake.execute(request)
        },
      },
    }))

    await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Stale Running Test", workspaceRootRef },
    })
    const started = await firstFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "运行中重启。", chapterSequence: 1 },
    })
    const taskId = readTaskId(started)
    await waitForPhaseRunStatus(firstFacade, taskId, "running")
    await firstFacade.close()

    const reopenedFacade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(reopenedFacade)
    await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.open",
      payload: { workspaceRootRef },
    })

    const recoverableTasks = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.recoverable.list",
      payload: { projectId, workspaceRootRef },
    })
    expect(recoverableTasks.ok && recoverableTasks.data).toMatchObject([{
      status: "awaiting_user_decision",
      handle: { taskId, status: "awaiting_user_decision" },
      interruption: { kind: "execution_error", recoverable: true },
      phaseRuns: [{ phase: "interpret", status: "failed" }],
    }])

    const resumed = await reopenedFacade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })
    const completed = await waitForTaskStatus(reopenedFacade, taskId, "completed")
    expect(readPhaseNames(completed).filter((phase) => phase === "interpret")).toHaveLength(2)
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(true)
  })

  it("serves the first status request after turn initialization while the model is still running", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-status-race-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const fake = new FakeAiModelAdapter(randomUUID)
    let releaseModel: (() => void) | undefined
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request) => {
          await modelGate
          return fake.execute(request)
        },
      },
    }))
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Status Race", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "开始。", chapterSequence: 1 },
    })
    const taskId = readTaskId(started)

    const status = await Promise.race([
      facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "turn.status",
        payload: { taskId },
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error("initial status request timed out")) }, 500)),
    ])
    releaseModel?.()

    expect(status.ok && status.data).toMatchObject({ status: "running" })
    expect(status.ok && status.data).not.toHaveProperty("orchestrator")
    expect(status.ok && status.data).not.toHaveProperty("turnInput")
    expect(() => structuredClone(status)).not.toThrow()
  })

  it("aborts an active model request and ignores its late success", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-cancel-running-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const fake = new FakeAiModelAdapter(randomUUID)
    let releaseModel: (() => void) | undefined
    let observedSignal: AbortSignal | undefined
    let modelCalls = 0
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request, options) => {
          modelCalls += 1
          observedSignal = options?.signal
          await modelGate
          return fake.execute(request)
        },
      },
    }))
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Cancel Running", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "取消正在运行的推演。", chapterSequence: 1 },
    })
    const taskId = readTaskId(started)
    await waitForPhaseRunStatus(facade, taskId, "running")

    const cancelled = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.cancel",
      payload: { taskId },
    })
    expect(cancelled.ok && cancelled.data).toMatchObject({ taskId, status: "cancelled" })
    expect(observedSignal?.aborted).toBe(true)

    releaseModel?.()
    await waitForPhaseRunStatus(facade, taskId, "cancelled")
    const finalStatus = await waitForTaskStatus(facade, taskId, "cancelled")
    expect(finalStatus.ok && finalStatus.data).toMatchObject({ status: "cancelled" })
    expect(modelCalls).toBe(1)
    expect(readPhaseRunStatuses(finalStatus)).toContain("cancelled")
    expect(existsSync(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"))).toBe(false)
  })

  it("pauses an active request without letting its late callback overwrite the paused task", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-pause-running-"))
    temporaryDirectories.push(root)
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const fake = new FakeAiModelAdapter(randomUUID)
    let releaseModel: (() => void) | undefined
    let observedSignal: AbortSignal | undefined
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot: join(root, "application-data"),
      promptPackageRoot,
      model: {
        info: fake.info,
        execute: async (request, options) => {
          observedSignal = options?.signal
          await modelGate
          return fake.execute(request, options)
        },
      },
    }))
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Pause Running", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "暂停正在运行的推演。", chapterSequence: 1 },
    })
    const taskId = readTaskId(started)
    await waitForPhaseRunStatus(facade, taskId, "running")

    const paused = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.pause",
      payload: { taskId },
    })
    expect(paused.ok && paused.data).toMatchObject({ taskId, status: "paused" })
    expect(observedSignal?.aborted).toBe(true)

    releaseModel?.()
    await waitForPhaseRunStatus(facade, taskId, "cancelled")
    const stablePaused = await waitForTaskStatus(facade, taskId, "paused")
    expect(stablePaused.ok && stablePaused.data).toMatchObject({ status: "paused" })

    const resumed = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.resume",
      payload: { taskId },
    })
    expect(resumed.ok && resumed.data).toMatchObject({ taskId, status: "running" })
    await waitForTaskStatus(facade, taskId, "completed")
  })

  it("automatically evolves the committed world on the same context chain without publishing a chapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-auto-evolution-"))
    temporaryDirectories.push(root)
    const applicationDataRoot = join(root, "application-data")
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }))
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "Automatic Evolution", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "世界从一盏雨夜中的灯开始。", chapterSequence: 1 },
    })
    const turnTaskId = readTaskId(started)
    await waitForTaskStatus(facade, turnTaskId, "completed")

    const databasePath = join(applicationDataRoot, "projects", projectId, "project.sqlite")
    const evolution = await waitForAutomaticEvolution(databasePath, turnTaskId)
    expect(evolution.status).toBe("completed")
    expect(evolution.origin).toEqual({ kind: "automatic_evolution", triggerTaskId: turnTaskId })
    expect(evolution.graphRevisionCount).toBeGreaterThan(0)
    expect(evolution.chapterCount).toBe(0)
    expect(evolution.contextChainCount).toBe(1)
  })

  it("can suppress automatic evolution for an isolated acceptance run", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-no-auto-evolution-"))
    temporaryDirectories.push(root)
    const applicationDataRoot = join(root, "application-data")
    const workspaceRootRef = join(root, "workspace")
    const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
    const facade = new BackendFacade(await BackendContainer.open({
      applicationDataRoot,
      promptPackageRoot,
      model: new FakeAiModelAdapter(randomUUID),
    }), { automaticEvolutionEnabled: false })
    openFacades.push(facade)
    const projectId = randomUUID()
    await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "project.create",
      payload: { projectId, displayName: "No Automatic Evolution", workspaceRootRef },
    })
    const started = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.start",
      payload: { projectId, workspaceRootRef, userInput: "只完成前台章节。", chapterSequence: 1 },
    })
    const turnTaskId = readTaskId(started)
    await waitForTaskStatus(facade, turnTaskId, "completed")
    await waitForHistoryEntries(facade, projectId, workspaceRootRef, 1)

    const database = new Database(join(applicationDataRoot, "projects", projectId, "project.sqlite"), {
      readonly: true,
      fileMustExist: true,
    })
    try {
      expect(database.prepare("select count(*) count from tasks where kind = 'evolution'").get()?.count).toBe(0)
    } finally {
      database.close()
    }
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

function readRuntimeMetrics(response: ClientResponse) {
  if (!response.ok) throw new Error(response.error.message)
  if (typeof response.data !== "object" || response.data === null || !("runtimeMetrics" in response.data)) {
    throw new Error("Task response has no runtime metrics")
  }
  return runtimeMetricsSnapshotSchema.parse(response.data.runtimeMetrics)
}

function readLatestRequestInputTokens(response: ClientResponse): number {
  if (!response.ok || typeof response.data !== "object" || response.data === null || !("phaseRuns" in response.data)) {
    throw new Error("Task response has no phase runs")
  }
  const phaseRuns = response.data.phaseRuns
  if (!Array.isArray(phaseRuns)) throw new Error("Task phase runs are invalid")
  const latest = phaseRuns.at(-1)
  if (typeof latest !== "object" || latest === null || !("usage" in latest)) {
    throw new Error("Latest phase run has no usage")
  }
  const usage = latest.usage
  if (typeof usage !== "object" || usage === null || !("lastRequestInputTokens" in usage)) {
    throw new Error("Latest phase run has no provider input Token count")
  }
  const inputTokens = usage.lastRequestInputTokens
  if (typeof inputTokens !== "number") throw new Error("Provider input Token count is invalid")
  return inputTokens
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

async function waitForChapterRevision(
  facade: BackendFacade,
  input: Readonly<{
    projectId: string
    workspaceRootRef: string
    revisionTaskId: string
    graphSyncStatus: string
  }>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "chapter.readRevision",
      payload: input,
    })
    if (response.ok && typeof response.data === "object" && response.data !== null
      && "graphSyncStatus" in response.data && response.data.graphSyncStatus === input.graphSyncStatus) {
      return response.data as Record<string, unknown>
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`chapter revision did not reach graph sync status ${input.graphSyncStatus}`)
}

async function waitForHistoryEntries(
  facade: BackendFacade,
  projectId: string,
  workspaceRootRef: string,
  minimumCount: number,
): Promise<readonly { entryId: string; kind: string; status: string }[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "history.list",
      payload: { projectId, workspaceRootRef },
    })
    if (response.ok && typeof response.data === "object" && response.data !== null && "entries" in response.data) {
      const entries = (response.data as { entries: readonly { entryId: string; kind: string; status: string }[] }).entries
      if (entries.length >= minimumCount && entries.slice(0, minimumCount).every((entry) => entry.status === "ready")) {
        return entries
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`history list did not reach ${String(minimumCount)} entries`)
}

async function waitForAutomaticEvolution(databasePath: string, triggerTaskId: string): Promise<{
  status: string
  origin: unknown
  graphRevisionCount: number
  chapterCount: number
  contextChainCount: number
}> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!existsSync(databasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      continue
    }
    const database = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      const rows = database.prepare(`
        select id, status, scope_id, config_snapshot_json
        from tasks where kind = 'evolution' order by created_at
      `).all() as { id: string; status: string; scope_id: string; config_snapshot_json: string }[]
      for (const row of rows) {
        const config = JSON.parse(row.config_snapshot_json) as { executionOrigin?: unknown }
        if (JSON.stringify(config.executionOrigin) !== JSON.stringify({ kind: "automatic_evolution", triggerTaskId })) continue
        if (row.status === "awaiting_user_decision" || row.status === "failed" || row.status === "cancelled") {
          throw new Error(`automatic evolution stopped with ${row.status}`)
        }
        if (row.status !== "completed") continue
        return {
          status: row.status,
          origin: config.executionOrigin,
          graphRevisionCount: Number(database.prepare("select count(*) count from graph_revisions where scope_id = ?").get(row.scope_id)?.count ?? 0),
          chapterCount: Number(database.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(row.id)?.count ?? 0),
          contextChainCount: Number(database.prepare("select count(*) count from model_context_chains").get()?.count ?? 0),
        }
      }
    } finally {
      database.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("automatic evolution did not complete")
}

async function waitForTaskStatus(facade: BackendFacade, taskId: string, expectedStatus: string): Promise<ClientResponse> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.status",
      payload: { taskId },
    })
    if (response.ok && typeof response.data === "object" && response.data !== null && "status" in response.data) {
      if (response.data.status === expectedStatus) return response
      if (response.data.status === "failed") throw new Error("background turn failed")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`background turn did not reach ${expectedStatus}`)
}

async function waitForPhaseRunStatus(facade: BackendFacade, taskId: string, expectedStatus: string): Promise<ClientResponse> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await facade.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      method: "turn.status",
      payload: { taskId },
    })
    if (response.ok && typeof response.data === "object" && response.data !== null && "phaseRuns" in response.data) {
      const phaseRuns = response.data.phaseRuns
      if (Array.isArray(phaseRuns) && phaseRuns.some((run) => (
        typeof run === "object" && run !== null && "status" in run && run.status === expectedStatus
      ))) return response
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`background turn did not create a ${expectedStatus} phase run`)
}

function readPhaseNames(response: ClientResponse): string[] {
  if (!response.ok || typeof response.data !== "object" || response.data === null || !("phaseRuns" in response.data)) return []
  const phaseRuns = response.data.phaseRuns
  if (!Array.isArray(phaseRuns)) return []
  return phaseRuns.flatMap((run) => typeof run === "object" && run !== null && "phase" in run && typeof run.phase === "string" ? [run.phase] : [])
}

function readPhaseRunStatuses(response: ClientResponse): string[] {
  if (!response.ok || typeof response.data !== "object" || response.data === null || !("phaseRuns" in response.data)) return []
  const phaseRuns = response.data.phaseRuns
  if (!Array.isArray(phaseRuns)) return []
  return phaseRuns.flatMap((run) => typeof run === "object" && run !== null && "status" in run && typeof run.status === "string" ? [run.status] : [])
}
