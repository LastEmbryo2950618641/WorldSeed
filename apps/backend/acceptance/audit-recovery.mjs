import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"

import Database from "better-sqlite3"

import {
  buildCompletedRecoveryReport,
  selectLatestRestoredTask,
} from "./lib/recovery-audit.mjs"

const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_RECOVERY_REPORT ?? ".worldseed-data/acceptance/current/recovery.json")
const fullChainPath = resolve(process.env.WORLDSEED_ACCEPTANCE_FULL_REPORT ?? ".worldseed-data/acceptance/current/full-chain.json")
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const previous = await readJson(outputPath)
const fullChain = await readJson(fullChainPath)
const taskId = process.env.WORLDSEED_ACCEPTANCE_RECOVERY_TASK_ID
  ?? previous?.taskId
  ?? database.prepare("select id from tasks where status in ('awaiting_user_decision', 'paused') order by updated_at desc limit 1").get()?.id

if (taskId === undefined) throw new Error("Recovery audit requires a paused task or WORLDSEED_ACCEPTANCE_RECOVERY_TASK_ID")

const current = readTaskEvidence(database, taskId)
const restoration = selectLatestRestoredTask(fullChain, taskId)
const restored = restoration === undefined ? undefined : readTaskEvidence(database, restoration.restoredTaskId)
const baseline = previous?.baseline ?? current
const report = restored?.task.status === "completed"
  ? buildCompletedRecoveryReport(restoration, baseline, restored)
  : current.task.status === "completed" && previous?.baseline !== undefined
    ? buildCompletedRecoveryReport({ originalTaskId: taskId, restoredTaskId: taskId }, previous.baseline, current)
    : pausedReport(current)

database.close()
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.status === "pass" ? 0 : report.status === "paused" ? 2 : 1

function pausedReport(evidence) {
  const recoverable = evidence.task.status === "awaiting_user_decision" || evidence.task.status === "paused"
  return {
    generatedAt: new Date().toISOString(),
    status: recoverable ? "paused" : "fail",
    taskId: evidence.task.id,
    baseline: evidence,
    checks: [
      check("recoverable_status", recoverable, evidence.task),
      check("stable_checkpoint_exists", evidence.checkpoint !== undefined, evidence.checkpoint),
      check("single_context_chain", evidence.chainCount === 1, { chainCount: evidence.chainCount, chainId: evidence.chain?.id }),
      check("no_premature_chapter", evidence.chapterCount === 0 && evidence.finalizationCount === 0, { chapterCount: evidence.chapterCount, finalizationCount: evidence.finalizationCount }),
      check("provider_usage_preserved", evidence.kvCalls > 0, { kvCalls: evidence.kvCalls, totalInputTokens: evidence.totalInputTokens, totalOutputTokens: evidence.totalOutputTokens }),
    ],
  }
}

function readTaskEvidence(databaseHandle, taskIdValue) {
  const task = databaseHandle.prepare("select id, project_id, kind, status, scope_id, last_phase, error_json, created_at, updated_at from tasks where id = ?").get(taskIdValue)
  if (task === undefined) throw new Error(`Recovery task does not exist: ${taskIdValue}`)
  const checkpoint = databaseHandle.prepare(`
    select phase, model_context_chain_id, model_context_sequence, updated_at
    from task_checkpoints where task_id = ? order by updated_at desc limit 1
  `).get(taskIdValue)
  const chains = databaseHandle.prepare("select id, message_count, token_estimate from model_context_chains where project_id = ?").all(task.project_id)
  const phaseRows = databaseHandle.prepare("select phase, status, count(*) count from phase_runs where task_id = ? group by phase, status").all(taskIdValue)
  const completedPhaseCounts = Object.fromEntries(phaseRows.filter((row) => row.status === "completed").map((row) => [row.phase, row.count]))
  const usage = databaseHandle.prepare(`
    select count(*) kv_calls,
      coalesce(sum(total_input_tokens), 0) total_input_tokens,
      coalesce(sum(output_tokens), 0) total_output_tokens
    from kv_usage where task_id = ?
  `).get(taskIdValue)
  const chapterCount = databaseHandle.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(taskIdValue)?.count ?? 0
  const finalizationCount = databaseHandle.prepare("select count(*) count from turn_finalizations where task_id = ?").get(taskIdValue)?.count ?? 0
  return {
    task,
    checkpoint,
    chainCount: chains.length,
    chain: chains[0],
    phaseRows,
    completedPhaseCounts,
    kvCalls: usage.kv_calls,
    totalInputTokens: usage.total_input_tokens,
    totalOutputTokens: usage.total_output_tokens,
    chapterCount,
    finalizationCount,
  }
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
