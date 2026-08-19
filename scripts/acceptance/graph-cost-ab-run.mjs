import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import {
  chapterFiles,
  connectElectron,
  readActiveModel,
  runTurn,
} from "./lib/electron-backend.mjs"
import { auditPromptPrefix, auditStageProjectionProfiles } from "./lib/full-chain-audit.mjs"
import {
  auditTemporalContinuityCoverage,
  auditVerificationProbeCoverage,
} from "../../apps/backend/acceptance/lib/graph-audit.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Real graph cost A/B acceptance is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const logPath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_LOG"))
const outputPath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_AB_REPORT"))
const variant = requiredEnvironment("WORLDSEED_ACCEPTANCE_AB_VARIANT")
const pairId = requiredEnvironment("WORLDSEED_ACCEPTANCE_AB_PAIR")
const codeRevision = requiredEnvironment("WORLDSEED_ACCEPTANCE_CODE_REVISION")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const timeoutMs = positiveEnvironment("WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS", 7_200_000)
const maxRecoveries = positiveEnvironment("WORLDSEED_ACCEPTANCE_MAX_RECOVERIES", 4)
const auditTaskId = process.env.WORLDSEED_ACCEPTANCE_AB_AUDIT_TASK_ID?.trim()
const requiredGovernancePhases = [
  "graph_structure_plan",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
]
const governancePhases = new Set([
  ...requiredGovernancePhases,
  "graph_capacity_rewrite",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
])
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const { browser, page } = await connectElectron(cdpUrl, workspace)

try {
  const model = await readActiveModel(page)
  const report = auditTaskId === undefined
    ? await executeTurn({ model })
    : await auditCompletedTurn({ taskId: auditTaskId, model })
  await writeReport(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} catch (error) {
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    variant,
    pairId,
    codeRevision,
    projectId,
    workspace,
    error: errorValue(error),
  }
  await writeReport(report)
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} finally {
  database.close()
  await browser.close()
}

async function executeTurn(input) {
  const beforeFiles = await chapterFiles(workspace)
  const start = await startingIdentity(database, input.model, beforeFiles, workspace)
  const userInput = requestedUserInput(beforeFiles.length + 1)
  const startedAt = Date.now()
  const { handle, snapshot } = await runTurn(page, {
    projectId,
    workspaceRootRef: workspace,
    userInput,
    chapterSequence: beforeFiles.length + 1,
    presentation: { minimumWordCount: 2000, maximumWordCount: 3000 },
    model: input.model,
  }, {
    timeoutMs,
    autoRecover: true,
    maxRecoveries,
  })
  await waitForAutomaticHistory(database, handle.taskId, timeoutMs)
  return buildReport({
    taskId: handle.taskId,
    snapshot,
    model: input.model,
    userInput,
    start,
    beforeFiles,
    afterFiles: await chapterFiles(workspace),
    elapsedMs: Date.now() - startedAt,
  })
}

async function auditCompletedTurn(input) {
  const startDatabasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_AB_START_DB"))
  const startWorkspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_AB_START_WORKSPACE"))
  const startDatabase = new Database(startDatabasePath, { readonly: true, fileMustExist: true })
  try {
    const task = database.prepare("select status, created_at createdAt, updated_at updatedAt from tasks where id = ?").get(input.taskId)
    if (task === undefined) throw new Error(`Audit task does not exist: ${input.taskId}`)
    const beforeFiles = await chapterFiles(startWorkspace)
    const userInput = requestedUserInput(beforeFiles.length + 1)
    return buildReport({
      taskId: input.taskId,
      snapshot: { status: task.status },
      model: input.model,
      userInput,
      start: await startingIdentity(startDatabase, input.model, beforeFiles, startWorkspace),
      beforeFiles,
      afterFiles: await chapterFiles(workspace),
      elapsedMs: Number(task.updatedAt) - Number(task.createdAt),
    })
  } finally {
    startDatabase.close()
  }
}

function requestedUserInput(chapterSequence) {
  return process.env.WORLDSEED_ACCEPTANCE_AB_INPUT ?? [
    `继续推演第 ${String(chapterSequence)} 章。`,
    "严格继承当前时间、空间、历史演化、事物状态和未完成线索。",
    "在当前场景的既有时间锚点上推进到半小时后，让当前行动自然形成一个可观察、会改变至少一个既有事物当前状态的明确结果。",
    "资料未定义处做最小一致补全，不得因资料不足拒绝正文。",
    "只依赖当前单一上下文链、本轮真实读取的图与资料，以及本轮新形成内容。",
  ].join("\n")
}

async function buildReport(input) {
  const task = database.prepare("select id, status, last_phase lastPhase from tasks where id = ?").get(input.taskId)
  const finalizations = database.prepare(`
    select status, scope_id scopeId, source_id sourceId, chapter_sequence chapterSequence,
      chapter_path chapterPath, chapter_heading chapterHeading, content_digest contentDigest,
      model_calls modelCalls, input_tokens inputTokens, output_tokens outputTokens,
      kv_cache_hit_rate kvCacheHitRate, committed_sequence committedSequence
    from turn_finalizations where task_id = ?
  `).all(input.taskId)
  const finalization = finalizations[0]
  const automaticHistory = database.prepare(`
    select id, status, git_commit_oid gitCommitOid, manifest_digest manifestDigest,
      committed_sequence committedSequence
    from history_entries where task_id = ? and kind = 'automatic'
  `).all(input.taskId)
  const phaseRows = database.prepare(`
    select phase, status, count(*) count from phase_runs
    where task_id = ? group by phase, status order by phase, status
  `).all(input.taskId)
  const phaseUsage = database.prepare(`
    select phase_runs.phase phase,
      count(kv_usage.id) modelCalls,
      coalesce(sum(kv_usage.total_input_tokens), 0) inputTokens,
      coalesce(sum(kv_usage.output_tokens), 0) outputTokens,
      coalesce(sum(kv_usage.cache_hit_input_tokens), 0) cacheHitInputTokens,
      coalesce(sum(kv_usage.cache_miss_input_tokens), 0) cacheMissInputTokens,
      coalesce(sum(kv_usage.latency_ms), 0) latencyMs
    from kv_usage join phase_runs on phase_runs.id = kv_usage.phase_run_id
    where kv_usage.task_id = ? group by phase_runs.phase order by phase_runs.phase
  `).all(input.taskId)
  const graphRevisionCount = finalization === undefined ? 0 : database.prepare(
    "select count(*) count from graph_revisions where scope_id = ?",
  ).get(finalization.scopeId)?.count ?? 0
  const sourceUnitCount = finalization === undefined ? 0 : database.prepare(
    "select count(*) count from source_units where source_id = ?",
  ).get(finalization.sourceId)?.count ?? 0
  const chapterMessageCount = database.prepare(
    "select count(*) count from canonical_chapter_messages where task_id = ?",
  ).get(input.taskId)?.count ?? 0
  const logEvents = await readLogEvents(input.taskId)
  const requestProfiles = logEvents
    .filter((event) => event.event === "completion.prompt_profiled")
    .map((event) => ({
      phase: event.phase,
      totalCharacters: event.totalCharacters,
      commonPrefixCharacters: event.commonPrefixCharacters,
      commonPrefixRatio: event.commonPrefixRatio,
      modelRequestSections: event.modelRequestSections,
    }))
  const validationFailures = logEvents
    .filter((event) => event.event === "response.validation_failed")
    .map((event) => ({ phase: event.phase, repairAttempt: event.repairAttempt, message: event.error?.message }))
  const stageProjectionAudit = auditStageProjectionProfiles(logEvents, input.taskId)
  const temporalContinuityAudit = auditTemporalContinuityCoverage(database, input.taskId)
  const verificationProbeAudit = auditVerificationProbeCoverage(database, input.taskId)
  const promptPrefixAudit = auditPromptPrefix(logEvents, input.taskId, phaseRunStatusByEnvelopeId(logEvents))
  const graphGovernanceUsage = summarizeUsage(phaseUsage.filter((row) => governancePhases.has(row.phase)))
  const totalUsage = summarizeUsage(phaseUsage)
  const completedPhases = new Set(phaseRows
    .filter((row) => row.status === "completed")
    .map((row) => row.phase))
  const checks = [
    check("task_completed", task?.status === "completed" && input.snapshot.status === "completed", { task, snapshotStatus: input.snapshot.status }),
    check("single_finalization", finalizations.length === 1 && finalization?.status === "completed", finalizations),
    check("single_chapter_message", chapterMessageCount === 1 && input.afterFiles.length === input.beforeFiles.length + 1, { chapterMessageCount, beforeFiles: input.beforeFiles.length, afterFiles: input.afterFiles.length }),
    check("source_and_graph_committed", sourceUnitCount > 0 && graphRevisionCount > 0, { sourceUnitCount, graphRevisionCount }),
    check("automatic_history_ready", automaticHistory.length === 1 && automaticHistory[0]?.status === "ready", automaticHistory),
    check("staged_governance_completed", requiredGovernancePhases.every((phase) => completedPhases.has(phase)), { completedPhases: [...completedPhases] }),
    check("provider_usage_recorded", totalUsage.modelCalls > 0 && totalUsage.inputTokens > 0, totalUsage),
    ...(variant === "optimized" ? [
      check("stage_projection_audit", stageProjectionAudit.status === "pass"
        && Number(stageProjectionAudit.evidence?.deduplicatedEvidenceCharacters) > 0, stageProjectionAudit),
      check("temporal_continuity_audit", temporalContinuityAudit.passed
        && temporalContinuityAudit.claimRefs.length > 0, temporalContinuityAudit),
      check("byte_exact_prompt_prefix", promptPrefixAudit.status === "pass", promptPrefixAudit),
    ] : []),
  ]
  return {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    variant,
    pairId,
    codeRevision,
    projectId,
    workspace,
    model: modelIdentity(input.model),
    userInput: input.userInput,
    start: input.start,
    taskId: input.taskId,
    elapsedMs: input.elapsedMs,
    finalization,
    automaticHistory,
    phaseRows,
    phaseUsage,
    totalUsage,
    graphGovernanceUsage,
    requestProfiles,
    validationFailures,
    stageProjectionAudit,
    temporalContinuityAudit,
    verificationProbeAudit,
    promptPrefixAudit,
    graphRevisionCount,
    sourceUnitCount,
    checks,
  }
}

function phaseRunStatusByEnvelopeId(events) {
  const statuses = new Map()
  for (const event of events) {
    if (typeof event.envelopeId !== "string") continue
    if (event.event === "execution.completed") statuses.set(event.envelopeId, "completed")
    if (event.event === "execution.failed") statuses.set(event.envelopeId, "failed")
  }
  return statuses
}

async function startingIdentity(databaseHandle, model, chapters, workspaceRoot) {
  const historyState = databaseHandle.prepare(`
    select active_branch_id activeBranchId, selected_entry_id selectedEntryId
    from project_history_state where project_id = ?
  `).get(projectId)
  const selectedEntry = historyState?.selectedEntryId == null ? undefined : databaseHandle.prepare(`
    select id, git_commit_oid gitCommitOid, manifest_digest manifestDigest,
      committed_sequence committedSequence
    from history_entries where id = ?
  `).get(historyState.selectedEntryId)
  const settings = databaseHandle.prepare("select settings_json settingsJson from project_settings where project_id = ?").get(projectId)
  const chains = databaseHandle.prepare(`
    select id, message_count messageCount, token_estimate tokenEstimate
    from model_context_chains where project_id = ? order by id
  `).all(projectId)
  const messages = databaseHandle.prepare(`
    select chain_id chainId, sequence_no sequenceNo, content_digest contentDigest, hidden_at hiddenAt
    from model_context_messages where project_id = ? order by chain_id, sequence_no
  `).all(projectId)
  return {
    historyState,
    selectedEntry,
    projectSettingsDigest: digest(settings?.settingsJson ?? ""),
    contextDigest: digest(JSON.stringify({ chains, messages })),
    workspaceDigest: await markdownDigest(workspaceRoot),
    chapterCount: chapters.length,
    model: modelIdentity(model),
  }
}

async function markdownDigest(root) {
  const files = (await walk(root)).filter((path) => path.toLowerCase().endsWith(".md")).sort()
  const records = []
  for (const path of files) {
    records.push({ path: relative(root, path).replaceAll("\\", "/"), digest: digest(await readFile(path)) })
  }
  return digest(JSON.stringify(records))
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return nested.flat()
}

async function readLogEvents(taskId) {
  const content = await readFile(logPath, "utf8")
  return content.split(/\r?\n/u).flatMap((line) => {
    const start = line.indexOf("{")
    if (start < 0) return []
    try {
      const event = JSON.parse(line.slice(start))
      return event.taskId === taskId ? [event] : []
    } catch {
      return []
    }
  })
}

async function waitForAutomaticHistory(databaseHandle, taskId, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const entry = databaseHandle.prepare(`
      select status from history_entries where task_id = ? and kind = 'automatic'
      order by created_at desc limit 1
    `).get(taskId)
    if (entry?.status === "ready") return
    if (entry?.status === "failed") throw new Error(`Automatic history failed for task ${taskId}`)
    await delay(1_000)
  }
  throw new Error(`Automatic history did not complete for task ${taskId}`)
}

function summarizeUsage(rows) {
  const result = rows.reduce((summary, row) => ({
    modelCalls: summary.modelCalls + Number(row.modelCalls),
    inputTokens: summary.inputTokens + Number(row.inputTokens),
    outputTokens: summary.outputTokens + Number(row.outputTokens),
    cacheHitInputTokens: summary.cacheHitInputTokens + Number(row.cacheHitInputTokens),
    cacheMissInputTokens: summary.cacheMissInputTokens + Number(row.cacheMissInputTokens),
    latencyMs: summary.latencyMs + Number(row.latencyMs),
  }), {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    latencyMs: 0,
  })
  const cacheDenominator = result.cacheHitInputTokens + result.cacheMissInputTokens
  return {
    ...result,
    kvCacheHitRate: cacheDenominator === 0 ? null : result.cacheHitInputTokens / cacheDenominator,
  }
}

function modelIdentity(model) {
  return {
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    model: model.model,
    contextWindowTokens: model.contextWindowTokens,
    thinkingModeEnabled: model.thinkingModeEnabled,
    reasoningEffort: model.reasoningEffort,
    jsonModeEnabled: model.jsonModeEnabled,
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
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

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
