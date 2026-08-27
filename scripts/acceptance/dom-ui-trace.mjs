import { createRequire } from "node:module"
import { readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))

const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const dataRoot = process.env.WORLDSEED_APP_DATA_ROOT
  ?? "c:/Users/liuqi/Documents/worldseed/.worldseed-data/chapter-trace-run"

function findWorkspaces(directory) {
  const results = []
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory()) continue
    try {
      if (readdirSync(path).includes("章节正文")) results.push(path)
    } catch {
      // ignore unreadable directories
    }
    if (entry.name !== "projects") results.push(...findWorkspaces(path))
  }
  return results
}

const tempWorkspaces = []
for (const entry of readdirSync("C:/Users/liuqi/AppData/Local/Temp", { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("worldseed-ui-dom-")) continue
  const path = join("C:/Users/liuqi/AppData/Local/Temp", entry.name)
  try {
    if (readdirSync(path).includes("章节正文")) tempWorkspaces.push(path)
  } catch {
    // ignore
  }
}

const workspaces = [...findWorkspaces(dataRoot), ...tempWorkspaces]
const workspace = workspaces.at(-1)
if (workspace === undefined) throw new Error("No workspace with 章节正文 found")

const browser = await chromium.connectOverCDP(cdpUrl)
const page = browser.contexts()[0]?.pages()[0]
if (page === undefined) throw new Error(`No Electron page at ${cdpUrl}`)

const chapterFiles = readdirSync(join(workspace, "章节正文")).filter((name) => name.endsWith(".md"))
console.log(JSON.stringify({ step: "workspace", workspace, chapterFiles }, null, 2))

const projectsDir = join(dataRoot, "projects")
const projectId = readdirSync(projectsDir).at(-1)
if (projectId === undefined) throw new Error("No project database found")
const database = new Database(join(projectsDir, projectId, "project.sqlite"), { readonly: true })
try {
  console.log(JSON.stringify({
    step: "database",
    chapterIndex: database.prepare("select chapter_id, sequence, current_publish_path from chapter_index order by sequence").all(),
    contextMessages: database.prepare(`
      select kind, sequence_no, task_id, substr(content_digest, 1, 12) as digest_prefix
      from model_context_messages
      where hidden_at is null
      order by sequence_no
    `).all(),
    recentTasks: database.prepare("select id, kind, status, last_phase from tasks order by created_at desc limit 5").all(),
  }, null, 2))
} finally {
  database.close()
}

if (chapterFiles.length > 0) {
  await page.getByText(chapterFiles[0], { exact: false }).first().click()
  await page.waitForTimeout(1000)
  const chapterComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  console.log(JSON.stringify({ step: "chapter_tab", composerVisible: chapterComposerVisible }, null, 2))

  await page.getByRole("button", { name: "创作台" }).click()
  await page.waitForTimeout(500)
  const homeComposerVisible = await page.locator(".turn-composer").isVisible().catch(() => false)
  console.log(JSON.stringify({ step: "home_tab", composerVisible: homeComposerVisible }, null, 2))
}

await browser.close()
