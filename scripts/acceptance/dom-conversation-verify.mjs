import { setTimeout as delay } from "node:timers/promises"
import { connectElectron, invokeBackend } from "./lib/electron-backend.mjs"

const { browser, page } = await connectElectron("http://127.0.0.1:9230")
const statusPath = (await page.locator(".status-path").innerText()).trim()
const workspaceRootRef = statusPath.split("\\章节正文\\")[0]?.split("/章节正文/")[0] ?? statusPath
const opened = await invokeBackend(page, "project.open", { workspaceRootRef })
const visible = await page.locator('[data-testid="chapter-conversation"]').isVisible()
const report = { workspaceRootRef, projectId: opened.projectId, conversationVisible: visible }

if (!visible) {
  const chapters = await invokeBackend(page, "chapter.list", { projectId: opened.projectId, workspaceRootRef })
  const chapter = chapters[0]
  if (chapter !== undefined) {
    await page.getByTitle("刷新").click()
    await delay(500)
    await page.locator(".workspace-tree").getByText(chapter.publishPath.split("/").at(-1) ?? "", { exact: false }).first().click()
    await delay(1000)
    report.conversationVisible = await page.locator('[data-testid="chapter-conversation"]').isVisible()
  }
}

async function sendMessage(message) {
  await page.locator(".chapter-conversation textarea").fill(message)
  await page.locator(".chapter-conversation .run-command").click()
  await delay(4000)
  return page.locator(".chapter-conversation-thread").innerText()
}

function extractAssistantReplies(threadText) {
  const blocks = threadText.split(/\n(?=Agent\n)/u).filter((block) => block.startsWith("Agent"))
  return blocks.map((block) => block.replace(/^Agent\n/u, "").split(/\n(?:已自动写入草稿|查看对比|在编辑区查看对比)/u)[0]?.trim() ?? "")
}

if (report.conversationVisible) {
  const suspenseThread = await sendMessage("让开头更悬疑一些")
  const wordCountThread = await sendMessage("字数太少了，需要2000字左右")
  const replies = extractAssistantReplies(wordCountThread)
  const suspenseReply = replies[0] ?? ""
  const wordCountReply = replies.at(-1) ?? ""

  report.conversationOk = suspenseThread.includes("Agent")
    && wordCountThread.includes("已自动写入草稿")
    && suspenseReply.length > 0
    && wordCountReply.length > 0
  report.repliesDistinct = suspenseReply !== wordCountReply
  report.intentSpecific = /悬疑|开头/u.test(suspenseReply)
    && /2000|扩展|字/u.test(wordCountReply)
  report.preview = { suspense: suspenseReply.slice(0, 220), wordCount: wordCountReply.slice(0, 220) }
}

await page.screenshot({ path: ".worldseed-data/acceptance/current/dom-conversation-verify.png", fullPage: true })
await browser.close()
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.conversationVisible
  && report.conversationOk
  && report.repliesDistinct
  && report.intentSpecific
  ? 0
  : 1
