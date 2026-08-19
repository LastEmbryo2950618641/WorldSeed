import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import {
  chapterFiles,
  connectElectron,
  invokeBackend,
  readActiveModel,
  runQuery,
  runTurn,
  waitForTask,
} from "./lib/electron-backend.mjs"
import {
  auditAutomaticEvolution,
  auditCompletedTurn as auditStoredCompletedTurn,
  auditStageProjectionProfiles,
  collectTrackedIncompleteTasks,
} from "./lib/full-chain-audit.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Full-chain DeepSeek acceptance is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const targetChapters = readPositiveArgument("--target-chapters", 20)
const turnTimeoutMs = readPositiveEnvironment("WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS", 7_200_000)
const evolutionTimeoutMs = readPositiveEnvironment("WORLDSEED_ACCEPTANCE_EVOLUTION_TIMEOUT_MS", 3_600_000)
const requireAutomaticEvolution = process.env.WORLDSEED_ACCEPTANCE_REQUIRE_AUTO_EVOLUTION !== "0"
const minimumEffectiveKvRate = readRatioEnvironment("WORLDSEED_ACCEPTANCE_MIN_EFFECTIVE_KV", 0.95)
const minimumRecentKvRate = readRatioEnvironment("WORLDSEED_ACCEPTANCE_MIN_RECENT_KV", 0.98)
const reportPath = resolve(process.env.WORLDSEED_ACCEPTANCE_FULL_REPORT ?? ".worldseed-data/acceptance/current/full-chain.json")
const logPath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_LOG"))
const queryCheckpoints = new Set([10, 20, targetChapters].filter((value) => value <= targetChapters))
const auditOnly = process.argv.includes("--audit-only")
const existingReport = auditOnly ? await readAuditReport(reportPath) : await readExistingReport(reportPath)
if (auditOnly && existingReport === undefined) {
  throw new Error(`No compatible full-chain report exists for audit: ${reportPath}`)
}
const report = existingReport ?? {
  startedAt: new Date().toISOString(),
  status: "running",
  workspace,
  databasePath,
  projectId,
  cdpUrl,
  targetChapters,
  requireAutomaticEvolution,
  logPath,
  turns: [],
  queries: [],
  automaticEvolutions: [],
  checks: [],
}
let resumeTaskId = process.env.WORLDSEED_ACCEPTANCE_RESUME_TASK_ID ?? report.resumableTaskId
report.status = "running"
delete report.error
delete report.completedAt

const database = new Database(databasePath, { readonly: true, fileMustExist: true })
if (auditOnly) {
  try {
    report.checks = finalMechanicalChecks(database, projectId, targetChapters, report)
    report.status = report.checks.every((check) => check.status === "pass") ? "pass" : "fail"
    report.completedAt = new Date().toISOString()
    await persistReport(reportPath, report)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.status === "pass" ? 0 : 1
  } finally {
    database.close()
  }
} else {
  const { browser, page } = await connectElectron(cdpUrl, workspace)
  try {
  const model = await readActiveModel(page)
  report.model = { id: model.id, name: model.name, model: model.model, contextWindowTokens: model.contextWindowTokens }
  const initialChapters = await chapterFiles(workspace)
  report.initialChapterCount ??= initialChapters.length
  const firstChapter = await readOldestChapter(workspace)

  for (const turn of report.turns) {
    turn.mechanical = auditCompletedTurn(database, turn.taskId, turn.chapterSequence)
  }
  if (resumeTaskId !== undefined) {
    const resumableTask = database.prepare("select id, kind, status, config_snapshot_json from tasks where id = ?").get(resumeTaskId)
    if (resumableTask?.kind === "evolution") {
      const origin = parseObject(resumableTask.config_snapshot_json)?.executionOrigin
      const triggerTaskId = origin?.kind === "automatic_evolution" && typeof origin.triggerTaskId === "string"
        ? origin.triggerTaskId
        : undefined
      if (triggerTaskId === undefined) throw new Error(`Evolution task ${resumeTaskId} has no automatic trigger task`)
      const evolution = await resumeExistingEvolution(page, database, resumeTaskId, triggerTaskId, model, evolutionTimeoutMs)
      report.automaticEvolutions = report.automaticEvolutions.filter((item) => item.taskId !== evolution.taskId)
      report.automaticEvolutions.push(evolution)
      resumeTaskId = undefined
      delete report.resumableTaskId
      await persistReport(reportPath, report)
    }
  }

  while ((await chapterFiles(workspace)).length < targetChapters) {
    const before = await chapterFiles(workspace)
    const chapterSequence = before.length + 1
    const prompt = buildTurnPrompt(chapterSequence, firstChapter.heading)
    const beforeTaskMarker = newestTaskMarker(database)
    const turnStartedAt = Date.now()
    const { handle, snapshot } = resumeTaskId === undefined
      ? await runTurn(page, {
          projectId,
          workspaceRootRef: workspace,
          userInput: prompt,
          chapterSequence,
          presentation: { minimumWordCount: 2000, maximumWordCount: 3000 },
          model,
        }, { timeoutMs: turnTimeoutMs, autoRecover: true })
      : await resumeExistingTurn(page, resumeTaskId, model)
    resumeTaskId = undefined
    delete report.resumableTaskId
    const after = await chapterFiles(workspace)
    const newChapter = after.find((file) => !before.includes(file))
    if (newChapter === undefined) throw new Error(`Turn ${handle.taskId} completed without publishing exactly one new chapter`)
    const mechanical = auditCompletedTurn(database, handle.taskId, before.length + 1)
    report.turns.push({
      chapterSequence,
      taskId: handle.taskId,
      prompt,
      chapterFile: newChapter,
      elapsedMs: Date.now() - turnStartedAt,
      result: snapshot.result,
      mechanical,
    })
    await persistReport(reportPath, report)

    if (requireAutomaticEvolution) {
      const evolution = await waitForAutomaticEvolution(page, database, beforeTaskMarker, handle.taskId, model, evolutionTimeoutMs)
      report.automaticEvolutions.push(evolution)
      await persistReport(reportPath, report)
    }

    await runPendingHistoricalQueries(page, model, firstChapter, chapterSequence)
  }

  report.checks = finalMechanicalChecks(database, projectId, targetChapters, report)
  report.status = report.checks.every((check) => check.status === "pass") ? "pass" : "fail"
  report.completedAt = new Date().toISOString()
  await persistReport(reportPath, report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
  } catch (error) {
    const resumableTaskId = taskIdFromError(error)
    const resumableTask = resumableTaskId === undefined
      ? undefined
      : database.prepare("select status from tasks where id = ?").get(resumableTaskId)
    const paused = resumableTask?.status === "awaiting_user_decision" || resumableTask?.status === "paused"
    report.status = paused ? "paused" : "fail"
    if (paused) report.resumableTaskId = resumableTaskId
    report.completedAt = new Date().toISOString()
    report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
    await persistReport(reportPath, report)
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = paused ? 2 : 1
  } finally {
    database.close()
    await browser.close()
  }
}

async function resumeExistingTurn(page, taskId, model) {
  const resumedTaskId = await restoreStaleGenerationTask(page, taskId)
  const current = await invokeBackend(page, "turn.status", { taskId: resumedTaskId })
  if (current.status === "paused" || current.status === "awaiting_user_decision") {
    await invokeBackend(page, "turn.resume", {
      taskId: resumedTaskId,
      mode: "continue",
      resetMetricIds: [],
      model,
    })
  } else if (current.status !== "created" && current.status !== "running" && current.status !== "committing") {
    throw new Error(`Task ${resumedTaskId} cannot be resumed from status ${current.status}`)
  }
  const snapshot = await waitForTask(page, resumedTaskId, { timeoutMs: turnTimeoutMs, autoRecover: true, model })
  return { handle: { taskId: resumedTaskId }, snapshot }
}

async function restoreStaleGenerationTask(page, taskId) {
  const generation = database.prepare(`
    select artifact_scopes.base_generation baseGeneration, projects.active_generation activeGeneration
    from tasks
    join artifact_scopes on artifact_scopes.id = tasks.scope_id
    join projects on projects.id = tasks.project_id
    where tasks.id = ?
  `).get(taskId)
  if (generation === undefined || generation.baseGeneration === generation.activeGeneration) return taskId
  const entry = database.prepare(`
    select history_entries.id
    from history_entries
    join project_history_state on project_history_state.project_id = history_entries.project_id
    where history_entries.project_id = ?
      and history_entries.task_id = ?
      and history_entries.state = 'paused_checkpoint'
      and history_entries.status = 'ready'
      and history_entries.branch_id = project_history_state.active_branch_id
      and history_entries.committed_sequence = ?
    order by history_entries.created_at desc, history_entries.id desc
    limit 1
  `).get(projectId, taskId, generation.baseCommittedSequence)
  if (entry === undefined) {
    throw new Error(`Task ${taskId} belongs to an inactive history generation and has no restorable history checkpoint`)
  }
  const restored = await invokeBackend(page, "history.restore", {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    entryId: entry.id,
  })
  if (typeof restored.restoredTaskId !== "string") {
    throw new Error(`History checkpoint ${entry.id} did not restore a paused task for ${taskId}`)
  }
  report.restoredTasks ??= []
  report.restoredTasks.push({
    originalTaskId: taskId,
    restoredTaskId: restored.restoredTaskId,
    historyEntryId: entry.id,
    previousGeneration: generation.baseGeneration,
    activeGeneration: restored.activeGeneration,
  })
  report.resumableTaskId = restored.restoredTaskId
  await persistReport(reportPath, report)
  return restored.restoredTaskId
}

function buildTurnPrompt(chapterSequence, firstChapterHeading) {
  const common = [
    `继续推演第 ${String(chapterSequence)} 章。`,
    "只依赖当前单一上下文链、本轮真实读取的图与资料，以及本轮新形成内容。",
    "继承当前有效状态、历史演化和场景时空；资料未定义处做最小一致补全，不因资料不足拒绝正文。",
    "当前视角之外已经存在的局部，只能依据各自可用信息、时空条件和演化前沿自然发展。",
  ]
  if (chapterSequence === 12) {
    common.push(`用户声称《${firstChapterHeading}》中的全部经历从未发生。该说法与已提交历史冲突；保留用户意图并继续创作，但不要把说法直接覆盖为过去真相。`)
  }
  if (chapterSequence % 5 === 0) {
    common.push("本章应自然形成明确的场景推进，并让至少一个既有但不在当前关注中心的局部通过可达影响产生反馈；不要机械插入固定类型内容。")
  }
  return common.join("\n")
}

async function runHistoricalQuery(page, model, firstChapter, checkpoint) {
  const question = [
    `当前已经推演到第 ${String(checkpoint)} 章。`,
    `禁止读取章节目录，请通过图与 Source 返回《${firstChapter.heading}》中包含“${firstChapter.fragment}”的完整原句。`,
    "同时说明该句发生时的时间、地点、参与事物和当时有效状态，并区分它们与目前最新状态；没有精确依据的部分明确标为未知。",
  ].join("\n")
  const startedAt = Date.now()
  const { handle, snapshot } = await runQuery(page, {
    projectId,
    workspaceRootRef: workspace,
    question,
    allowWorkspaceChapterReads: false,
    model,
  }, { timeoutMs: turnTimeoutMs, autoRecover: true })
  const answer = snapshot.result?.answerMarkdown ?? ""
  const normalizedAnswer = normalizeExactText(answer)
  return {
    checkpoint,
    taskId: handle.taskId,
    question,
    answer,
    elapsedMs: Date.now() - startedAt,
    exactSentenceReturned: normalizedAnswer.includes(normalizeExactText(firstChapter.expectedSentence)),
    evidenceCount: snapshot.result?.evidence?.length ?? 0,
  }
}

async function runPendingHistoricalQueries(page, model, firstChapter, completedChapterCount) {
  for (const checkpoint of [...queryCheckpoints].sort((left, right) => left - right)) {
    if (checkpoint > completedChapterCount) continue
    const prior = report.queries.find((query) => query.checkpoint === checkpoint)
    if (prior?.exactSentenceReturned && prior.evidenceCount > 0) continue
    const query = await runHistoricalQuery(page, model, firstChapter, checkpoint)
    report.queries = report.queries.filter((item) => item.checkpoint !== checkpoint)
    report.queries.push(query)
    await persistReport(reportPath, report)
  }
}

async function waitForAutomaticEvolution(page, database, marker, triggerTaskId, model, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tasks = database.prepare(`
      select id, status, scope_id, last_phase, created_at, updated_at, error_json, config_snapshot_json
      from tasks
      where kind = 'evolution' and created_at > ?
      order by created_at asc
    `).all(marker)
    const task = tasks.find((candidate) => {
      const origin = parseObject(candidate.config_snapshot_json)?.executionOrigin
      return origin?.kind === "automatic_evolution" && origin.triggerTaskId === triggerTaskId
    })
    if (task !== undefined) {
      return resumeExistingEvolution(page, database, task.id, triggerTaskId, model, Math.max(1, deadline - Date.now()))
    }
    await delay(2_000)
  }
  throw new Error(`No completed automatic world evolution followed turn ${triggerTaskId} within ${String(timeoutMs)} ms`)
}

async function resumeExistingEvolution(page, database, taskId, triggerTaskId, model, timeoutMs) {
  const current = await invokeBackend(page, "turn.status", { taskId })
  if (current.status === "paused" || current.status === "awaiting_user_decision") {
    await invokeBackend(page, "turn.resume", {
      taskId,
      mode: "continue",
      resetMetricIds: [],
      model,
    })
  } else if (current.status !== "created" && current.status !== "running" && current.status !== "committing" && current.status !== "completed") {
    throw new Error(`Automatic evolution ${taskId} cannot be resumed from status ${current.status}`)
  }
  const snapshot = current.status === "completed"
    ? current
    : await waitForTask(page, taskId, { timeoutMs, autoRecover: true, model })
  const stored = database.prepare(`
    select id, status, scope_id, last_phase, created_at, updated_at, error_json, config_snapshot_json
    from tasks where id = ?
  `).get(taskId)
  if (stored?.status !== "completed") throw new Error(`Automatic evolution ${taskId} did not reach completed status`)
  const mutations = database.prepare("select count(*) count from graph_revisions where scope_id = ?").get(stored.scope_id)?.count ?? 0
  const chapters = database.prepare("select count(*) count from canonical_chapter_messages where task_id = ?").get(stored.id)?.count ?? 0
  const kv = auditTaskKv(database, stored.id)
  return {
    triggerTaskId,
    taskId: stored.id,
    status: stored.status,
    lastPhase: stored.last_phase,
    createdAtMs: stored.created_at,
    completedAtMs: stored.updated_at,
    graphRevisionCount: mutations,
    canonicalChapterCount: chapters,
    result: snapshot.result,
    kv,
  }
}

function auditCompletedTurn(database, taskId, expectedChapterCount) {
  return auditCompletedTurnResult(database, taskId, expectedChapterCount)
}

function finalMechanicalChecks(database, currentProjectId, minimumChapters, currentReport) {
  for (const turn of currentReport.turns) {
    turn.mechanical = auditCompletedTurnResult(database, turn.taskId, turn.chapterSequence)
  }
  for (const evolution of currentReport.automaticEvolutions) {
    evolution.mechanical = auditAutomaticEvolution(database, evolution, auditTaskKv)
  }
  const chapterCount = database.prepare("select count(*) count from canonical_chapter_messages").get()?.count ?? 0
  const chainCount = database.prepare("select count(*) count from model_context_chains where project_id = ?").get(currentProjectId)?.count ?? 0
  const trackedTaskIds = [
    ...currentReport.turns.map((turn) => turn.taskId),
    ...currentReport.automaticEvolutions.map((evolution) => evolution.taskId),
    ...currentReport.queries.map((query) => query.taskId),
  ]
  const incompleteTasks = collectTrackedIncompleteTasks(database, trackedTaskIds)
  const queryFailures = currentReport.queries.filter((query) => !query.exactSentenceReturned || query.evidenceCount === 0)
  const invalidEvolution = currentReport.automaticEvolutions.filter((evolution) => !evolution.mechanical.passed)
  const invalidTurnKv = currentReport.turns.filter((turn) => !turn.mechanical.kv?.passed)
  const runtimeEvents = readRuntimeEventsSync(logPath)
  const stageProjectionAudits = currentReport.turns.map((turn) => auditStageProjectionProfiles(runtimeEvents, turn.taskId))
  for (const [index, turn] of currentReport.turns.entries()) {
    turn.stageProjectionAudit = stageProjectionAudits[index]
  }
  return [
    check("minimum_long_run_chapters", chapterCount >= minimumChapters, { chapterCount, minimumChapters }),
    check("single_context_chain", chainCount === 1, { chainCount }),
    check("single_chain_high_kv", invalidTurnKv.length === 0, { invalidTurnKv: invalidTurnKv.map((turn) => turn.taskId) }),
    check("stage_projection_profiles", stageProjectionAudits.every((audit) => audit.status === "pass"), { audits: stageProjectionAudits }),
    check("all_recorded_turns_closed", currentReport.turns.every((turn) => turn.mechanical.passed), { turns: currentReport.turns.length }),
    check("historical_source_queries", queryFailures.length === 0 && currentReport.queries.length === queryCheckpoints.size, { queryCount: currentReport.queries.length, failures: queryFailures }),
    check("automatic_background_evolution", !requireAutomaticEvolution || (invalidEvolution.length === 0 && hasOneEvolutionPerTurn(currentReport)), { evolutionCount: currentReport.automaticEvolutions.length, invalidEvolution }),
    check("no_incomplete_tasks", incompleteTasks.length === 0, { incompleteTasks }),
  ]
}

function readRuntimeEventsSync(path) {
  const content = require("node:fs").readFileSync(path, "utf8")
  return content.split(/\r?\n/u).flatMap((line) => {
    const start = line.indexOf("{")
    if (start < 0) return []
    try { return [JSON.parse(line.slice(start))] } catch { return [] }
  })
}

function auditCompletedTurnResult(database, taskId, expectedChapterSequence) {
  return auditStoredCompletedTurn(database, taskId, expectedChapterSequence, auditTaskKv)
}

function hasOneEvolutionPerTurn(currentReport) {
  if (currentReport.automaticEvolutions.length !== currentReport.turns.length) return false
  const triggerCounts = new Map()
  for (const evolution of currentReport.automaticEvolutions) {
    triggerCounts.set(evolution.triggerTaskId, (triggerCounts.get(evolution.triggerTaskId) ?? 0) + 1)
  }
  return currentReport.turns.every((turn) => triggerCounts.get(turn.taskId) === 1)
}

function auditTaskKv(database, taskId) {
  const rows = database.prepare(`
    select total_input_tokens, cache_hit_input_tokens, cache_miss_input_tokens
    from kv_usage where task_id = ? order by created_at, id
  `).all(taskId)
  if (rows.length < 2) return { passed: false, reason: "fewer_than_two_model_calls", calls: rows.length }
  const effectiveRates = rows.slice(1).map((row, index) => {
    const previous = rows[index]
    const reusablePrefixTokens = Math.min(previous.total_input_tokens, row.total_input_tokens)
    const cacheHitTokens = Math.min(Number(row.cache_hit_input_tokens ?? 0), reusablePrefixTokens)
    return reusablePrefixTokens === 0 ? 0 : cacheHitTokens / reusablePrefixTokens
  })
  const average = averageOf(effectiveRates)
  const recentAverage = averageOf(effectiveRates.slice(-3))
  return {
    passed: average >= minimumEffectiveKvRate && recentAverage >= minimumRecentKvRate,
    calls: rows.length,
    average,
    recentAverage,
    minimumEffectiveKvRate,
    minimumRecentKvRate,
  }
}

async function readOldestChapter(workspaceRoot) {
  const files = await chapterFiles(workspaceRoot)
  const file = files.find((candidate) => candidate.startsWith("第一章")) ?? files[0]
  if (file === undefined) throw new Error("Long-run validation requires at least one committed chapter")
  const content = await readFile(join(workspaceRoot, "章节正文", file), "utf8")
  const lines = content.split(/\r?\n/u)
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0)
  const firstLine = firstContentLine < 0 ? "" : lines[firstContentLine].trim()
  const heading = (/^#\s+(.+)$/u.exec(firstLine)?.[1] ?? firstLine).trim() || file.replace(/\.md$/u, "")
  const body = lines.slice(firstContentLine < 0 ? 0 : firstContentLine + 1).join("\n").replace(/\s+/gu, "").trim()
  const expectedSentence = selectSentence(body)
  const fragment = selectFragment(expectedSentence)
  return { file, heading, fragment, expectedSentence }
}

function selectSentence(content) {
  const sentences = content.match(/[^。！？]+[。！？]?/gu)?.map((value) => value.trim()).filter((value) => value.length >= 18) ?? []
  const sentence = sentences.find((value) => value.length <= 81) ?? sentences[0]
  if (sentence === undefined) throw new Error("The first chapter has no stable sentence fragment for exact recall")
  return sentence
}

function selectFragment(sentence) {
  const content = sentence.replace(/[。！？]$/u, "")
  const start = Math.max(0, Math.floor((content.length - 24) / 2))
  return content.slice(start, start + 24)
}

function normalizeExactText(content) {
  return content.replace(/\s+/gu, "")
}

function newestTaskMarker(database) {
  return database.prepare("select coalesce(max(created_at), 0) marker from tasks").get()?.marker ?? 0
}

function parseObject(value) {
  if (typeof value !== "string") return undefined
  try { const parsed = JSON.parse(value); return typeof parsed === "object" && parsed !== null ? parsed : undefined } catch { return undefined }
}

function averageOf(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

async function persistReport(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function readExistingReport(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    if (parsed.workspace !== workspace || parsed.targetChapters !== targetChapters) return undefined
    if (parsed.status === "running" || parsed.status === "paused") return parsed
    const resumableTaskId = taskIdFromError(parsed.error)
    return parsed.status === "fail" && resumableTaskId !== undefined
      ? { ...parsed, status: "paused", resumableTaskId }
      : undefined
  } catch {
    return undefined
  }
}

async function readAuditReport(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    return parsed.workspace === workspace && parsed.targetChapters === targetChapters ? parsed : undefined
  } catch {
    return undefined
  }
}

function taskIdFromError(error) {
  const message = error instanceof Error
    ? error.message
    : typeof error?.message === "string" ? error.message : String(error ?? "")
  return /Turn ([0-9a-f-]{36}) completed without publishing/iu.exec(message)?.[1]
    ?? /Task ([0-9a-f-]{36}) (?:paused|exceeded|ended|did not complete)/iu.exec(message)?.[1]
}

function readPositiveArgument(name, fallback) {
  const index = process.argv.indexOf(name)
  const value = Number(index < 0 ? fallback : process.argv[index + 1])
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function readPositiveEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function readRatioEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
