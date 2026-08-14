/* global window */

import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { connectElectron, readActiveModel, runQuery } from "./lib/electron-backend.mjs"
import { planModelSwitch } from "./lib/model-switch-profile.mjs"

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_MODEL_SWITCH_REPORT ?? ".worldseed-data/acceptance/current/model-switch.json")
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const { browser, page } = await connectElectron(cdpUrl, workspace)
const original = await page.evaluate(async () => window.worldseed.readModelProfiles())

try {
  const plan = planModelSwitch(original.profiles, original.activeProfileId)
  if (plan === undefined) {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "insufficient",
      reason: "A second profile using a different model is required",
      activeProfileId: original.activeProfileId,
      profiles: original.profiles.map((profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "apiKey"))),
    }
    await persist(report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = 1
  } else {
    const { source, target, switchProfiles } = plan
    const before = stateSnapshot(database)
    await saveSelection(page, switchProfiles, target.id)
    const selectedModel = await readActiveModel(page)
    const { handle, snapshot } = await runQuery(page, {
      projectId,
      workspaceRootRef: workspace,
      question: "读取当前世界线已提交状态，简要说明目前故事推进到哪里。不得创建新世界线，不得修改世界图。",
      allowWorkspaceChapterReads: false,
      model: selectedModel,
    }, { timeoutMs: 7_200_000, autoRecover: true })
    const switched = stateSnapshot(database)
    await saveSelection(page, original.profiles, original.activeProfileId)
    const restored = await page.evaluate(async () => window.worldseed.readModelProfiles())
    const after = stateSnapshot(database)
    const kv = taskKv(database, handle.taskId)
    const checks = [
      check("different_model_selected", selectedModel.model === target.model && selectedModel.model !== source.model, { source: source.model, target: selectedModel.model }),
      check("profile_context_capacity_applied", selectedModel.contextWindowTokens === target.contextWindowTokens, { expected: target.contextWindowTokens, actual: selectedModel.contextWindowTokens }),
      check("same_world_branch", before.activeBranchId === switched.activeBranchId && before.activeBranchId === after.activeBranchId, { before: before.activeBranchId, switched: switched.activeBranchId, after: after.activeBranchId }),
      check("same_context_chain", before.chainId === switched.chainId && before.chainId === after.chainId, { before: before.chainId, switched: switched.chainId, after: after.chainId }),
      check("context_only_appended", switched.messageCount > before.messageCount && after.messageCount === switched.messageCount, { before: before.messageCount, switched: switched.messageCount, after: after.messageCount }),
      check("query_completed", snapshot.status === "completed" && typeof snapshot.result?.answerMarkdown === "string", { taskId: handle.taskId, status: snapshot.status }),
      check("original_profile_restored", restored.activeProfileId === original.activeProfileId, { expected: original.activeProfileId, actual: restored.activeProfileId }),
      check("warm_calls_reused_prefix", kv.calls >= 2 && kv.recentAverage >= 0.98, kv),
    ]
    const report = {
      generatedAt: new Date().toISOString(),
      status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
      sourceProfileId: source.id,
      targetProfileId: target.id,
      taskId: handle.taskId,
      checks,
    }
    await persist(report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.status === "pass" ? 0 : 1
  }
} catch (error) {
  const restore = await saveSelection(page, original.profiles, original.activeProfileId)
    .then(() => ({ status: "restored" }))
    .catch((restoreError) => ({ status: "failed", error: errorValue(restoreError) }))
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    error: errorValue(error),
    restore,
  }
  await persist(report)
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} finally {
  database.close()
  await browser.close()
}

async function saveSelection(pageHandle, profiles, activeProfileId) {
  return pageHandle.evaluate(async ({ profileDrafts, selectedId }) => window.worldseed.saveModelProfiles({
    profiles: profileDrafts,
    activeProfileId: selectedId,
  }), { profileDrafts: profiles, selectedId: activeProfileId })
}

function stateSnapshot(databaseHandle) {
  const history = databaseHandle.prepare("select active_branch_id from project_history_state where project_id = ?").get(projectId)
  const chains = databaseHandle.prepare("select id, message_count from model_context_chains where project_id = ? order by updated_at desc").all(projectId)
  return {
    activeBranchId: history?.active_branch_id,
    chainCount: chains.length,
    chainId: chains[0]?.id,
    messageCount: chains[0]?.message_count ?? 0,
  }
}

function taskKv(databaseHandle, taskId) {
  const rows = databaseHandle.prepare("select total_input_tokens, cache_hit_input_tokens from kv_usage where task_id = ? order by created_at, id").all(taskId)
  const rates = rows.slice(1).map((row, index) => {
    const reusable = Math.min(rows[index].total_input_tokens, row.total_input_tokens)
    return reusable === 0 ? 0 : Math.min(row.cache_hit_input_tokens, reusable) / reusable
  })
  const recent = rates.slice(-3)
  return {
    calls: rows.length,
    average: average(rates),
    recentAverage: average(recent),
  }
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function errorValue(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
}

async function persist(report) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
