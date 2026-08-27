import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { PROTOCOL_VERSION } from "../../packages/contracts/dist/index.js"

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const workspaceRootRef = resolve(process.env.WORLDSEED_ACCEPTANCE_WORKSPACE
  ?? join(repoRoot, ".worldseed-data/acceptance", `synopsis-desk-${randomUUID()}`))
const applicationDataRoot = process.env.WORLDSEED_APPLICATION_DATA_ROOT
  ?? join(process.env.APPDATA ?? "", "@worldseed", "desktop", "runtime")
const reportPath = resolve(process.env.WORLDSEED_ACCEPTANCE_BOOTSTRAP_REPORT ?? join(repoRoot, ".worldseed-data/acceptance/current/synopsis-desk-bootstrap.json"))

const backendEntry = pathToFileURL(join(repoRoot, "apps/backend/dist/index.js")).href
const fakeModelEntry = pathToFileURL(join(repoRoot, "apps/backend/dist/infrastructure/models/fake-ai-model-adapter.js")).href

const { BackendContainer, BackendFacade } = await import(backendEntry)
const { FakeAiModelAdapter } = await import(fakeModelEntry)

const container = await BackendContainer.open({
  applicationDataRoot,
  promptPackageRoot: join(repoRoot, "packages/prompt-contracts"),
  model: new FakeAiModelAdapter(),
})
const facade = new BackendFacade(container)

async function invoke(method, payload) {
  const response = await facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) throw new Error(`${method}: ${response.error.message}`)
  return response.data
}

let projectId = randomUUID()
await invoke("project.create", {
  projectId,
  displayName: "Synopsis Desk Acceptance",
  workspaceRootRef,
})

const chaptersBefore = await invoke("chapter.list", { projectId, workspaceRootRef })
if (Array.isArray(chaptersBefore) && chaptersBefore.length > 0) {
  const report = {
    generatedAt: new Date().toISOString(),
    workspaceRootRef,
    projectId,
    applicationDataRoot,
    chapterCount: chaptersBefore.length,
    firstChapterPath: chaptersBefore[0]?.publishPath,
    reusedExistingProject: true,
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

const started = await invoke("turn.start", {
  projectId,
  workspaceRootRef,
  userInput: "验收种子：雾港里出现一封未署名的信。",
  chapterSequence: 1,
})
const taskId = started.taskId

for (let attempt = 0; attempt < 120; attempt += 1) {
  const snapshot = await invoke("turn.status", { taskId })
  if (snapshot.status === "completed") break
  if (["failed", "cancelled"].includes(snapshot.status)) {
    throw new Error(`turn ended with ${snapshot.status}`)
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
}

const chapters = await invoke("chapter.list", { projectId, workspaceRootRef })
if (!Array.isArray(chapters) || chapters.length === 0) {
  throw new Error("chapter.list returned no chapters after seed turn")
}

const report = {
  generatedAt: new Date().toISOString(),
  workspaceRootRef,
  projectId,
  applicationDataRoot,
  chapterCount: chapters.length,
  firstChapterPath: chapters[0]?.publishPath,
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
