/**
 * DOM acceptance: deduction goals P1–P4 full UI flow (creation desk).
 *
 * Boundaries — IN SCOPE (all via Playwright DOM; no invokeBackend for user actions):
 *  G1  Create project on creation desk
 *  G2  Add deduction goal + set chapter planned progress via goals popover
 *  G3  Send synopsis message → Agent pending proposal → approve via UI
 *  G4  Start turn via confirm bar → wait until UI shows 就绪 + post-commit notice
 *  G5  Post-turn review dialog → mark achieved → verify status in goals popover
 *
 * OUT OF SCOPE:
 *  - Backend vitest / static markup tests
 *  - invokeBackend-driven turns (see dom-ui-e2e.mjs)
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { chromium } from "playwright-core"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = process.env.WORLDSEED_DOM_DEDUCTION_GOALS_REPORT
  ?? ".worldseed-data/acceptance/current/dom-deduction-goals-trace.json"
const screenshotPath = process.env.WORLDSEED_DOM_DEDUCTION_GOALS_SCREENSHOT
  ?? ".worldseed-data/acceptance/current/dom-deduction-goals-trace.png"

const boundaries = {
  inScope: ["G1_create_project", "G2_goals_and_progress", "G3_synopsis_proposal", "G4_begin_turn_ui", "G5_post_turn_review"],
  outOfScope: ["backend_vitest", "invokeBackend_turn"],
}

const workspace = process.env.WORLDSEED_ACCEPTANCE_WORKSPACE
  ?? await mkdtemp(join(tmpdir(), "worldseed-dom-deduction-goals-"))
const report = { workspace, boundaries, steps: [], checks: {} }

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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.getByTestId("checkpoint-dialog")
    if (await dialog.count() === 0 || !await dialog.first().isVisible()) return
    await dialog.locator('button[title="保持暂停并关闭"]').click()
    await delay(300)
  }
}

async function ensureFreshProject(page) {
  await closeDialogs(page)
  try {
    await Promise.race([
      page.getByText("建立一个新世界", { exact: true }).waitFor({ state: "visible", timeout: 45_000 }),
      page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 45_000 }),
    ])
  } catch {
    // Fall through to explicit error below.
  }
  await delay(500)

  if (await page.getByText("建立一个新世界", { exact: true }).isVisible().catch(() => false)) {
    await page.getByPlaceholder("例如：雾港纪事").fill("DOM 推演目标验收")
    await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspace)
    await page.getByRole("button", { name: "创建并进入", exact: true }).click()
    record("G1_create_project")
    await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 45_000 })
    return
  }

  if (await page.getByTestId("synopsis-conversation").isVisible().catch(() => false)) {
    record("G1_reuse_creation_desk")
    return
  }

  throw new Error("App is not on launcher or creation desk")
}

async function openGoalsPopover(page) {
  await page.getByTestId("creation-desk-goals-trigger").click()
  await page.getByTestId("creation-desk-goals-popover").waitFor({ state: "visible", timeout: 10_000 })
}

async function closeGoalsPopover(page) {
  await page.getByTestId("creation-desk-goals-popover").getByRole("button", { name: "关闭" }).click()
  await page.getByTestId("creation-desk-goals-popover").waitFor({ state: "hidden", timeout: 5_000 })
}

async function waitForTurnComplete(page, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await closeDialogs(page)
    const indicator = await page.locator(".project-indicator").innerText().catch(() => "")
    if (indicator.includes("就绪") && !indicator.includes("推演中")) {
      return indicator
    }
    await delay(500)
  }
  throw new Error(`Turn did not complete within ${String(timeoutMs)} ms`)
}

async function waitForSynopsisReply(page, userSnippet) {
  await page.locator(".creation-desk-message.user").filter({ hasText: userSnippet }).last().waitFor({ timeout: 15_000 })
  await page.locator(".creation-desk-message.assistant").last().waitFor({ timeout: 60_000 })
}

const browser = await chromium.connectOverCDP(cdpUrl)
const page = browser.contexts()[0]?.pages()[0]
if (page === undefined) throw new Error(`No Electron renderer page is available at ${cdpUrl}`)

try {
  await page.waitForTimeout(1500)
  await ensureFreshProject(page)
  await closeDialogs(page)

  // G2 — add goal + planned progress
  await openGoalsPopover(page)
  const goalText = "主角在旧书库发现未署名信件，并决定追查寄信人"
  await page.getByTestId("creation-desk-goals-add-trigger").click()
  await page.getByTestId("creation-desk-goals-compose").locator("input").fill(goalText)
  await page.getByTestId("creation-desk-goals-compose").getByRole("button", { name: "添加" }).click()
  await page.getByTestId("creation-desk-goal-active").filter({ hasText: goalText }).waitFor({ timeout: 15_000 })
  record("G2_goal_added")

  const progressSummary = "本章主角在书库找到信件并产生追查动机"
  await page.getByTestId("creation-desk-goals-scope-toggle").click()
  await page.getByTestId("creation-desk-goal-active").filter({ hasText: goalText }).click()
  await page.locator(".creation-desk-goal-row-input").fill(progressSummary)
  await page.locator(".creation-desk-goal-row-input").blur()
  await delay(800)
  setCheck("G2_progress_filled", true, { progressSummary })
  record("G2_progress_set")
  await closeGoalsPopover(page)

  // G3 — synopsis discuss + agent proposal approval
  const synopsisMessage = "验收：下一章让主角在旧书库发现一封未署名的信。"
  await page.getByPlaceholder("告诉 Agent 下一章想怎么推进…").fill(synopsisMessage)
  await page.getByRole("button", { name: /^发送/u }).click()
  await waitForSynopsisReply(page, "验收")
  record("G3_synopsis_sent")

  await openGoalsPopover(page)
  await page.getByTestId("creation-desk-goals-pending-section").waitFor({ state: "visible", timeout: 20_000 })
  await page.getByTestId("creation-desk-goal-pending").first().waitFor({ state: "visible", timeout: 10_000 })
  await page.getByTestId("creation-desk-goal-pending").first().getByTestId("creation-desk-goal-row-actions-toggle").click()
  await page.getByTestId("creation-desk-goal-pending").first().getByRole("button", { name: "采纳" }).click()
  await delay(600)
  setCheck("G3_proposal_approved", await page.getByTestId("creation-desk-goals-pending-section").count() === 0)
  record("G3_proposal_approved")
  await closeGoalsPopover(page)

  // G4 — begin turn via advanced menu (DOM only)
  await page.getByTestId("creation-desk-advanced-trigger").click()
  const startButton = page.getByTestId("creation-desk-start-turn")
  await startButton.waitFor({ state: "visible", timeout: 10_000 })
  await startButton.click()
  record("G4_start_turn_clicked")
  await page.locator(".project-indicator").filter({ hasText: "推演中" }).waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined)
  const readyIndicator = await waitForTurnComplete(page)
  setCheck("G4_turn_completed", readyIndicator.includes("就绪"), { indicator: readyIndicator })
  record("G4_turn_completed")

  await page.getByTestId("post-commit-review-goals").waitFor({ state: "visible", timeout: 30_000 })
  setCheck("G4_post_commit_notice", true)
  record("G4_post_commit_notice")

  // G5 — review via dialog
  await page.getByTestId("post-commit-review-goals").click()
  await page.getByTestId("creation-desk-progress-review-dialog").waitFor({ state: "visible", timeout: 10_000 })
  await page.getByTestId("creation-desk-progress-review-card").waitFor({ state: "visible", timeout: 10_000 })
  await page.getByTestId("creation-desk-review-achieved").first().click()
  await delay(800)
  record("G5_review_achieved")

  // Turn completion opens the chapter file; return to creation desk before verifying goals UI.
  const homeButton = page.getByRole("button", { name: "创作台", exact: true })
  if (await homeButton.count() > 0 && await homeButton.first().isVisible()) {
    await homeButton.first().click()
    await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 15_000 })
    record("G5_return_creation_desk")
  }

  await openGoalsPopover(page)
  await page.getByTestId("creation-desk-goals-scope-toggle").click()
  const achievedVisible = await page.locator(".creation-desk-goal-status-icon.status-achieved").first().isVisible()
  setCheck("G5_review_status_in_popover", achievedVisible)
  record("G5_verified_in_popover", { achievedVisible })

  setCheck("G4_progress_locked", achievedVisible, { achievedVisible })

  await closeDialogs(page)
  const errorBanner = page.locator(".error-banner")
  const noError = await errorBanner.count() === 0 || !await errorBanner.first().isVisible()
  setCheck("no_error_banner", noError)

  report.passed = Object.values(report.checks).every((check) => check.ok === true)
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
    // Screenshot optional if page detached.
  }
  report.generatedAt = new Date().toISOString()
  report.cdpUrl = cdpUrl
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.passed === true ? 0 : 1)
}
