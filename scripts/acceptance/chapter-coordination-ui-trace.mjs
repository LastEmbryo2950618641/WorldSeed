import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { chromium } from "playwright-core"

import { connectElectron, invokeBackend, runTurn } from "./lib/electron-backend.mjs"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = resolve(process.env.WORLDSEED_CHAPTER_TRACE_REPORT
  ?? ".worldseed-data/acceptance/current/chapter-coordination-ui-trace.json")
const logPath = resolve(process.env.WORLDSEED_LOG_FILE
  ?? ".worldseed-data/acceptance/current/worldseed.log")

const workspace = await mkdtemp(join(tmpdir(), "worldseed-chapter-ui-trace-"))
const report = {
  startedAt: new Date().toISOString(),
  workspace,
  cdpUrl,
  logPath,
  scenarios: [],
}

try {
  const { browser, page } = await connectElectron(cdpUrl)
  await page.getByText("创作台首页", { exact: true }).waitFor({ timeout: 30_000 })

  const created = await invokeBackend(page, "project.create", {
    projectId: randomUUID(),
    displayName: "章节协调 UI 追踪",
    workspaceRootRef: workspace,
  })
  report.projectId = created.projectId

  const turnOne = await runScenario(page, {
    id: "turn_chapter_one",
    prompt: "雨夜里，旧站台尽头亮起一盏无人认领的灯，旅人第一次靠近它。",
    chapterSequence: 1,
    projectId: created.projectId,
    workspaceRootRef: workspace,
  })
  report.scenarios.push(turnOne)

  const chaptersAfterOne = await invokeBackend(page, "chapter.list", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
  })
  const chapterOne = chaptersAfterOne[0]
  if (chapterOne === undefined) throw new Error("chapter.list returned no chapters after turn 1")

  const resolvedBeforeRevision = await invokeBackend(page, "chapter.resolve", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    chapterId: chapterOne.chapterId,
  })
  report.scenarios.push({
    id: "resolve_before_revision",
    suggestedUiMode: resolvedBeforeRevision.suggestedUiMode,
    sequence: resolvedBeforeRevision.index.sequence,
    graphSyncBlocking: resolvedBeforeRevision.graphSyncBlocking,
    staleMarkerCount: resolvedBeforeRevision.lineage.staleMarkers.length,
  })

  await page.getByRole("button", { name: "创作台", exact: false }).click()
  const composerVisibleOnHome = await page.locator("textarea").count()
  await page.getByText(chapterOne.publishPath.split("/").at(-1) ?? "", { exact: false }).click().catch(async () => {
    await invokeBackend(page, "chapter.resolveByPath", {
      projectId: created.projectId,
      workspaceRootRef: workspace,
      publishPath: chapterOne.publishPath,
    })
    await page.evaluate((path) => {
      window.dispatchEvent(new CustomEvent("worldseed-open-file", { detail: path }))
    }, chapterOne.publishPath)
  })
  await delay(500)
  const composerVisibleOnChapter = await page.locator("textarea").count()
  report.scenarios.push({
    id: "ui_turn_composer_visibility",
    composerOnHome: composerVisibleOnHome > 0,
    composerOnChapter: composerVisibleOnChapter > 0,
    pass: composerVisibleOnHome > 0 && composerVisibleOnChapter === 0,
  })

  const original = await invokeBackend(page, "chapter.read", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    chapterId: chapterOne.chapterId,
  })
  const revision = await invokeBackend(page, "chapter.startRevision", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    chapterId: chapterOne.chapterId,
    baseSourceId: chapterOne.sourceId,
    heading: chapterOne.heading,
    body: `${original.body.trim()}\n\n修订痕迹：灯芯换成了蓝色。`,
  })
  await invokeBackend(page, "chapter.updateRevision", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    revisionTaskId: revision.revisionTaskId,
    heading: "第一章 蓝灯初现",
    body: `${original.body.trim()}\n\n修订痕迹：灯芯换成了蓝色。`,
  })
  const submitted = await invokeBackend(page, "chapter.submitRevision", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    revisionTaskId: revision.revisionTaskId,
    mode: "direct",
    forced: true,
  })
  report.scenarios.push({
    id: "revision_submit",
    graphSyncStatus: submitted.graphSyncStatus,
    status: submitted.status,
  })

  let blockedTurn
  try {
    await invokeBackend(page, "turn.start", {
      projectId: created.projectId,
      workspaceRootRef: workspace,
      userInput: "图同步未完成时，不应允许继续推演。",
      chapterSequence: 99,
    })
    blockedTurn = { blocked: false }
  } catch (error) {
    blockedTurn = {
      blocked: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  report.scenarios.push({ id: "turn_blocked_during_graph_sync", ...blockedTurn })

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await invokeBackend(page, "chapter.readRevision", {
      projectId: created.projectId,
      workspaceRootRef: workspace,
      revisionTaskId: revision.revisionTaskId,
    })
    if (current.graphSyncStatus === "completed") break
    await delay(500)
  }

  const turnTwo = await runScenario(page, {
    id: "turn_chapter_two",
    prompt: "第二夜，蓝灯照见了站台尽头被封存的旧信箱。",
    chapterSequence: 2,
    projectId: created.projectId,
    workspaceRootRef: workspace,
  })
  report.scenarios.push(turnTwo)

  const resolvedAfter = await invokeBackend(page, "chapter.resolve", {
    projectId: created.projectId,
    workspaceRootRef: workspace,
    chapterId: chapterOne.chapterId,
  })
  report.scenarios.push({
    id: "resolve_after_revision",
    bodyContainsRevisionMarker: resolvedAfter.committed.body.includes("修订痕迹：灯芯换成了蓝色。"),
    staleMarkerCount: resolvedAfter.lineage.staleMarkers.length,
    suggestedUiMode: resolvedAfter.suggestedUiMode,
  })

  const logEvents = await readTraceEvents(logPath)
  report.traceEvents = {
    superseded: logEvents.filter((line) => line.includes("narrative.superseded")),
    resolve: logEvents.filter((line) => line.includes("chapter-resolve") && line.includes("resolved")),
    turnBlocked: logEvents.filter((line) => line.includes("turn.blocked.graph_sync")),
    sequenceAssigned: logEvents.filter((line) => line.includes("turn.sequence.assigned")),
  }
  report.status = report.scenarios.every((scenario) => scenario.pass !== false) ? "pass" : "fail"
  report.completedAt = new Date().toISOString()
  await mkdir(resolve(outputPath, ".."), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
  await rm(workspace, { recursive: true, force: true })
  process.exit(report.status === "pass" ? 0 : 1)
} catch (error) {
  report.completedAt = new Date().toISOString()
  report.status = "fail"
  report.error = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
  await mkdir(resolve(outputPath, ".."), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(1)
}

async function runScenario(page, input) {
  const before = await invokeBackend(page, "chapter.list", {
    projectId: input.projectId,
    workspaceRootRef: input.workspaceRootRef,
  })
  const handle = await invokeBackend(page, "turn.start", {
    projectId: input.projectId,
    workspaceRootRef: input.workspaceRootRef,
    userInput: input.prompt,
    chapterSequence: input.chapterSequence,
  })
  const snapshot = await waitForTask(page, handle.taskId)
  const after = await invokeBackend(page, "chapter.list", {
    projectId: input.projectId,
    workspaceRootRef: input.workspaceRootRef,
  })
  return {
    id: input.id,
    prompt: input.prompt,
    taskId: handle.taskId,
    status: snapshot.status,
    chapterCountBefore: before.length,
    chapterCountAfter: after.length,
    pass: snapshot.status === "completed" && after.length === before.length + 1,
  }
}

async function waitForTask(page, taskId) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const snapshot = await invokeBackend(page, "turn.status", { taskId })
    if (snapshot.status === "completed") return snapshot
    if (["failed", "cancelled"].includes(snapshot.status)) {
      throw new Error(`Task ${taskId} ended with ${snapshot.status}`)
    }
    await delay(1_000)
  }
  throw new Error(`Task ${taskId} timed out`)
}

async function readTraceEvents(path) {
  try {
    const content = await readFile(path, "utf8")
    return content.split("\n").filter((line) => line.includes("[Worldseed]"))
  } catch {
    return []
  }
}
