import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { connectElectron, invokeBackend, runTurn } from "./lib/electron-backend.mjs"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = process.env.WORLDSEED_DOM_TRACE_REPORT
  ?? ".worldseed-data/acceptance/current/dom-ui-trace.json"

const workspace = await mkdtemp(join(tmpdir(), "worldseed-dom-e2e-"))
const report = { workspace, steps: [] }

function record(id, data = {}) {
  const entry = { id, ...data }
  report.steps.push(entry)
  console.log(JSON.stringify(entry))
}

async function closeDialogs(page) {
  const closeModel = page.getByRole("button", { name: "关闭模型配置" })
  if (await closeModel.count() > 0 && await closeModel.first().isVisible()) {
    await closeModel.first().click()
  }
}

async function ensureProject(page) {
  await closeDialogs(page)
  const onLauncher = await page.getByTestId("launcher-create-project").isVisible().catch(() => false)
  if (onLauncher) {
    await page.evaluate((dir) => { window.sessionStorage.setItem("worldseed:e2e-workspace", dir) }, workspace)
    await page.getByTestId("launcher-create-project").click()
    await page.evaluate(() => { window.sessionStorage.removeItem("worldseed:e2e-workspace") })
    record("create_project_ui")
    await page.getByText("创作台首页", { exact: true }).waitFor({ timeout: 30000 })
    return workspace
  }

  if (await page.locator(".status-path").count() > 0) {
    const statusPath = (await page.locator(".status-path").innerText()).trim()
    const existingWorkspace = statusPath.split("\\章节正文\\")[0]?.split("/章节正文/")[0] ?? statusPath
    const onHome = await page.getByText("创作台首页", { exact: true }).isVisible().catch(() => false)
    if (!onHome) {
      await page.getByRole("button", { name: "创作台" }).click()
      await delay(500)
    }
    record("reuse_open_project", { workspaceRootRef: existingWorkspace })
    return existingWorkspace
  }

  throw new Error("App is not on launcher or workbench")
}

function extractAssistantReplies(threadText) {
  const blocks = threadText.split(/\n(?=Agent\n)/u).filter((block) => block.startsWith("Agent"))
  return blocks.map((block) => block.replace(/^Agent\n/u, "").split(/\n(?:已自动写入草稿|查看对比|在编辑区查看对比)/u)[0]?.trim() ?? "")
}

async function sendConversationMessage(page, message) {
  const conversationInput = page.locator(".chapter-conversation textarea")
  await conversationInput.fill(message)
  await page.locator(".chapter-conversation .run-command").click()
  await delay(4000)
  return page.locator(".chapter-conversation-thread").innerText().catch(() => "")
}

const { browser, page } = await connectElectron(cdpUrl)

try {
  await page.waitForTimeout(2000)
  const workspaceRootRef = await ensureProject(page)
  await closeDialogs(page)

  const opened = await invokeBackend(page, "project.open", { workspaceRootRef })
  const activeProjectId = opened.projectId
  record("project_opened", { projectId: activeProjectId, workspaceRootRef })

  const prompt = "雨夜里，旧站台尽头亮起一盏无人认领的灯，旅人第一次靠近它。"
  record("fill_prompt", { prompt })

  const turn = await runTurn(page, {
    projectId: activeProjectId,
    workspaceRootRef,
    userInput: prompt,
    chapterSequence: 1,
  }, { timeoutMs: 180_000 })
  record("turn_completed", { taskId: turn.handle.taskId, status: turn.snapshot.status })

  const chapters = await invokeBackend(page, "chapter.list", {
    projectId: activeProjectId,
    workspaceRootRef,
  })
  const chapterOne = chapters[0]
  if (chapterOne === undefined) throw new Error("No chapter generated after turn")

  await page.getByTitle("刷新").click()
  await delay(800)
  const chapterLabel = chapterOne.publishPath.split("/").at(-1) ?? chapterOne.heading
  await page.locator(".workspace-tree").getByText(chapterLabel, { exact: false }).first().click()
  await delay(1200)

  const chapterComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  const chapterConversationVisible = await page.locator('[data-testid="chapter-conversation"]').isVisible().catch(() => false)
  const workspaceRailVisible = await page.locator('[data-testid="chapter-workspace-rail"]').isVisible().catch(() => false)
  const resizeHandleVisible = await page.locator(".editor-panel-resize-handle").isVisible().catch(() => false)
  record("chapter_tab", {
    composerVisible: chapterComposerVisible,
    conversationVisible: chapterConversationVisible,
    workspaceRailVisible,
    resizeHandleVisible,
  })

  let documentSwitchOk = false
  let conversationOk = false
  let repliesDistinct = false
  let intentSpecific = false
  if (chapterConversationVisible) {
    const suspenseThread = await sendConversationMessage(page, "让开头更悬疑一些")
    documentSwitchOk = await page.locator('[data-testid="chapter-document-switch"]').isVisible().catch(() => false)
    const wordCountThread = await sendConversationMessage(page, "字数太少了，需要2000字左右")
    await page.locator('[data-testid="chapter-document-committed"]').click().catch(() => {})
    const committedPaneText = await page.locator('[data-testid="chapter-document-pane-committed"]').innerText().catch(() => "")
    await page.locator('[data-testid="chapter-document-draft"]').click().catch(() => {})
    const draftPaneText = await page.locator('[data-testid="chapter-document-pane-draft"]').innerText().catch(() => "")
    const replies = extractAssistantReplies(wordCountThread)
    const suspenseReply = replies[0] ?? ""
    const wordCountReply = replies.at(-1) ?? ""

    documentSwitchOk = documentSwitchOk
      && draftPaneText.length > committedPaneText.length
      && draftPaneText !== committedPaneText
    conversationOk = wordCountThread.includes("Agent")
      && wordCountThread.includes("已自动写入草稿")
      && suspenseReply.length > 0
      && wordCountReply.length > 0
    repliesDistinct = suspenseReply !== wordCountReply
    intentSpecific = /悬疑|开头/u.test(suspenseReply)
      && /2000|扩展|字/u.test(wordCountReply)
      && !/我已根据你的要求更新了章节草稿/u.test(wordCountReply)

    record("conversation_send", {
      conversationOk,
      documentSwitchOk,
      repliesDistinct,
      intentSpecific,
      committedLength: committedPaneText.length,
      draftLength: draftPaneText.length,
      suspensePreview: suspenseReply.slice(0, 180),
      wordCountPreview: wordCountReply.slice(0, 180),
    })
  }

  await page.getByRole("button", { name: "创作台" }).click()
  await delay(500)
  const homeComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  record("home_tab", { composerVisible: homeComposerVisible })

  report.status = chapterComposerVisible === false
    && homeComposerVisible === true
    && chapterConversationVisible === true
    && resizeHandleVisible === true
    && documentSwitchOk === true
    && conversationOk === true
    && repliesDistinct === true
    && intentSpecific === true
    ? "pass"
    : "fail"
  report.completedAt = new Date().toISOString()
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await page.screenshot({
    path: ".worldseed-data/acceptance/current/dom-ui-trace.png",
    fullPage: true,
    timeout: 120_000,
  }).catch((error) => {
    record("screenshot_failed", { message: error instanceof Error ? error.message : String(error) })
  })
} finally {
  await browser.close()
}

console.log("REPORT", JSON.stringify(report, null, 2))
process.exitCode = report.status === "pass" ? 0 : 1
