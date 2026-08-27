import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { chromium } from "playwright-core"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const workspace = requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE")
const expectedGraph = process.env.WORLDSEED_ACCEPTANCE_GRAPH
const expectedContextWindow = process.env.WORLDSEED_ACCEPTANCE_CONTEXT_WINDOW ?? "1000000"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_UI_REPORT ?? ".worldseed-data/acceptance/current/ui.json")
const screenshotPath = resolve(process.env.WORLDSEED_ACCEPTANCE_SCREENSHOT ?? ".worldseed-data/acceptance/current/ui.png")

const browser = await chromium.connectOverCDP(cdpUrl)
const context = browser.contexts()[0]
const page = context?.pages()[0]
if (page === undefined) throw new Error(`No Electron renderer page is available at ${cdpUrl}`)

await openProjectIfNeeded(page, workspace)
await page.getByTestId("synopsis-conversation").waitFor({ timeout: 20_000 })
await closeKnownDialogs(page)

const checks = []
checks.push(await visibleCheck(page, "creation_desk_loaded", page.getByTestId("synopsis-conversation")))
checks.push(await visibleCheck(page, "creation_desk_heading", page.getByRole("heading", { name: "剧情梗概讨论" })))
checks.push(await graphCheck(page, expectedGraph))

await closeKnownDialogs(page)
await page.getByRole("button", { name: "历史", exact: true }).click()
checks.push(await visibleCheck(page, "history_loaded", page.getByText("推演历史", { exact: true })))

await page.getByTestId("model-config-trigger").click()
await page.getByTestId("model-configuration-dialog").waitFor({ timeout: 10_000 })
const contextWindowValue = await page.locator('input[type="number"]').last().inputValue()
checks.push({
  id: "model_context_window_persisted",
  status: contextWindowValue === expectedContextWindow ? "pass" : "fail",
  evidence: { expected: expectedContextWindow, actual: contextWindowValue },
})
await page.getByRole("button", { name: "关闭模型配置" }).evaluate((button) => { button.click() })

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

async function openProjectIfNeeded(page, workspacePath) {
  if (await page.getByTestId("synopsis-conversation").count() > 0) return
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click()
  await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspacePath)
  await page.getByRole("button", { name: "打开项目", exact: true }).last().click()
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
  await page.getByTestId("checkpoint-dialog").waitFor({ state: "hidden", timeout: 5_000 })
}

async function visibleCheck(page, id, locator) {
  try {
    await locator.waitFor({ state: "visible", timeout: 10_000 })
    return { id, status: "pass", evidence: await locator.first().innerText() }
  } catch (error) {
    return { id, status: "fail", evidence: error instanceof Error ? error.message : String(error) }
  }
}

async function graphCheck(page, expected) {
  try {
    const locator = expected === undefined
      ? page.locator(".world-summary strong").filter({ hasText: /^\d+ 节点 \/ \d+ 连接$/u })
      : page.getByText(expected, { exact: true })
    await locator.waitFor({ state: "visible", timeout: 10_000 })
    return { id: "graph_restored", status: "pass", evidence: await locator.first().innerText() }
  } catch (error) {
    return { id: "graph_restored", status: "fail", evidence: error instanceof Error ? error.message : String(error) }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
