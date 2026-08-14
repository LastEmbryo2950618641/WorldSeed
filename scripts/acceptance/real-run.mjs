import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { chromium } from "playwright-core"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Real DeepSeek acceptance is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const workspace = requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const expectedModel = process.env.WORLDSEED_ACCEPTANCE_MODEL ?? "DeepSeek Flash"
const autoRecover = process.env.WORLDSEED_ACCEPTANCE_AUTO_RECOVER === "1"
const turns = readTurns(process.argv)
const turnTimeoutMs = Number(process.env.WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS ?? 7_200_000)
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_SCENARIO_REPORT ?? ".worldseed-data/acceptance/current/scenario.json")
const screenshotPath = resolve(process.env.WORLDSEED_ACCEPTANCE_SCENARIO_SCREENSHOT ?? ".worldseed-data/acceptance/current/scenario.png")

const report = {
  startedAt: new Date().toISOString(),
  workspace,
  cdpUrl,
  expectedModel,
  autoRecover,
  requestedTurns: turns,
  completedTurns: [],
  interruptions: [],
}

try {
  const browser = await chromium.connectOverCDP(cdpUrl)
  const page = browser.contexts()[0]?.pages()[0]
  if (page === undefined) throw new Error(`No Electron renderer page is available at ${cdpUrl}`)
  await openProjectIfNeeded(page, workspace)
  await closeKnownDialogs(page)
  await page.getByText("创作台首页", { exact: true }).waitFor({ timeout: 20_000 })

  const modelName = (await page.getByTestId("model-config-trigger").innerText()).trim()
  if (!modelName.includes(expectedModel)) throw new Error(`Expected model ${expectedModel}, current trigger is ${modelName}`)

  for (let index = 0; index < turns; index += 1) {
    const before = await chapterFiles(workspace)
    const prompt = buildPrompt(index, before.length)
    const input = page.locator("textarea").first()
    const runButton = page.locator("button.run-command")
    await input.fill(prompt)
    await runButton.getByText("开始推演", { exact: true }).waitFor({ timeout: 10_000 })
    await runButton.click()
    const turnResult = await waitForTurn(page, workspace, before, turnTimeoutMs, autoRecover, report)
    report.completedTurns.push({
      index: index + 1,
      input: prompt,
      chapterFilesBefore: before,
      ...turnResult,
    })
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  report.completedAt = new Date().toISOString()
  report.status = "pass"
  report.screenshotPath = screenshotPath
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
} catch (error) {
  report.completedAt = new Date().toISOString()
  report.status = "fail"
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(1)
}

async function waitForTurn(page, workspaceRoot, beforeFiles, timeoutMs, allowRecovery, currentReport) {
  const deadline = Date.now() + timeoutMs
  let recoveries = 0
  while (Date.now() < deadline) {
    const checkpoint = page.getByTestId("checkpoint-dialog")
    if (await checkpoint.count() > 0 && await checkpoint.first().isVisible()) {
      const interruption = {
        at: new Date().toISOString(),
        text: await checkpoint.first().innerText(),
      }
      currentReport.interruptions.push(interruption)
      if (!allowRecovery) throw new Error("Turn paused for user decision; enable WORLDSEED_ACCEPTANCE_AUTO_RECOVER=1 to simulate explicit UI recovery")
      await resetBlockingMetrics(checkpoint.first())
      const continueButton = checkpoint.first().getByRole("button", { name: "继续执行", exact: true })
      await continueButton.waitFor({ state: "visible", timeout: 10_000 })
      if (await continueButton.isDisabled()) throw new Error("Checkpoint remains blocked after explicit metric reset")
      await continueButton.click()
      recoveries += 1
    }

    const taskError = page.locator(".task-error")
    if (await taskError.count() > 0 && await taskError.first().isVisible()) {
      throw new Error(`Turn UI reported an error: ${await taskError.first().innerText()}`)
    }

    const afterFiles = await chapterFiles(workspaceRoot)
    const runButton = page.locator("button.run-command")
    if (afterFiles.length === beforeFiles.length + 1
      && (await runButton.innerText()).includes("开始推演")) {
      const newFiles = afterFiles.filter((file) => !beforeFiles.includes(file))
      return { chapterFilesAfter: afterFiles, newFiles, recoveries, completedAt: new Date().toISOString() }
    }
    await page.waitForTimeout(2_000)
  }
  throw new Error(`Turn did not complete within ${String(timeoutMs)} ms`)
}

async function resetBlockingMetrics(checkpoint) {
  const resetAll = checkpoint.getByRole("button", { name: "全部重置", exact: true })
  if (await resetAll.count() > 0 && await resetAll.isEnabled()) {
    await resetAll.click()
  } else {
    const resetButtons = checkpoint.getByRole("button", { name: "重置", exact: true })
    for (let index = 0; index < await resetButtons.count(); index += 1) {
      const button = resetButtons.nth(index)
      if (await button.isEnabled()) await button.click()
    }
  }
  await checkpoint.getByText("可以选择恢复方式", { exact: true }).waitFor({ timeout: 20_000 })
}

async function chapterFiles(workspaceRoot) {
  const directory = join(workspaceRoot, "章节正文")
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
}

async function openProjectIfNeeded(page, workspacePath) {
  if (await page.getByText("创作台首页", { exact: true }).count() > 0) return
  await page.getByRole("button", { name: "打开项目", exact: true }).first().click()
  await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspacePath)
  await page.getByRole("button", { name: "打开项目", exact: true }).last().click()
}

async function closeKnownDialogs(page) {
  const closeModel = page.getByRole("button", { name: "关闭模型配置" })
  if (await closeModel.count() > 0 && await closeModel.first().isVisible()) await closeModel.first().click()
  const checkpoint = page.getByTestId("checkpoint-dialog")
  if (await checkpoint.count() > 0 && await checkpoint.first().isVisible()) {
    await checkpoint.first().getByTitle("保持暂停并关闭").click()
  }
}

function buildPrompt(index, existingChapterCount) {
  return [
    `继续推演第 ${String(existingChapterCount + 1)} 章。`,
    "严格继承已经提交的世界当前状态、历史演化、时间与空间位置，不回退任何既有事实。",
    "推进当前视角中的行动并产生明确结果；对于当前视角未直接关注但已经存在的局部，只允许依据其自身状态、可用信息和经过时间自然发展。",
    "遇到资料没有定义的部分，根据已读上下文做最小一致补全，不因资料不足拒绝正文。",
    `本条为长期全链路验收输入 ${String(index + 1)}。`,
  ].join("\n")
}

function readTurns(argv) {
  const index = argv.indexOf("--turns")
  const value = Number(index < 0 ? 1 : argv[index + 1])
  if (!Number.isInteger(value) || value <= 0) throw new Error("--turns must be a positive integer")
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
