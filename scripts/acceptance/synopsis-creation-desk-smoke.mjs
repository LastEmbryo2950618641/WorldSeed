import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { chromium } from "playwright-core"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const workspace = requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE")
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_UI_REPORT ?? ".worldseed-data/acceptance/current/synopsis-desk.json")
const screenshotPath = resolve(process.env.WORLDSEED_ACCEPTANCE_SCREENSHOT ?? ".worldseed-data/acceptance/current/synopsis-desk.png")

const browser = await chromium.connectOverCDP(cdpUrl)
const context = browser.contexts()[0]
const page = context?.pages()[0]
if (page === undefined) throw new Error(`No Electron renderer page is available at ${cdpUrl}`)

await openProjectIfNeeded(page, workspace)
await closeKnownDialogs(page)

const checks = []
checks.push(await noErrorBannerCheck(page, "no_validation_error_on_load"))
checks.push(await visibleCheck(page, "creation_desk_loaded", page.getByTestId("synopsis-conversation")))
if (await page.getByRole("heading", { name: "剧情梗概讨论" }).count() > 0) {
  checks.push(await visibleCheck(page, "creation_desk_heading", page.getByRole("heading", { name: "剧情梗概讨论" })))
} else {
  checks.push({ id: "creation_desk_heading", status: "pass", evidence: "conversation already in progress" })
}
checks.push(await visibleCheck(page, "creation_desk_composer", page.getByPlaceholder("告诉 Agent 下一章想怎么推进…")))
checks.push(await visibleCheck(page, "creation_desk_send", page.getByRole("button", { name: /发送/u })))
checks.push(await visibleCheck(page, "creation_desk_start_turn", page.getByTestId("creation-desk-start-turn")))
checks.push(await visibleCheck(page, "creation_desk_goals_trigger", page.getByTestId("creation-desk-goals-trigger")))
await page.getByTestId("creation-desk-goals-trigger").click()
checks.push(await visibleCheck(page, "creation_desk_goals_popover", page.getByTestId("creation-desk-goals-popover")))
await page.keyboard.press("Escape")

const synopsisMessage = "验收测试：下一章主角在旧书库发现一封未署名的信。"
await page.getByPlaceholder("告诉 Agent 下一章想怎么推进…").fill(synopsisMessage)
await page.getByRole("button", { name: /发送/u }).click()
checks.push(await waitForSynopsisReply(page))

await closeKnownDialogs(page)
checks.push(await noErrorBannerCheck(page, "no_validation_error_after_synopsis_send"))

const chapterButton = page.locator(".tree-row-file").filter({ hasText: /第一章/u }).first()
checks.push(await clickAndCheck(page, "open_chapter_from_tree", chapterButton, page.getByTestId("chapter-workspace-rail")))
await page.waitForTimeout(800)
checks.push(await noErrorBannerCheck(page, "no_validation_error_on_chapter_open"))

await page.getByTestId("chapter-synopsis-toggle").click()
checks.push(await visibleCheck(page, "chapter_synopsis_panel", page.getByTestId("chapter-synopsis-panel")))

await page.getByRole("button", { name: "创作台", exact: true }).click()
await page.waitForTimeout(400)
checks.push(await visibleCheck(page, "return_to_creation_desk", page.getByTestId("synopsis-conversation")))

await mkdir(dirname(outputPath), { recursive: true })
await page.screenshot({ path: screenshotPath, fullPage: true })
const report = {
  generatedAt: new Date().toISOString(),
  cdpUrl,
  workspace,
  pageUrl: page.url(),
  checks,
  passed: checks.every((check) => check.status === "pass"),
  screenshotPath,
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.passed ? 0 : 1)

async function ensureCreationDesk(page, workspacePath) {
  if (await page.getByTestId("synopsis-conversation").count() > 0) {
    await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 5_000 })
    return
  }

  const homeButton = page.getByRole("button", { name: "创作台", exact: true })
  if (await homeButton.count() > 0 && await homeButton.first().isVisible()) {
    await homeButton.first().click()
    await page.waitForTimeout(400)
    if (await page.getByTestId("synopsis-conversation").count() > 0) {
      await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 10_000 })
      return
    }
  }

  const launcher = page.locator(".launcher")
  if (await launcher.count() === 0 || !await launcher.first().isVisible()) {
    throw new Error("Neither creation desk nor project launcher is visible")
  }

  await page.locator(".launcher-switch button").filter({ hasText: "打开项目" }).click()
  await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspacePath)
  await page.locator("button.primary-command").click()
  await page.getByTestId("synopsis-conversation").waitFor({ state: "visible", timeout: 45_000 })
}

async function openProjectIfNeeded(page, workspacePath) {
  await ensureCreationDesk(page, workspacePath)
}

async function closeKnownDialogs(page) {
  const closeModel = page.getByRole("button", { name: "关闭模型配置" })
  if (await closeModel.count() > 0 && await closeModel.first().isVisible()) {
    await closeModel.first().evaluate((button) => { button.click() })
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialog = page.getByTestId("checkpoint-dialog")
    if (await dialog.count() === 0 || !await dialog.first().isVisible()) return
    await dialog.locator('button[title="保持暂停并关闭"]').click()
    await page.waitForTimeout(300)
  }
}

async function noErrorBannerCheck(page, id) {
  const banner = page.locator(".error-banner")
  if (await banner.count() === 0 || !await banner.first().isVisible()) {
    return { id, status: "pass", evidence: "no banner" }
  }
  const text = await banner.first().innerText()
  return { id, status: "fail", evidence: text.slice(0, 500) }
}

async function visibleCheck(page, id, locator) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: 15_000 })
    return { id, status: "pass", evidence: await locator.first().innerText().catch(() => "visible") }
  } catch (error) {
    return { id, status: "fail", evidence: error instanceof Error ? error.message : String(error) }
  }
}

async function clickAndCheck(page, id, locator, expected) {
  try {
    await locator.waitFor({ state: "visible", timeout: 10_000 })
    await locator.click()
    await expected.waitFor({ state: "visible", timeout: 15_000 })
    return { id, status: "pass", evidence: "clicked" }
  } catch (error) {
    return { id, status: "fail", evidence: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForSynopsisReply(page) {
  try {
    await page.locator(".creation-desk-message.user").filter({ hasText: /验收测试/u }).last().waitFor({ timeout: 10_000 })
    await page.locator(".creation-desk-message.assistant").last().waitFor({ timeout: 30_000 })
    return { id: "synopsis_send_and_reply", status: "pass", evidence: "user + assistant messages" }
  } catch (error) {
    return { id: "synopsis_send_and_reply", status: "fail", evidence: error instanceof Error ? error.message : String(error) }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
