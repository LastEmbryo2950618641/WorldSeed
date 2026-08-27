/**
 * DOM acceptance: unified chapter workspace (正文只读 + 草稿编辑 + 统一审核/提交)
 *
 * Test boundaries — IN SCOPE (this script):
 *  B1  UI 路由：章节 Tab 无 TurnComposer；创作台有 TurnComposer
 *  B2  双文档：正文/草稿 Tab 可见；默认草稿 Tab；正文只读、草稿可编辑（Monaco）
 *  B3  阅读工具栏：合并工具栏内字体/字号/行距控件可见（chapter-workspace-toolbar）
 *  B4  统一操作栏：合并工具栏仅草稿显示修订按钮；正文 Tab 隐藏按钮；位于 Agent 对话上方
 *  B5  Agent 对话：面板可见；不同意图 → 不同回复；含「已自动写入草稿」
 *  B6  草稿预览：AI 扩写后草稿字数 > 正文，且正文 Tab 内容不变
 *  B7  提交门禁：未改稿时审核/直接提交 disabled；草稿有变更后可点
 *
 * OUT OF SCOPE (covered by backend vitest / manual):
 *  - revision 持久化细节、model_context 隔离、graphSync 完成
 *  - 完整 submitRevision + 图同步端到端
 *  - 放弃修订后 revision 回收
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { connectElectron, invokeBackend, runTurn } from "./lib/electron-backend.mjs"

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = process.env.WORLDSEED_DOM_WORKSPACE_REPORT
  ?? ".worldseed-data/acceptance/current/dom-chapter-workspace-trace.json"

const boundaries = {
  inScope: ["B1_ui_routing", "B2_dual_document", "B3_reading_toolbar", "B4_unified_actions", "B5_agent_conversation", "B6_draft_preview", "B7_submit_gate"],
  outOfScope: ["backend_persistence", "graph_sync_complete", "full_submit_e2e", "retire_revision"],
}

const workspace = await mkdtemp(join(tmpdir(), "worldseed-dom-workspace-e2e-"))
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
}

async function ensureProject(page) {
  await closeDialogs(page)
  if (await page.getByText("建立一个新世界", { exact: true }).isVisible().catch(() => false)) {
    await page.getByPlaceholder("例如：雾港纪事").fill("DOM 章节工作区验收")
    await page.getByPlaceholder("选择一个空目录或已有项目目录").fill(workspace)
    await page.getByRole("button", { name: "创建并进入", exact: true }).click()
    record("create_project")
    await page.getByText("创作台首页", { exact: true }).waitFor({ timeout: 30_000 })
    return workspace
  }
  const statusPath = (await page.locator(".status-path").innerText()).trim()
  const existing = statusPath.split("\\章节正文\\")[0]?.split("/章节正文/")[0] ?? statusPath
  if (!(await page.getByText("创作台首页", { exact: true }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "创作台" }).click()
    await delay(500)
  }
  record("reuse_project", { workspaceRootRef: existing })
  return existing
}

async function readCommittedPane(page) {
  await page.locator('[data-testid="chapter-document-committed"]').click()
  await delay(300)
  return page.locator('[data-testid="chapter-document-pane-committed"]').innerText().catch(() => "")
}

async function waitForDraftMonaco(page, timeoutMs = 20_000) {
  await page.locator('[data-testid="chapter-document-draft"]').click()
  await page.locator('[data-testid="chapter-document-pane-draft"] .monaco-editor').waitFor({
    state: "visible",
    timeout: timeoutMs,
  })
  await page.locator('[data-testid="chapter-document-pane-draft"] .view-lines').first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  }).catch(() => undefined)
  await delay(500)
}

async function readDraftCharCountFromTab(page) {
  const countText = await page.locator('[data-testid="chapter-document-draft"] small').innerText().catch(() => "0")
  return Number.parseInt(countText.replace(/\D/gu, ""), 10) || 0
}

async function readCommittedCharCountFromTab(page) {
  const countText = await page.locator('[data-testid="chapter-document-committed"] small').innerText().catch(() => "0")
  return Number.parseInt(countText.replace(/\D/gu, ""), 10) || 0
}

async function readDraftPane(page) {
  await waitForDraftMonaco(page)
  const monacoLines = page.locator('[data-testid="chapter-document-pane-draft"] .view-lines')
  if (await monacoLines.count() > 0) {
    return monacoLines.first().innerText().catch(() => "")
  }
  return page.locator('[data-testid="chapter-document-pane-draft"]').innerText().catch(() => "")
}

function extractAssistantReplies(threadText) {
  const blocks = threadText.split(/\n(?=Agent\n)/u).filter((block) => block.startsWith("Agent"))
  return blocks.map((block) => block.replace(/^Agent\n/u, "").split(/\n(?:已自动写入草稿|查看对比|在编辑区查看对比)/u)[0]?.trim() ?? "")
}

async function sendConversationMessage(page, message) {
  await page.locator(".chapter-conversation textarea").fill(message)
  await page.locator(".chapter-conversation .run-command").click()
  await delay(4500)
  return page.locator(".chapter-conversation-thread").innerText().catch(() => "")
}

const { browser, page } = await connectElectron(cdpUrl)

try {
  await page.waitForTimeout(1500)
  const workspaceRootRef = await ensureProject(page)
  await closeDialogs(page)

  const opened = await invokeBackend(page, "project.open", { workspaceRootRef })
  const projectId = opened.projectId
  record("project_opened", { projectId, workspaceRootRef })

  const turn = await runTurn(page, {
    projectId,
    workspaceRootRef,
    userInput: "雨夜里，旧站台尽头亮起一盏无人认领的灯，旅人第一次靠近它。",
    chapterSequence: 1,
  }, { timeoutMs: 180_000 })
  record("turn_completed", { taskId: turn.handle.taskId })

  const chapters = await invokeBackend(page, "chapter.list", { projectId, workspaceRootRef })
  const chapter = chapters.at(-1) ?? chapters[0]
  if (chapter === undefined) throw new Error("No chapter after turn")

  await page.getByTitle("刷新").click()
  await delay(800)
  const chapterLabel = chapter.publishPath.split("/").at(-1) ?? chapter.heading
  await page.locator(".workspace-tree").getByText(chapterLabel, { exact: false }).first().click()
  await page.locator('[data-testid="chapter-revision-actions"]').waitFor({ state: "visible", timeout: 30_000 })
  await waitForDraftMonaco(page)

  // B1
  const chapterComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  const conversationVisible = await page.locator('[data-testid="chapter-conversation"]').isVisible().catch(() => false)
  const workspaceRailVisible = await page.locator('[data-testid="chapter-workspace-rail"]').isVisible().catch(() => false)
  const resizeHandleVisible = await page.locator(".editor-panel-resize-handle").isVisible().catch(() => false)
  setCheck("B1_ui_routing", chapterComposerVisible === false && conversationVisible === true && workspaceRailVisible === true && resizeHandleVisible === false, {
    chapterComposerVisible, conversationVisible, workspaceRailVisible, resizeHandleVisible,
  })
  record("B1_ui_routing", report.checks.B1_ui_routing)

  // B2 — 草稿 Tab 下 Monaco 才挂载；须先检 draft 再切正文
  const switchVisible = await page.locator('[data-testid="chapter-document-switch"]').isVisible().catch(() => false)
  const draftTabActive = await page.locator('[data-testid="chapter-document-draft"].active').isVisible().catch(() => false)
  const draftHasMonaco = await page.locator('[data-testid="chapter-document-pane-draft"] .monaco-editor').count() > 0
  const committedText = await readCommittedPane(page)
  const committedHasMonaco = await page.locator('[data-testid="chapter-document-pane-committed"] .monaco-editor').count() > 0
  const noLegacyDirectEditor = await page.locator(".chapter-revision-editor").count() === 0
  setCheck("B2_dual_document", switchVisible && draftTabActive && draftHasMonaco && !committedHasMonaco && noLegacyDirectEditor, {
    switchVisible, draftTabActive, draftHasMonaco, committedHasMonaco, noLegacyDirectEditor,
  })
  record("B2_dual_document", report.checks.B2_dual_document)

  // B3
  await page.locator('[data-testid="chapter-editor-chrome-toggle"]').click()
  await delay(200)
  const readingToolbarVisible = await page.locator('[data-testid="chapter-reading-toolbar"]').isVisible().catch(() => false)
  const hasFontSelect = await page.locator('[data-testid="chapter-reading-toolbar"] select[aria-label="正文字体"]').count() > 0
  const hasSizeSelect = await page.locator('[data-testid="chapter-reading-toolbar"] select[aria-label="正文字号"]').count() > 0
  setCheck("B3_reading_toolbar", readingToolbarVisible && hasFontSelect && hasSizeSelect, {
    readingToolbarVisible, hasFontSelect, hasSizeSelect,
  })
  record("B3_reading_toolbar", report.checks.B3_reading_toolbar)

  // B4 — 操作栏仅草稿可见；切正文后应隐藏；按钮可点性与草稿是否脏一致
  await page.locator('[data-testid="chapter-document-draft"]').click()
  await delay(300)
  const actionsOnDraft = await page.locator('[data-testid="chapter-revision-actions"]').isVisible().catch(() => false)
  const actionsText = await page.locator('[data-testid="chapter-revision-actions"]').innerText().catch(() => "")
  const hasReview = actionsText.includes("审核修订")
  const hasDirectSubmit = actionsText.includes("直接提交")
  const hasDiscard = actionsText.includes("放弃修订")
  const noEditChapterButton = await page.getByRole("button", { name: "编辑章节" }).count() === 0
  const draftCharsBeforeAi = await readDraftCharCountFromTab(page)
  const committedCharsBeforeAi = await readCommittedCharCountFromTab(page)
  const draftUnchanged = draftCharsBeforeAi === committedCharsBeforeAi
  const reviewBeforeChange = page.locator('[data-testid="chapter-revision-actions"] .revision-secondary-command')
  const directBeforeChange = page.locator('[data-testid="chapter-revision-actions"] .revision-primary-command')
  const reviewEnabledBeforeAi = await reviewBeforeChange.isEnabled().catch(() => false)
  const directEnabledBeforeAi = await directBeforeChange.isEnabled().catch(() => false)
  const gateMatchesDirtyState = draftUnchanged
    ? !reviewEnabledBeforeAi && !directEnabledBeforeAi
    : reviewEnabledBeforeAi && directEnabledBeforeAi
  await page.locator('[data-testid="chapter-document-committed"]').click()
  await delay(300)
  const actionsOnCommitted = await page.locator('[data-testid="chapter-revision-actions"]').isVisible().catch(() => false)
  await page.locator('[data-testid="chapter-document-draft"]').click()
  await delay(300)
  setCheck("B4_unified_actions",
    actionsOnDraft && !actionsOnCommitted && hasReview && hasDirectSubmit && hasDiscard && noEditChapterButton
    && gateMatchesDirtyState,
    {
      actionsOnDraft, actionsOnCommitted, hasReview, hasDirectSubmit, hasDiscard, noEditChapterButton,
      draftCharsBeforeAi, committedCharsBeforeAi, draftUnchanged,
      reviewEnabledBeforeAi, directEnabledBeforeAi, gateMatchesDirtyState,
    },
  )
  record("B4_unified_actions", report.checks.B4_unified_actions)

  // B5 + B6 + B7 — after AI messages
  const suspenseThread = await sendConversationMessage(page, "让开头更悬疑一些")
  const wordCountThread = await sendConversationMessage(page, "字数太少了，需要2000字左右")
  const replies = extractAssistantReplies(wordCountThread)
  const suspenseReply = replies[0] ?? ""
  const wordCountReply = replies.at(-1) ?? ""
  await page.locator('[data-testid="chapter-document-draft"] small').filter({ hasText: /\d{3,}/u }).waitFor({
    timeout: 15_000,
  }).catch(() => undefined)
  const draftCharCountAfterAi = await readDraftCharCountFromTab(page)
  const committedCharCountAfterAi = await readCommittedCharCountFromTab(page)
  const draftTextAfterAi = await readDraftPane(page)
  const committedTextAfterAi = await readCommittedPane(page)

  setCheck("B5_agent_conversation",
    wordCountThread.includes("Agent")
    && wordCountThread.includes("已自动写入草稿")
    && suspenseReply !== wordCountReply
    && /悬疑|开头/u.test(suspenseReply)
    && /2000|扩展|字/u.test(wordCountReply),
    { suspensePreview: suspenseReply.slice(0, 160), wordCountPreview: wordCountReply.slice(0, 160) },
  )
  record("B5_agent_conversation", report.checks.B5_agent_conversation)

  setCheck("B6_draft_preview",
    draftCharCountAfterAi > committedCharCountAfterAi
    && draftTextAfterAi !== committedTextAfterAi
    && committedCharCountAfterAi <= (committedText.replace(/\s+/gu, "").length + 20),
    {
      committedLength: committedTextAfterAi.length,
      draftLength: draftTextAfterAi.length,
      committedCharCount: committedCharCountAfterAi,
      draftCharCount: draftCharCountAfterAi,
      baselineCommittedLength: committedText.length,
    },
  )
  record("B6_draft_preview", report.checks.B6_draft_preview)

  await page.locator('[data-testid="chapter-document-draft"]').click()
  await delay(300)
  const reviewButton = page.locator('[data-testid="chapter-revision-actions"] .revision-secondary-command')
  const directButton = page.locator('[data-testid="chapter-revision-actions"] .revision-primary-command')
  const reviewEnabled = await reviewButton.isEnabled().catch(() => false)
  const directEnabled = await directButton.isEnabled().catch(() => false)
  setCheck("B7_submit_gate", reviewEnabled && directEnabled, { reviewEnabled, directEnabled })
  record("B7_submit_gate", report.checks.B7_submit_gate)

  await page.getByRole("button", { name: "创作台" }).click()
  await delay(500)
  const homeComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  setCheck("B1_home_composer", homeComposerVisible === true, { homeComposerVisible })
  record("B1_home_composer", report.checks.B1_home_composer)

  const allOk = Object.values(report.checks).every((check) => check.ok === true)
  report.status = allOk ? "pass" : "fail"
  report.completedAt = new Date().toISOString()

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await page.screenshot({
    path: ".worldseed-data/acceptance/current/dom-chapter-workspace-trace.png",
    fullPage: true,
    timeout: 120_000,
  }).catch((error) => {
    record("screenshot_failed", { message: error instanceof Error ? error.message : String(error) })
  })
} finally {
  await browser.close()
}

console.log("BOUNDARIES", JSON.stringify(boundaries, null, 2))
console.log("REPORT", JSON.stringify(report, null, 2))
process.exitCode = report.status === "pass" ? 0 : 1
