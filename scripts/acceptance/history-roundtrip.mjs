import { createHash, randomUUID } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { chapterFiles, connectElectron, invokeBackend } from "./lib/electron-backend.mjs"

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_HISTORY_REPORT ?? ".worldseed-data/acceptance/current/history.json")
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const { browser, page } = await connectElectron(cdpUrl, workspace)
let headEntry

try {
  const initial = await overview(page)
  const automatic = initial.entries
    .filter((entry) => entry.kind === "automatic" && entry.state === "complete_world" && entry.status === "ready")
    .sort((left, right) => left.committedSequence - right.committedSequence)
  if (automatic.length < 2) throw new Error("History roundtrip requires at least two completed automatic entries")

  headEntry = await invokeBackend(page, "history.saveManual", {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    name: `全链路验收头 ${new Date().toISOString()}`,
    note: "FC-11 roundtrip return point",
  })
  const headSnapshot = await snapshot(page, "head-saved")
  const forkSource = automatic[0]
  const forkCheckout = await invokeBackend(page, "history.continueFrom", operation(forkSource.entryId))
  const forkEntry = await invokeBackend(page, "history.saveManual", {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    name: `全链路验收分支 ${new Date().toISOString()}`,
    note: "FC-11 fork checkpoint",
  })
  const forkSnapshot = await snapshot(page, "fork-saved")

  await invokeBackend(page, "history.restore", operation(headEntry.entryId))
  const firstHeadRestore = await snapshot(page, "head-restored-1")
  await invokeBackend(page, "history.restore", operation(forkEntry.entryId))
  const forkRestore = await snapshot(page, "fork-restored")
  await invokeBackend(page, "history.restore", operation(headEntry.entryId))
  const secondHeadRestore = await snapshot(page, "head-restored-2")

  const checks = [
    check("fork_created_new_branch", forkCheckout.branch.branchId !== headSnapshot.activeBranchId, { headBranchId: headSnapshot.activeBranchId, forkBranchId: forkCheckout.branch.branchId }),
    check("head_roundtrip_exact", sameProjection(headSnapshot, firstHeadRestore) && sameProjection(headSnapshot, secondHeadRestore), { expected: headSnapshot, first: firstHeadRestore, second: secondHeadRestore }),
    check("fork_roundtrip_exact", sameProjection(forkSnapshot, forkRestore), { expected: forkSnapshot, actual: forkRestore }),
    check("branches_remain_distinct", headSnapshot.projectionDigest !== forkSnapshot.projectionDigest, { headDigest: headSnapshot.projectionDigest, forkDigest: forkSnapshot.projectionDigest }),
    check("head_context_restored", headSnapshot.contextDigest === firstHeadRestore.contextDigest && headSnapshot.contextDigest === secondHeadRestore.contextDigest, { expected: headSnapshot.contextDigest, first: firstHeadRestore.contextDigest, second: secondHeadRestore.contextDigest }),
  ]
  const report = {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    projectId,
    workspace,
    headEntry,
    forkSource,
    forkEntry,
    checks,
  }
  await writeReport(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} catch (error) {
  const recovery = headEntry === undefined
    ? undefined
    : await invokeBackend(page, "history.restore", operation(headEntry.entryId)).catch((restoreError) => ({ error: errorValue(restoreError) }))
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    projectId,
    workspace,
    error: errorValue(error),
    recovery,
  }
  await writeReport(report)
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} finally {
  database.close()
  await browser.close()
}

async function snapshot(pageHandle, label) {
  const state = await overview(pageHandle)
  const files = await markdownSnapshot(workspace)
  const chapters = await chapterFiles(workspace)
  const historyState = database.prepare("select active_branch_id, selected_entry_id from project_history_state where project_id = ?").get(projectId)
  const chains = database.prepare("select id, message_count, token_estimate from model_context_chains where project_id = ? order by id").all(projectId)
  const contextMessages = database.prepare("select chain_id, sequence_no, content_digest, hidden_at from model_context_messages where project_id = ? order by chain_id, sequence_no").all(projectId)
  const contextDigest = digest(JSON.stringify({ chains, contextMessages }))
  const projectionDigest = digest(JSON.stringify({
    activeBranchId: state.activeBranchId,
    selectedEntryId: state.selectedEntryId,
    graphAnchorIds: [...state.graphAnchorIds].sort(),
    files,
    historyState,
    contextDigest,
  }))
  return {
    label,
    activeBranchId: state.activeBranchId,
    selectedEntryId: state.selectedEntryId,
    graphAnchorIds: [...state.graphAnchorIds].sort(),
    chapterFiles: chapters,
    historyState,
    contextChainCount: chains.length,
    contextChainIds: chains.map((chain) => chain.id),
    contextMessageCount: contextMessages.length,
    markdownDigest: digest(JSON.stringify(files)),
    contextDigest,
    projectionDigest,
  }
}

async function overview(pageHandle) {
  return invokeBackend(pageHandle, "history.list", {
    projectId,
    workspaceRootRef: workspace,
  })
}

function operation(entryId) {
  return {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    entryId,
  }
}

async function markdownSnapshot(root) {
  const files = await walk(root)
  const markdown = files.filter((path) => path.toLowerCase().endsWith(".md"))
  return Promise.all(markdown.sort().map(async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    digest: digest(await readFile(path)),
  })))
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return nested.flat()
}

function sameProjection(left, right) {
  return left.projectionDigest === right.projectionDigest
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function errorValue(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
}

async function writeReport(report) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
