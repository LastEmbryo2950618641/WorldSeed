/**
 * DOM smoke: send one Agent revision message and verify draft version + diff UI.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { chromium } from "playwright-core"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const workspaceRootRef = process.env.WORLDSEED_TEST_WORKSPACE ?? "C:\\Users\\liuqi\\Documents\\NBook\\TestDev"
const outputPath = process.env.WORLDSEED_DOM_DRAFT_DIFF_REPORT
  ?? ".worldseed-data/acceptance/current/dom-draft-version-diff.json"

const report = { workspaceRootRef, steps: [], checks: {} }

function record(id, data = {}) {
  const entry = { id, ...data }
  report.steps.push(entry)
  console.log(JSON.stringify(entry))
}

async function invokeBackend(page, method, payload) {
  return page.evaluate(async ({ requestMethod, requestPayload }) => {
    const response = await window.worldseed.invoke({
      protocolVersion: "worldseed.v1",
      requestId: crypto.randomUUID(),
      method: requestMethod,
      payload: requestPayload,
    })
    if (!response.ok) throw new Error(response.error.message)
    return response.data
  }, { requestMethod: method, requestPayload: payload })
}

async function ensureTestDevProject(page) {
  const onLauncher = await page.getByTestId("launcher-open-project").isVisible().catch(() => false)
  if (onLauncher) {
    await page.evaluate((dir) => { window.sessionStorage.setItem("worldseed:e2e-workspace", dir) }, workspaceRootRef)
    await page.getByTestId("launcher-open-project").click()
    await page.evaluate(() => { window.sessionStorage.removeItem("worldseed:e2e-workspace") })
    record("launcher_open_project")
    await page.getByText("创作台首页", { exact: true }).waitFor({ timeout: 30_000 })
  }
  const statusPath = (await page.locator(".status-path").innerText().catch(() => "")).trim()
  if (!statusPath.includes("TestDev") && !statusPath.includes("章节正文")) {
    await invokeBackend(page, "project.open", { workspaceRootRef })
    record("backend_reopen_project")
    await delay(1000)
  }
}

const browser = await chromium.connectOverCDP(cdpUrl)
const page = browser.contexts()[0]?.pages()[0]
if (page === undefined) throw new Error(`No renderer page at ${cdpUrl}`)

try {
  record("connect", { cdpUrl })
  await delay(800)

  await ensureTestDevProject(page)
  await delay(800)

  await page.getByTitle("刷新").click()
  await delay(700)

  const chapterLabel = "第一章 醒来时"
  await page.locator(".workspace-tree").getByText(chapterLabel, { exact: false }).first().click()
  record("chapter_clicked", { chapterLabel })
  await page.locator('[data-testid="chapter-conversation"]').waitFor({ timeout: 30_000 })
  await page.locator('[data-testid="chapter-document-draft"]').click()
  await delay(500)

  const versionSelect = page.locator('[data-testid="chapter-draft-version-select"]')
  await versionSelect.waitFor({ timeout: 15_000 })
  const optionsBefore = await versionSelect.locator("option").count()
  const labelsBefore = await versionSelect.locator("option").allTextContents()
  record("versions_before", { count: optionsBefore, labels: labelsBefore })

  const userMessage = "在正文开头增加约200字的悬疑氛围描写，其余段落尽量保持不变。"
  await page.locator(".chapter-conversation textarea").fill(userMessage)
  record("message_filled", { userMessage })
  await page.locator(".chapter-conversation .run-command").click()
  record("message_sent")

  await page.locator(".chapter-conversation-message.assistant").last().waitFor({ timeout: 30_000 })
  await delay(1500)

  const optionsAfter = await versionSelect.locator("option").count()
  const labelsAfter = await versionSelect.locator("option").allTextContents()
  const diffVisible = await page.locator('[data-testid="chapter-draft-diff-view"]').isVisible().catch(() => false)
  const diffBaseVisible = await page.locator('[data-testid="chapter-draft-diff-base"]').isVisible().catch(() => false)
  const diffHeadVisible = await page.locator('[data-testid="chapter-draft-diff-head"]').isVisible().catch(() => false)
  const diffStats = await page.locator(".chapter-draft-diff-stats").innerText().catch(() => "")
  const draftChars = await page.locator('[data-testid="chapter-document-draft"] small').innerText().catch(() => "0")

  report.checks.new_version = { ok: optionsAfter > optionsBefore, optionsBefore, optionsAfter, labelsAfter }
  report.checks.diff_view = { ok: diffVisible, diffBaseVisible, diffHeadVisible, diffStats }
  record("result", report.checks)

  await page.screenshot({
    path: ".worldseed-data/acceptance/current/dom-draft-version-diff.png",
    fullPage: true,
    timeout: 120_000,
  })
  record("screenshot_saved")

  report.status = report.checks.new_version.ok && report.checks.diff_view.ok ? "pass" : "partial"
  report.completedAt = new Date().toISOString()
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log("REPORT", join(process.cwd(), outputPath))
  console.log("DONE — Electron 窗口应仍显示对比视图，请直接查看。")
} finally {
  await browser.close()
}

process.exit(report.checks.new_version?.ok && report.checks.diff_view?.ok ? 0 : 1)
