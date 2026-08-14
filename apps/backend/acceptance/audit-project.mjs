import { existsSync, readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"

import Database from "better-sqlite3"
import { auditPhaseCompletion, auditPromptPrefix } from "../../../scripts/acceptance/lib/full-chain-audit.mjs"
import { auditVerificationProbeCoverage } from "./lib/graph-audit.mjs"
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const logPath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_LOG"))
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_AUDIT_REPORT ?? ".worldseed-data/acceptance/current/audit.json")
const minimumChapters = readPositiveInteger("WORLDSEED_ACCEPTANCE_MIN_CHAPTERS", 20)
const minimumEffectiveKvRate = readRatio("WORLDSEED_ACCEPTANCE_MIN_EFFECTIVE_KV", 0.95)
const minimumRecentKvRate = readRatio("WORLDSEED_ACCEPTANCE_MIN_RECENT_KV", 0.98)

const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const project = database.prepare("select id, name from projects order by created_at desc limit 1").get()
if (project === undefined) throw new Error("Acceptance database contains no project")
const selectedTask = selectTask(database, process.env.WORLDSEED_ACCEPTANCE_TASK_ID)
const checks = []

checks.push(check("completed_turn_exists", selectedTask?.status === "completed", selectedTask ?? null))
checks.push(checkPhaseCompletion(database, selectedTask?.id))
checks.push(checkFinalization(database, selectedTask?.id, workspace))
checks.push(checkGraph(database, selectedTask?.id))
checks.push(checkGraphCapacity(database, project.id))
checks.push(checkGraphArchiveOutlets(database, project.id))
checks.push(checkWorkspaceIsolation(database, project.id, workspace))
checks.push(checkContextChain(database, project.id))
checks.push(checkIds(database, project.id))
checks.push(checkHistory(database, selectedTask?.id))
checks.push(checkLongRun(database, minimumChapters))
checks.push(checkBackgroundEvolution(database))

const runtimeEvents = await readRuntimeEvents(logPath)
checks.push(checkPromptPrefix(database, runtimeEvents, selectedTask?.id))
checks.push(checkPromptRoles(runtimeEvents, selectedTask?.id))
checks.push(checkKv(database, runtimeEvents, selectedTask?.id, minimumEffectiveKvRate, minimumRecentKvRate))

const report = {
  generatedAt: new Date().toISOString(),
  databasePath,
  workspace,
  logPath,
  project,
  selectedTask: selectedTask ?? null,
  thresholds: { minimumChapters, minimumEffectiveKvRate, minimumRecentKvRate },
  checks,
  summary: summarize(checks),
}
database.close()
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exitCode = report.summary.fail > 0 || report.summary.not_implemented > 0 || report.summary.insufficient > 0 ? 1 : 0

function selectTask(database, taskId) {
  if (taskId !== undefined) return database.prepare("select * from tasks where id = ?").get(taskId)
  return database.prepare("select * from tasks where kind = 'turn' order by created_at desc limit 1").get()
}

function checkPhaseCompletion(database, taskId) {
  if (taskId === undefined) return result("all_turn_phases_completed", "insufficient", "No completed turn task is available")
  const task = database.prepare("select kind from tasks where id = ?").get(taskId)
  const rows = database.prepare("select phase, attempt, status from phase_runs where task_id = ? order by started_at, id").all(taskId)
  return auditPhaseCompletion(task?.kind, rows)
}

function checkFinalization(database, taskId, workspaceRoot) {
  if (taskId === undefined) return result("chapter_finalization_complete", "insufficient", "No completed turn task is available")
  const finalizations = database.prepare("select * from turn_finalizations where task_id = ?").all(taskId)
  const chapters = database.prepare("select * from canonical_chapter_messages where task_id = ?").all(taskId)
  const finalization = finalizations[0]
  const chapter = chapters[0]
  const chapterPath = chapter === undefined ? undefined : resolve(workspaceRoot, chapter.chapter_path.replaceAll("/", "\\"))
  const passed = finalizations.length === 1
    && finalization.status === "completed"
    && chapters.length === 1
    && chapterPath !== undefined
    && existsSync(chapterPath)
  return result("chapter_finalization_complete", passed ? "pass" : "fail", {
    finalizationCount: finalizations.length,
    finalizationStatus: finalization?.status,
    chapterCount: chapters.length,
    chapterPath,
  })
}

function checkGraph(database, taskId) {
  if (taskId === undefined) return result("graph_governance_committed", "insufficient", "No completed turn task is available")
  const finalization = database.prepare("select graph_anchor_ids_json from turn_finalizations where task_id = ?").get(taskId)
  const anchors = parseJsonArray(finalization?.graph_anchor_ids_json)
  const nodeCount = database.prepare("select count(*) count from node_heads where visibility = 'committed'").get().count
  const linkCount = database.prepare("select count(*) count from link_heads where visibility = 'committed'").get().count
  const probeCoverage = auditVerificationProbeCoverage(database, taskId)
  const sourceUnits = database.prepare("select count(*) count from source_units").get().count
  const frontiers = database.prepare("select count(*) count from frontier_refs").get().count
  return result("graph_governance_committed", anchors.length > 0 && nodeCount > 0 && linkCount > 0 && probeCoverage.passed && sourceUnits > 0 && frontiers > 0 ? "pass" : "fail", {
    anchors: anchors.length,
    nodeCount,
    linkCount,
    probes: probeCoverage.probeIndexes.length,
    probeCoverage,
    sourceUnits,
    frontiers,
  })
}

function checkGraphCapacity(database, projectId) {
  const settingsRow = database.prepare("select settings_json from project_settings where project_id = ?").get(projectId)
  const settings = parseJsonObject(settingsRow?.settings_json)
  const maxOut = settings?.graph?.maxDirectOutDegree
  const maxIn = settings?.graph?.maxDirectInDegree
  if (!Number.isInteger(maxOut) || !Number.isInteger(maxIn)) return result("graph_capacity_limits", "insufficient", { settings: settingsRow?.settings_json })
  const links = database.prepare(`
    select heads.link_id, versions.from_node_id, versions.to_node_id
    from link_heads heads
    join links versions
      on versions.id = heads.link_id
      and versions.revision_id = heads.revision_id
    where heads.project_id = ? and heads.visibility = 'committed'
  `).all(projectId)
  const out = countBy(links, "from_node_id")
  const incoming = countBy(links, "to_node_id")
  const violations = [...new Set([
    ...out.filter((row) => row.count > maxOut).map((row) => ({ direction: "out", nodeId: row.nodeId, count: row.count, limit: maxOut })),
    ...incoming.filter((row) => row.count > maxIn).map((row) => ({ direction: "in", nodeId: row.nodeId, count: row.count, limit: maxIn })),
  ].map((row) => JSON.stringify(row)))].map((row) => JSON.parse(row))
  return result("graph_capacity_limits", violations.length === 0 ? "pass" : "fail", {
    maxDirectOutDegree: maxOut,
    maxDirectInDegree: maxIn,
    committedLinkCount: links.length,
    topOutDegree: out.slice(0, 10),
    topInDegree: incoming.slice(0, 10),
    violations,
  })
}

function checkGraphArchiveOutlets(database, projectId) {
  const retired = database.prepare(`
    select id, target_kind, target_id, archive_outlet_ids_json
    from graph_revisions
    where project_id = ? and operation = 'retire'
    order by created_at, id
  `).all(projectId)
  const knownObjects = new Set([
    ...database.prepare("select distinct id from nodes where project_id = ?").all(projectId).map((row) => row.id),
    ...database.prepare("select distinct id from links where project_id = ?").all(projectId).map((row) => row.id),
  ])
  const invalid = retired.flatMap((revision) => {
    const outlets = parseJsonArray(revision.archive_outlet_ids_json)
    const missing = outlets.filter((outletId) => !knownObjects.has(outletId))
    return outlets.length > 0 && missing.length === 0 ? [] : [{
      revisionId: revision.id,
      targetKind: revision.target_kind,
      targetId: revision.target_id,
      outlets,
      missing,
    }]
  })
  return result("graph_archive_outlets", invalid.length === 0 ? "pass" : "fail", {
    retiredRevisionCount: retired.length,
    invalid,
  })
}

function checkWorkspaceIsolation(database, projectId, workspaceRoot) {
  const entries = existsSync(workspaceRoot) ? walkWorkspace(workspaceRoot) : []
  const forbidden = entries.filter((entry) => (
    entry.relativePath === ".git"
    || entry.relativePath.toLowerCase().endsWith(".sqlite")
    || entry.relativePath.toLowerCase().endsWith(".db")
    || entry.relativePath.toLowerCase().includes("internal")
  ))
  const project = database.prepare("select id from projects where id = ?").get(projectId)
  return result("workspace_internal_storage_isolation", project !== undefined && forbidden.length === 0 ? "pass" : "fail", {
    workspaceRoot,
    forbidden,
    internalProjectExists: project !== undefined,
  })
}

function countBy(rows, field) {
  const counts = new Map()
  for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1)
  return [...counts].map(([nodeId, count]) => ({ nodeId, count })).sort((left, right) => right.count - left.count)
}

function walkWorkspace(root) {
  const result = []
  function visit(directory, relativeDirectory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`
      result.push({ relativePath, kind: entry.isDirectory() ? "directory" : "file" })
      if (entry.isDirectory()) visit(resolve(directory, entry.name), relativePath)
    }
  }
  visit(root, "")
  return result
}

function checkContextChain(database, projectId) {
  const chains = database.prepare("select * from model_context_chains where project_id = ?").all(projectId)
  if (chains.length !== 1) return result("single_append_only_context_chain", "fail", { chainCount: chains.length })
  const chain = chains[0]
  const messages = database.prepare("select * from model_context_messages where chain_id = ? order by sequence_no").all(chain.id)
  const visibleMessages = messages.filter((message) => message.hidden_at === null)
  const sequencesAreContinuous = messages.every((message, index) => message.sequence_no === index)
  const fullTokenEstimate = messages.reduce((total, message) => total + message.token_estimate, 0)
  const visibleTokenEstimate = visibleMessages.reduce((total, message) => total + message.token_estimate, 0)
  const systemRules = messages.filter((message) => message.kind === "system_rules")
  return result("single_append_only_context_chain", sequencesAreContinuous
    && chain.message_count === messages.length
    && chain.token_estimate === visibleTokenEstimate
    && systemRules.length === 1 ? "pass" : "fail", {
    chainId: chain.id,
    chainMessageCount: chain.message_count,
    actualMessageCount: messages.length,
    chainTokenEstimate: chain.token_estimate,
    visibleTokenEstimate,
    fullTokenEstimate,
    systemRuleCount: systemRules.length,
    visibleMessages: visibleMessages.length,
    hiddenMessages: messages.length - visibleMessages.length,
    sequencesAreContinuous,
  })
}

function checkIds(database, projectId) {
  const counters = new Map(database.prepare("select prefix, current_value from id_counters where project_id = ?").all(projectId).map((row) => [row.prefix, row.current_value]))
  const sources = {
    node: database.prepare("select id from nodes where project_id = ?").all(projectId),
    link: database.prepare("select id from links where project_id = ?").all(projectId),
    evidence: database.prepare("select id from evidence_objects where project_id = ?").all(projectId),
    source: database.prepare("select distinct source_id id from source_units where project_id = ?").all(projectId),
    revision: database.prepare("select id from graph_revisions where project_id = ?").all(projectId),
  }
  const details = Object.fromEntries(Object.entries(sources).map(([prefix, rows]) => {
    const maximum = Math.max(0, ...rows.map((row) => persistentNumber(row.id, prefix)))
    return [prefix, { counter: counters.get(prefix), maximum }]
  }))
  const passed = Object.values(details).every((value) => value.counter !== undefined && value.counter >= value.maximum)
  return result("persistent_id_counters_monotonic", passed ? "pass" : "fail", details)
}

function checkHistory(database, taskId) {
  if (taskId === undefined) return result("automatic_history_saved", "insufficient", "No completed turn task is available")
  const entries = database.prepare("select kind, status, name, task_id from history_entries where task_id = ?").all(taskId)
  const automatic = entries.filter((entry) => entry.kind === "automatic" && entry.status === "ready")
  return result("automatic_history_saved", automatic.length === 1 ? "pass" : "fail", { entries, automaticCount: automatic.length })
}

function checkLongRun(database, minimumChapters) {
  const chapterCount = database.prepare("select count(*) count from canonical_chapter_messages").get().count
  return result("long_run_chapter_count", chapterCount >= minimumChapters ? "pass" : "insufficient", { chapterCount, minimumChapters })
}

function checkBackgroundEvolution(database) {
  const tasks = database.prepare("select id, status, config_snapshot_json from tasks where kind = 'evolution' order by created_at").all()
  const automatic = tasks.filter((task) => {
    const origin = parseJsonObject(task.config_snapshot_json)?.executionOrigin
    return origin?.kind === "automatic_evolution" && typeof origin.triggerTaskId === "string"
  })
  const completed = automatic.filter((task) => task.status === "completed")
  return result("automatic_background_evolution", completed.length > 0 ? "pass" : "not_implemented", {
    reason: completed.length > 0
      ? "Completed evolution tasks contain a persisted automatic trigger origin"
      : "No completed automatically triggered evolution task exists",
    taskCount: tasks.length,
    automaticCount: automatic.length,
    completedAutomaticCount: completed.length,
  })
}

function checkPromptPrefix(database, events, taskId) {
  if (taskId === undefined) return result("byte_exact_prompt_prefix", "insufficient", "No completed turn task is available")
  const statuses = new Map(database.prepare("select request_json, status from phase_runs where task_id = ?").all(taskId).flatMap((run) => {
    const envelopeId = parseJsonObject(run.request_json)?.envelopeId
    return typeof envelopeId === "string" ? [[envelopeId, run.status]] : []
  }))
  return auditPromptPrefix(events, taskId, statuses)
}

function checkPromptRoles(events, taskId) {
  if (taskId === undefined) return result("normalized_single_chain_roles", "insufficient", "No completed turn task is available")
  const profiles = events.filter((event) => event.component === "deepseek-model"
    && event.event === "completion.prompt_profiled"
    && event.taskId === taskId)
  const violations = profiles.flatMap((profile) => {
    if (!Array.isArray(profile.messages)) return [{ phase: profile.phase, reason: "missing message profile" }]
    return profile.messages.flatMap((message, index) => {
      if (index === 0 && message.role === "system") return []
      return message.role === "system" ? [{ phase: profile.phase, index, section: message.section }] : []
    })
  })
  return result("normalized_single_chain_roles", violations.length === 0 ? "pass" : "fail", {
    profileCount: profiles.length,
    violations,
    rule: "Only the first message may have system role; all appended chain messages must be user or assistant",
  })
}

function checkKv(database, events, taskId, minimumEffective, minimumRecent) {
  if (taskId === undefined) return result("effective_kv_cache_rate", "insufficient", "No completed turn task is available")
  const rows = database.prepare("select * from kv_usage where task_id = ? order by created_at").all(taskId)
  if (rows.length < 2) return result("effective_kv_cache_rate", "insufficient", { calls: rows.length })
  const rates = rows.slice(1).map((row, index) => {
    const previous = rows[index]
    const reusablePrefixTokens = Math.min(previous.total_input_tokens, row.total_input_tokens)
    const boundedCacheHitTokens = Math.min(row.cache_hit_input_tokens, reusablePrefixTokens)
    return reusablePrefixTokens === 0 ? 0 : boundedCacheHitTokens / reusablePrefixTokens
  })
  const average = averageOf(rates)
  const recentAverage = averageOf(rates.slice(-3))
  const providerHitRate = sum(rows, "cache_hit_input_tokens") / Math.max(1, sum(rows, "total_input_tokens"))
  const promptProfiles = events.filter((event) => event.component === "deepseek-model"
    && event.event === "completion.prompt_profiled"
    && event.taskId === taskId).length
  return result("effective_kv_cache_rate", average >= minimumEffective && recentAverage >= minimumRecent ? "pass" : "fail", {
    calls: rows.length,
    promptProfiles,
    effectiveRates: rates,
    average,
    recentAverage,
    providerHitRate,
    minimumEffective,
    minimumRecent,
  })
}

async function readRuntimeEvents(path) {
  const content = await readFile(path, "utf8")
  return content.split(/\r?\n/u).flatMap((line) => {
    const start = line.indexOf("{")
    if (start < 0) return []
    try { return [JSON.parse(line.slice(start))] } catch { return [] }
  })
}

function parseJsonArray(value) {
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(value) {
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function persistentNumber(value, prefix) {
  if (typeof value !== "string") return 0
  const match = new RegExp(`^${prefix}_(\\d+)$`, "u").exec(value)
  return match === null ? 0 : Number(match[1])
}

function check(id, passed, evidence) {
  return result(id, passed ? "pass" : "fail", evidence)
}

function result(id, status, evidence) {
  return { id, status, evidence }
}

function summarize(checks) {
  return checks.reduce((summary, item) => ({ ...summary, [item.status]: summary[item.status] + 1 }), {
    pass: 0,
    fail: 0,
    insufficient: 0,
    not_implemented: 0,
  })
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
}

function averageOf(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function readRatio(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
