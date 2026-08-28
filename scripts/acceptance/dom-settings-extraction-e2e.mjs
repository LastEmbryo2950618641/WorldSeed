/**
 * DOM acceptance: settings extraction review checkpoint (S1–S5).
 *
 * IN SCOPE (Playwright DOM on checkpoint UI):
 *  S1  Create project and start turn (backend invoke only to reach checkpoint)
 *  S2  Checkpoint auto-opens with settings extraction title
 *  S3  Approve settings proposal via DOM
 *  S4  Continue graph governance via DOM
 *  S5  Turn completes and settings file exists in workspace
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { connectElectron, invokeBackend } from "./lib/electron-backend.mjs"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = process.env.WORLDSEED_DOM_SETTINGS_EXTRACTION_REPORT
  ?? ".worldseed-data/acceptance/current/dom-settings-extraction-trace.json"
const screenshotPath = process.env.WORLDSEED_DOM_SETTINGS_EXTRACTION_SCREENSHOT
  ?? ".worldseed-data/acceptance/current/dom-settings-extraction-trace.png"

const workspace = process.env.WORLDSEED_ACCEPTANCE_WORKSPACE
  ?? await mkdtemp(join(tmpdir(), "worldseed-dom-settings-extraction-"))
let workspaceRootRef = workspace
const report = { workspace: workspaceRootRef, steps: [], checks: {} }

function record(id, data = {}) {
  const entry = { id, ...data }
  report.steps.push(entry)
  console.log(JSON.stringify(entry))
}

function setCheck(id, ok, detail = {}) {
  report.checks[id] = { ok, ...detail }
}

async function closeDialogs(page) {
  const closeModel = page.getByRole("button", { name: "关闭模型配置" })
  if (await closeModel.count() > 0 && await closeModel.first().isVisible()) {
    await closeModel.first().click()
  }
}

async function ensureProject(page) {
  await closeDialogs(page)
  workspaceRootRef = process.env.WORLDSEED_ACCEPTANCE_WORKSPACE ?? workspaceRootRef
  report.workspace = workspaceRootRef
  const projectId = randomUUID()
  await invokeBackend(page, "project.create", {
    projectId,
    displayName: "DOM 设定抽取验收",
    workspaceRootRef,
  })
  record("S1_create_project", { projectId, workspaceRootRef })
}

async function waitForTaskStatus(page, taskId, status, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = "unknown"
  while (Date.now() < deadline) {
    const snapshot = await invokeBackend(page, "turn.status", { taskId })
    lastStatus = snapshot.status
    if (snapshot.status === status) return snapshot
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new Error(`Task ended with ${snapshot.status}: ${snapshot.interruption?.message ?? snapshot.error?.message ?? "unknown"}`)
    }
    if (snapshot.status === "completed" && status !== "completed") {
      throw new Error(`Task completed before reaching ${status}; interruption=${JSON.stringify(snapshot.interruption ?? null)}`)
    }
    await delay(500)
  }
  throw new Error(`Task ${taskId} did not reach ${status} within ${String(timeoutMs)} ms (last=${lastStatus})`)
}

const { page } = await connectElectron(cdpUrl)

try {
  await page.waitForTimeout(1500)
  await ensureProject(page)
  await closeDialogs(page)

  const opened = await invokeBackend(page, "project.open", { workspaceRootRef })
  const projectId = opened.projectId
  record("S1_project_opened", { projectId })

  const handle = await invokeBackend(page, "turn.start", {
    projectId,
    workspaceRootRef,
    userInput: "雨夜里，旧站台尽头亮起一盏无人认领的灯，持灯者第一次被人看清面目。",
    chapterSequence: 1,
    maxModelCalls: 64,
    deadlineMs: 600_000,
  })
  record("S1_turn_started", { taskId: handle.taskId })

  const paused = await waitForTaskStatus(page, handle.taskId, "waiting_for_review")
  setCheck("S2_waiting_for_review", paused.status === "waiting_for_review", {
    lastPhase: paused.lastPhase,
    interruptionKind: paused.interruption?.kind,
  })
  record("S2_task_paused", { lastPhase: paused.lastPhase })

  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "打开项目" }).first().click()
  await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspaceRootRef)
  await page.getByRole("button", { name: "打开项目" }).last().click()
  record("S2_reopen_project_ui")

  const dialog = page.getByTestId("checkpoint-dialog")
  await dialog.waitFor({ state: "visible", timeout: 45_000 })
  setCheck("S2_checkpoint_visible", await dialog.isVisible())
  setCheck("S2_checkpoint_title", (await dialog.innerText()).includes("设定抽取待确认"))
  record("S2_checkpoint_open")

  await page.getByTestId("checkpoint-settings-review").waitFor({ state: "visible", timeout: 15_000 })
  await page.getByTestId("checkpoint-settings-proposal").waitFor({ state: "visible", timeout: 15_000 })
  setCheck("S3_proposal_visible", true)
  record("S3_proposal_visible")

  const continueButton = page.getByTestId("checkpoint-continue")
  setCheck("S3_continue_disabled_before_approve", await continueButton.isDisabled())

  await page.getByTestId("checkpoint-settings-approve").click()
  await delay(1500)
  setCheck("S3_continue_enabled_after_approve", !(await continueButton.isDisabled()))
  record("S3_proposal_approved")

  // Disk write must succeed and create nested folders.
  const settingsPath = join(workspaceRootRef, "设定集", "人物", "验收旅人.md")
  const settingsMarkdown = await readFile(settingsPath, "utf8")
  setCheck("S5_settings_written", settingsMarkdown.includes("# 验收旅人"))
  record("S5_settings_file", { path: "设定集/人物/验收旅人.md" })

  // Workspace inventory must include nested folder + file after approve.
  const listed = await invokeBackend(page, "workspace.list", { workspaceRootRef })
  const inventoryPaths = (listed.inventory ?? []).map((entry) => entry.path)
  setCheck("S5_inventory_has_dir", inventoryPaths.includes("设定集/人物"))
  setCheck("S5_inventory_has_file", inventoryPaths.includes("设定集/人物/验收旅人.md"))
  record("S5_inventory", {
    hasDir: inventoryPaths.includes("设定集/人物"),
    hasFile: inventoryPaths.includes("设定集/人物/验收旅人.md"),
  })

  // Left workspace tree must refresh without manual click (state update behind dialog).
  const treeText = await page.locator(".workspace-tree").innerText()
  setCheck("S5_tree_has_dir", treeText.includes("人物"))
  setCheck("S5_tree_has_file", treeText.includes("验收旅人"))
  record("S5_tree_refresh", {
    dirVisible: treeText.includes("人物"),
    fileVisible: treeText.includes("验收旅人"),
    treeSnippet: treeText.slice(0, 400),
  })

  await continueButton.click()
  record("S4_continue_clicked")

  let completed = await waitForTaskStatus(page, handle.taskId, "completed", 60_000).catch(() => undefined)
  if (completed === undefined) {
    await invokeBackend(page, "turn.resume", {
      taskId: handle.taskId,
      mode: "continue",
      resetMetricIds: [],
      maxModelCalls: 64,
      deadlineMs: 600_000,
    }).catch(() => undefined)
    completed = await waitForTaskStatus(page, handle.taskId, "completed", 120_000).catch(() => undefined)
  }
  setCheck("S4_turn_completed", completed?.status === "completed", {
    lastStatus: completed?.status ?? "unknown",
  })
  if (completed?.status === "completed") record("S4_turn_completed")

  setCheck("S5_chapter_written", (await readFile(join(workspaceRootRef, "章节正文", "第一章 世界种子.md"), "utf8").catch(() => "")).length > 0)

  const errorBanner = page.locator(".error-banner")
  setCheck("no_error_banner", await errorBanner.count() === 0 || !await errorBanner.first().isVisible())

  const requiredChecks = [
    "S2_waiting_for_review",
    "S2_checkpoint_visible",
    "S2_checkpoint_title",
    "S3_proposal_visible",
    "S3_continue_disabled_before_approve",
    "S3_continue_enabled_after_approve",
    "S5_settings_written",
    "S5_inventory_has_dir",
    "S5_inventory_has_file",
    "S5_tree_has_dir",
    "S5_tree_has_file",
    "no_error_banner",
  ]
  report.passed = requiredChecks.every((id) => report.checks[id]?.ok === true)
} catch (cause) {
  report.passed = false
  report.error = cause instanceof Error ? cause.message : String(cause)
  console.error(report.error)
} finally {
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true })
    report.screenshotPath = screenshotPath
  } catch {
    // optional
  }
  report.generatedAt = new Date().toISOString()
  report.cdpUrl = cdpUrl
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.passed === true ? 0 : 1)
}
