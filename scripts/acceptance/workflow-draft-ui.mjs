import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { _electron as electron } from "playwright-core"
import { BackendContainer, BackendFacade, FakeAiModelAdapter } from "../../apps/backend/dist/index.js"
import { PROTOCOL_VERSION } from "../../packages/contracts/dist/index.js"

const root = await mkdtemp(join(tmpdir(), "worldseed-workflow-ui-"))
const applicationDataRoot = join(root, "runtime")
const workspaceRootRef = join(root, "book")
const projectId = randomUUID()
const container = await BackendContainer.open({ applicationDataRoot, promptPackageRoot: resolve("packages/prompt-contracts"), model: new FakeAiModelAdapter() })
const facade = new BackendFacade(container, { automaticEvolutionEnabled: false })
const request = async (method, payload = {}) => {
  const response = await facade.handle({ protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), method,
    payload: { projectId, workspaceRootRef, ...payload } })
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}
await request("project.create", { displayName: "流程草稿验收" })
await request("project.open")
await request("synopsis.conversation.start")
let version
for (const [source, body] of [["workflow", "工具生成的第一版草稿。"], ["agent", "讨论 Agent 改写的第二版草稿。"], ["manual", "人工撰写的第三版草稿。"]]) {
  version = await request("chapter.draft.start", { chapterSequence: 1, heading: "第一章 测试草稿", body, source })
}
const draft = (await request("chapter.draft.list"))[0]
await container.close()
await mkdir(resolve("output/playwright"), { recursive: true })
const app = await electron.launch({
  executablePath: createRequire(resolve("apps/desktop/package.json"))("electron"),
  args: [resolve("apps/desktop"), `--user-data-dir=${join(root, "chromium")}`],
  env: { ...process.env, WORLDSEED_APP_DATA_ROOT: applicationDataRoot, WORLDSEED_PROMPT_ROOT: resolve("packages/prompt-contracts") },
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.evaluate(async (directory) => {
    await window.worldseed.addWorkDirectory(directory)
    await window.worldseed.setActiveWorkDirectory(directory)
  }, root)
  await page.reload()
  await page.getByTestId("launcher-book-card").filter({ hasText: "流程草稿验收" }).click()
  const modelDialog = page.getByRole("button", { name: "关闭模型配置" })
  if (await modelDialog.isVisible().catch(() => false)) await modelDialog.click()
  await page.getByTestId("synopsis-conversation").waitFor()
  console.log("workspace", await page.locator(".workspace-tree").innerText().catch(() => page.locator("body").innerText()))
  for (const name of ["章节正文", "第一卷 待命名"]) {
    const folder = page.locator("button[aria-expanded]").filter({ hasText: name }).first()
    await folder.waitFor({ state: "visible" })
    if (await folder.getAttribute("aria-expanded") === "false") await folder.click()
  }
  await page.getByRole("button", { name: /测试草稿/ }).first().click()
  await page.getByTestId("chapter-document-pane-draft").waitFor()
  assert.equal(await page.getByTestId("chapter-document-committed").count(), 0)
  await page.getByTestId("chapter-draft-version-select").click()
  const menu = page.getByTestId("chapter-draft-version-menu")
  await menu.waitFor({ state: "visible" })
  for (const label of ["AI流程工具", "讨论agent", "人工"]) assert.ok((await menu.innerText()).includes(label))
  const colors = await menu.locator(".chapter-version-mark-agent, .chapter-version-mark-manual, .chapter-version-mark-workflow").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))
  assert.equal(new Set(colors).size, 3)
  await page.screenshot({ path: resolve("output/playwright/workflow-draft-versions.png"), fullPage: true })
  await page.getByTestId("chapter-draft-version-select").click()
  const editor = page.locator(".chapter-draft-pane .monaco-editor textarea").first()
  await editor.focus()
  await page.keyboard.press("Control+End")
  await page.keyboard.insertText(" Saved draft.")
  await page.waitForFunction(async ({ projectId, workspaceRootRef, versionId, protocolVersion }) => {
    const response = await window.worldseed.invoke({ protocolVersion, requestId: crypto.randomUUID(), method: "chapter.revision.draftVersion.read", payload: { projectId, workspaceRootRef, versionId } })
    return response.ok && response.data.body.endsWith("Saved draft.")
  }, { projectId, workspaceRootRef, versionId: version.versionId, protocolVersion: PROTOCOL_VERSION })
  await page.getByRole("button", { name: "创作台", exact: true }).click()
  await page.getByRole("tab", { name: "流程推理工具", exact: true }).waitFor({ state: "visible" })
  await page.getByRole("button", { name: /测试草稿/ }).first().click()
  await page.getByTestId("chapter-document-pane-draft").waitFor()
  await page.getByTestId("chapter-document-pane-draft").getByText(/Saved draft\./).waitFor({ state: "visible" })
  const boxes = await page.locator(".chapter-reader-header-compact button").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect()
    const parent = node.closest(".chapter-reader").getBoundingClientRect()
    return { label: node.getAttribute("aria-label"), fits: rect.width === 0 || (rect.left >= parent.left && rect.right <= parent.right + 1) }
  }))
  assert.ok(boxes.every((box) => box.fits), JSON.stringify(boxes))
  await page.screenshot({ path: resolve("output/playwright/workflow-draft-desktop.png"), fullPage: true })
  console.log(JSON.stringify({ root, publishPath: draft.publishPath, versionId: version.versionId, colors, boxes, errors }))
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: resolve("output/playwright/workflow-draft-failure.png"), fullPage: true })
  console.log(await page.locator("body").innerText())
  throw error
} finally {
  await app.close()
}
