import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import {
  chapterFiles,
  connectElectron,
  invokeBackend,
  readActiveModel,
  waitForTask,
} from "./lib/electron-backend.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Real pause/resume acceptance is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_PAUSE_RESUME_REPORT
  ?? ".worldseed-data/acceptance/current/pause-resume.json")
const timeoutMs = positiveEnvironment("WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS", 7_200_000)
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const auditTaskId = argumentValue("--audit-task")
if (auditTaskId !== undefined) {
  const report = await auditCompletedTask(auditTaskId)
  database.close()
  await writeReport(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.status === "pass" ? 0 : 1)
}
const { browser, page } = await connectElectron(cdpUrl, workspace)
let restoreEntry
let restored = false
let taskId

try {
  const model = await readActiveModel(page)
  const beforeFiles = await chapterFiles(workspace)
  restoreEntry = await invokeBackend(page, "history.saveManual", {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    name: `暂停恢复验收前 ${new Date().toISOString()}`,
    note: "Restore the project after the real pause/resume acceptance turn.",
  })

  const handle = await invokeBackend(page, "turn.start", {
    projectId,
    workspaceRootRef: workspace,
    userInput: [
      `继续推演第 ${String(beforeFiles.length + 1)} 章。`,
      "严格继承当前时间、空间、事物状态和未完成线索；资料未定义处做最小一致补全。",
      "本轮用于验证额度暂停后继续同一任务，不得因资料不足拒绝正文。",
    ].join("\n"),
    chapterSequence: beforeFiles.length + 1,
    presentation: { minimumWordCount: 2000, maximumWordCount: 3000 },
    model,
    maxModelCalls: 1,
  })
  taskId = handle.taskId
  const paused = await waitForPaused(page, taskId, timeoutMs)
  const baseline = taskEvidence(database, taskId)
  const blockedMetrics = paused.interruption?.blockedMetrics ?? []

  if (!blockedMetrics.includes("model_calls")) {
    throw new Error(`Expected model_calls to block the task, received: ${blockedMetrics.join(",")}`)
  }
  await invokeBackend(page, "turn.metrics.reset", { taskId, metricIds: blockedMetrics })
  await invokeBackend(page, "turn.resume", {
    taskId,
    mode: "continue",
    resetMetricIds: [],
    model,
  })
  await waitForTask(page, taskId, {
    timeoutMs,
    autoRecover: true,
    maxRecoveries: 4,
    model,
  })
  await waitForAutomaticHistory(database, taskId, timeoutMs)
  const completion = taskEvidence(database, taskId)
  const afterFiles = await chapterFiles(workspace)

  await invokeBackend(page, "history.restore", historyOperation(restoreEntry.entryId))
  restored = true
  const restoredFiles = await chapterFiles(workspace)
  const duplicatedCompletedPhases = Object.entries(baseline.completedPhaseCounts)
    .filter(([phase, count]) => (completion.completedPhaseCounts[phase] ?? 0) > count)
    .map(([phase]) => phase)
  const checks = [
    check("paused_on_configured_metric", paused.status === "awaiting_user_decision" && blockedMetrics.includes("model_calls"), paused),
    check("stable_checkpoint_preserved", baseline.checkpoint !== undefined, baseline.checkpoint),
    check("provider_usage_preserved", baseline.kvCalls > 0 && baseline.totalInputTokens > 0, baseline),
    check("same_task_resumed", completion.task.id === taskId && completion.task.status === "completed", { taskId, completedTaskId: completion.task.id, status: completion.task.status }),
    check("completed_prefix_not_reexecuted", duplicatedCompletedPhases.length === 0, { baseline: baseline.completedPhaseCounts, completion: completion.completedPhaseCounts, duplicatedCompletedPhases }),
    check("single_chapter_finalized", completion.chapterCount === 1 && completion.finalizationCount === 1 && afterFiles.length === beforeFiles.length + 1, { beforeFiles: beforeFiles.length, afterFiles: afterFiles.length, chapterCount: completion.chapterCount, finalizationCount: completion.finalizationCount }),
    check("original_head_restored", sameFiles(beforeFiles, restoredFiles), { beforeFiles, restoredFiles }),
  ]
  const report = {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    projectId,
    workspace,
    taskId,
    restoreEntryId: restoreEntry.entryId,
    blockedMetrics,
    baseline,
    completion,
    checks,
  }
  await writeReport(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} catch (error) {
  const recovery = restoreEntry === undefined || restored
    ? undefined
    : await invokeBackend(page, "history.restore", historyOperation(restoreEntry.entryId))
      .then(() => ({ status: "restored" }))
      .catch((restoreError) => ({ status: "failed", error: errorValue(restoreError) }))
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    projectId,
    workspace,
    taskId,
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

async function waitForPaused(pageHandle, currentTaskId, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const snapshot = await invokeBackend(pageHandle, "turn.status", { taskId: currentTaskId })
    if (snapshot.status === "awaiting_user_decision" || snapshot.status === "paused") return snapshot
    if (snapshot.status === "completed" || snapshot.status === "cancelled" || snapshot.status === "failed") {
      throw new Error(`Task ${currentTaskId} ended with ${snapshot.status} before the expected pause`)
    }
    await pageHandle.waitForTimeout(2_000)
  }
  throw new Error(`Task ${currentTaskId} did not pause within ${String(waitMs)} ms`)
}

async function waitForAutomaticHistory(databaseHandle, currentTaskId, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const entry = databaseHandle.prepare(`
      select status from history_entries
      where task_id = ? and kind = 'automatic'
      order by created_at desc limit 1
    `).get(currentTaskId)
    if (entry?.status === "ready") return
    if (entry?.status === "failed") throw new Error(`Automatic history failed for task ${currentTaskId}`)
    await delay(1_000)
  }
  throw new Error(`Automatic history did not complete for task ${currentTaskId}`)
}

function taskEvidence(databaseHandle, currentTaskId) {
  const task = databaseHandle.prepare("select id, status, last_phase from tasks where id = ?").get(currentTaskId)
  const checkpoint = databaseHandle.prepare(`
    select phase, model_context_chain_id, model_context_sequence, updated_at
    from task_checkpoints where task_id = ? order by updated_at desc limit 1
  `).get(currentTaskId)
  const phaseRows = databaseHandle.prepare(`
    select phase, status, count(*) count from phase_runs
    where task_id = ? group by phase, status
  `).all(currentTaskId)
  const completedPhaseCounts = Object.fromEntries(phaseRows
    .filter((row) => row.status === "completed")
    .map((row) => [row.phase, row.count]))
  const usage = databaseHandle.prepare(`
    select count(*) kv_calls,
      coalesce(sum(total_input_tokens), 0) total_input_tokens,
      coalesce(sum(output_tokens), 0) total_output_tokens
    from kv_usage where task_id = ?
  `).get(currentTaskId)
  const chapterCount = databaseHandle.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(currentTaskId)?.count ?? 0
  const finalizationCount = databaseHandle.prepare("select count(*) count from turn_finalizations where task_id = ?").get(currentTaskId)?.count ?? 0
  return {
    task,
    checkpoint,
    phaseRows,
    completedPhaseCounts,
    kvCalls: usage.kv_calls,
    totalInputTokens: usage.total_input_tokens,
    totalOutputTokens: usage.total_output_tokens,
    chapterCount,
    finalizationCount,
  }
}

async function auditCompletedTask(currentTaskId) {
  const previous = JSON.parse(await readFile(outputPath, "utf8"))
  const baseline = previous.baseline
  if (baseline?.task?.id !== currentTaskId || baseline?.task?.status !== "awaiting_user_decision") {
    throw new Error(`The existing report has no paused baseline for task ${currentTaskId}`)
  }
  const completion = taskEvidence(database, currentTaskId)
  const finalizations = database.prepare(`
    select status, chapter_path chapterPath, content_digest contentDigest, committed_sequence committedSequence
    from turn_finalizations where task_id = ?
  `).all(currentTaskId)
  const automaticHistory = database.prepare(`
    select id, status, parent_entry_id parentEntryId, git_commit_oid gitCommitOid,
      committed_sequence committedSequence, name
    from history_entries where task_id = ? and kind = 'automatic'
  `).all(currentTaskId)
  const historyState = database.prepare(`
    select selected_entry_id selectedEntryId, active_branch_id activeBranchId
    from project_history_state where project_id = ?
  `).get(projectId)
  const duplicatedCompletedPhases = Object.entries(baseline.completedPhaseCounts ?? {})
    .filter(([phase, count]) => (completion.completedPhaseCounts[phase] ?? 0) > count)
    .map(([phase]) => phase)
  const finalization = finalizations[0]
  const history = automaticHistory[0]
  const checks = [
    check("paused_on_configured_metric", baseline.task.status === "awaiting_user_decision" && baseline.kvCalls > 0, baseline),
    check("same_task_resumed", completion.task.id === currentTaskId && completion.task.status === "completed", completion.task),
    check("same_context_chain", completion.checkpoint?.model_context_chain_id === baseline.checkpoint?.model_context_chain_id, { baseline: baseline.checkpoint, completion: completion.checkpoint }),
    check("checkpoint_prefix_preserved", completion.checkpoint?.model_context_sequence >= baseline.checkpoint?.model_context_sequence, { baseline: baseline.checkpoint, completion: completion.checkpoint }),
    check("completed_prefix_not_reexecuted", duplicatedCompletedPhases.length === 0, { baseline: baseline.completedPhaseCounts, completion: completion.completedPhaseCounts, duplicatedCompletedPhases }),
    check("single_completed_finalization", finalizations.length === 1 && finalization?.status === "completed", finalizations),
    check("single_ready_automatic_history", automaticHistory.length === 1 && history?.status === "ready" && history?.gitCommitOid != null && history?.committedSequence === finalization?.committedSequence, automaticHistory),
    check("original_head_restored", historyState?.selectedEntryId === history?.parentEntryId, { historyState, automaticHistory }),
    check("provider_usage_accumulated", completion.kvCalls > baseline.kvCalls && completion.totalInputTokens > baseline.totalInputTokens, { baseline: { kvCalls: baseline.kvCalls, totalInputTokens: baseline.totalInputTokens }, completion: { kvCalls: completion.kvCalls, totalInputTokens: completion.totalInputTokens } }),
  ]
  return {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    projectId,
    workspace,
    taskId: currentTaskId,
    baseline,
    completion,
    finalizations,
    automaticHistory,
    historyState,
    checks,
  }
}

function historyOperation(entryId) {
  return {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    entryId,
  }
}

function sameFiles(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function errorValue(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
}

async function writeReport(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

function positiveEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} requires a value`)
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
