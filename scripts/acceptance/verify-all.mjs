import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"

import { environmentAcceptanceState } from "./lib/acceptance-manifest.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Full acceptance is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const runDirectory = resolve(process.env.WORLDSEED_ACCEPTANCE_RUN_DIR ?? ".worldseed-data/acceptance/current")
const workspace = requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE")
const databasePath = requiredEnvironment("WORLDSEED_ACCEPTANCE_DB")
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const logPath = requiredEnvironment("WORLDSEED_ACCEPTANCE_LOG")
const fullChainPath = resolve(runDirectory, "full-chain.json")
const baselinePath = resolve(runDirectory, "baseline.json")
const auditPath = resolve(runDirectory, "audit.json")
const capacityAuditPath = resolve(runDirectory, "audit-capacity.json")
const uiPath = resolve(runDirectory, "ui.json")
const screenshotPath = resolve(runDirectory, "ui.png")
const recoveryPath = resolve(runDirectory, "recovery.json")
const historyPath = resolve(runDirectory, "history.json")
const modelSwitchPath = resolve(runDirectory, "model-switch.json")
const compressionPath = resolve(runDirectory, "compression.json")
const manifestPath = resolve(runDirectory, "manifest.json")
const failuresPath = resolve(runDirectory, "failures.json")
const steps = []
const aggregateOnly = process.env.WORLDSEED_ACCEPTANCE_AGGREGATE_ONLY === "1"

await mkdir(runDirectory, { recursive: true })

if (!aggregateOnly && process.env.WORLDSEED_ACCEPTANCE_SKIP_BASELINE !== "1") {
  const baselineStep = await runStep("baseline", pnpmCommand(), ["verify:baseline"])
  steps.push(baselineStep)
  await writeJson(baselinePath, {
    generatedAt: baselineStep.completedAt,
    status: baselineStep.status,
    step: baselineStep,
  })
}

if (!aggregateOnly) {
  steps.push(await runStep("electron", process.execPath, ["scripts/acceptance/electron-smoke.mjs"], {
    WORLDSEED_ACCEPTANCE_UI_REPORT: uiPath,
    WORLDSEED_ACCEPTANCE_SCREENSHOT: screenshotPath,
  }))
}

const prerequisiteFailed = steps.some((step) => step.status === "fail")
let longrunStep
let compressionStep
let historyStep
if (!aggregateOnly && !prerequisiteFailed) {
  longrunStep = await runStep("longrun", process.execPath, ["scripts/acceptance/full-chain-run.mjs", "--target-chapters", "20"], {
    WORLDSEED_ACCEPTANCE_FULL_REPORT: fullChainPath,
  })
  steps.push(longrunStep)
}

if (!aggregateOnly && (longrunStep?.status === "paused"
  || process.env.WORLDSEED_ACCEPTANCE_RECOVERY_TASK_ID !== undefined
  || await readJson(recoveryPath) !== undefined)) {
  steps.push(await runStep("recovery-audit", process.execPath, ["apps/backend/acceptance/audit-recovery.mjs"], {
    WORLDSEED_ACCEPTANCE_RECOVERY_REPORT: recoveryPath,
    WORLDSEED_ACCEPTANCE_FULL_REPORT: fullChainPath,
    WORLDSEED_ACCEPTANCE_DB: databasePath,
  }))
}

if (!aggregateOnly && longrunStep?.status === "pass") {
  compressionStep = await runStep("compression-roundtrip", process.execPath, ["scripts/acceptance/compression-roundtrip.mjs"], {
    WORLDSEED_ACCEPTANCE_COMPRESSION_REPORT: compressionPath,
    WORLDSEED_ACCEPTANCE_DB: databasePath,
  })
  steps.push(compressionStep)
}

if (!aggregateOnly && longrunStep?.status === "pass" && compressionStep?.status === "pass") {
  historyStep = await runStep("history-roundtrip", process.execPath, ["scripts/acceptance/history-roundtrip.mjs"], {
    WORLDSEED_ACCEPTANCE_HISTORY_REPORT: historyPath,
    WORLDSEED_ACCEPTANCE_DB: databasePath,
  })
  steps.push(historyStep)
}

if (!aggregateOnly && longrunStep?.status === "pass" && historyStep?.status === "pass") {
  steps.push(await runStep("model-switch", process.execPath, ["scripts/acceptance/model-switch-run.mjs"], {
    WORLDSEED_ACCEPTANCE_MODEL_SWITCH_REPORT: modelSwitchPath,
    WORLDSEED_ACCEPTANCE_DB: databasePath,
  }))
}

if (!aggregateOnly) {
  steps.push(await runStep("audit", process.execPath, ["apps/backend/acceptance/audit-project.mjs"], {
    WORLDSEED_ACCEPTANCE_AUDIT_REPORT: auditPath,
    WORLDSEED_ACCEPTANCE_MIN_CHAPTERS: "20",
  }))
}

const evidence = {
  baseline: await readJson(baselinePath),
  fullChain: await readJson(fullChainPath),
  audit: await mergeAuditReports([
    auditPath,
    capacityAuditPath,
    resolve(runDirectory, "audit-strict-kv.json"),
    resolve(runDirectory, "audit-auto-evolution.json"),
    resolve(runDirectory, "audit-chain-fix.json"),
  ]),
  ui: await readJson(uiPath),
  compression: await readJson(compressionPath),
  recovery: await readJson(recoveryPath),
  history: await readJson(historyPath),
  modelSwitch: await readJson(modelSwitchPath),
}
const scenarios = buildScenarios(steps, evidence)
const manifest = {
  startedAt: steps[0]?.startedAt ?? new Date().toISOString(),
  completedAt: new Date().toISOString(),
  status: aggregateStatus(scenarios),
  aggregateOnly,
  workspace,
  databasePath,
  projectId,
  logPath,
  thresholds: {
    targetChapters: 20,
    minimumEffectiveKvRate: 0.95,
    minimumRecentKvRate: 0.98,
  },
  steps,
  scenarios,
  evidencePaths: {
    baselinePath,
    fullChainPath,
    auditPath,
    uiPath,
    screenshotPath,
    recoveryPath,
    historyPath,
    modelSwitchPath,
    compressionPath,
  },
}
const failures = scenarios.filter((scenario) => scenario.status !== "pass")
await writeJson(manifestPath, manifest)
await writeJson(failuresPath, { generatedAt: manifest.completedAt, failures })
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
process.exitCode = manifest.status === "pass" ? 0 : manifest.status === "paused" ? 2 : 1

async function runStep(id, command, args, additions = {}) {
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...additions },
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code) => resolveExit(code ?? 1))
  })
  return {
    id,
    status: exitCode === 0 ? "pass" : exitCode === 2 ? "paused" : "fail",
    exitCode,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
  }
}

function buildScenarios(executionSteps, reports) {
  const step = new Map(executionSteps.map((item) => [item.id, item]))
  const fullChecks = new Map((reports.fullChain?.checks ?? []).map((item) => [item.id, item]))
  const auditChecks = new Map((reports.audit?.checks ?? []).map((item) => [item.id, item]))
  const turns = reports.fullChain?.turns ?? []
  const evolutions = reports.fullChain?.automaticEvolutions ?? []
  const executionState = reports.recovery?.status === "paused" ? "paused" : reportState(reports.fullChain)
  const completedTurnPassed = checksState(auditChecks, ["completed_turn_exists", "all_turn_phases_completed", "chapter_finalization_complete"]) === "pass"
  const graphPassed = checksState(auditChecks, ["graph_governance_committed", "graph_capacity_limits", "graph_archive_outlets"]) === "pass"
  const contextCheckIds = [
    "single_append_only_context_chain",
    "byte_exact_prompt_prefix",
    "normalized_single_chain_roles",
    "effective_kv_cache_rate",
  ]
  const contextPassed = checksState(auditChecks, contextCheckIds) === "pass"
  const finalizationPassed = checkState(auditChecks.get("chapter_finalization_complete")) === "pass"
  const backgroundEvolutionPassed = checkState(auditChecks.get("automatic_background_evolution")) === "pass"
  const historicalQueryPassed = checkState(fullChecks.get("historical_source_queries")) === "pass"
    || reports.compression?.checks?.some((item) => item.id === "exact_source_recalled" && item.status === "pass")
  const recordedChapterCount = Number(auditChecks.get("long_run_chapter_count")?.evidence?.chapterCount ?? 0)
  return [
    scenario("FC-00", "环境与隔离", environmentAcceptanceState(executionSteps, reports), { baseline: reports.baseline, ui: reports.ui, steps: ["baseline", "electron"] }),
    scenario("FC-01", "一句话完整推演", turns.length > 0 && turns.every((turn) => turn.mechanical?.passed) || completedTurnPassed ? "pass" : executionState, { completedTurns: turns.length, audit: pickChecks(auditChecks, ["completed_turn_exists", "all_turn_phases_completed", "chapter_finalization_complete"]) }),
    scenario("FC-02", "单一上下文链与 KV", contextPassed ? "pass" : combine(executionState, checksState(auditChecks, contextCheckIds)), { longrun: pickChecks(fullChecks, ["single_context_chain", "single_chain_high_kv"]), audit: pickChecks(auditChecks, contextCheckIds) }),
    scenario("FC-03", "长期连续推演", recordedChapterCount >= 20 ? "pass" : executionState, { chapterCount: recordedChapterCount, targetChapters: 20 }),
    scenario("FC-04", "后台世界自主演化", checkState(fullChecks.get("automatic_background_evolution")) === "pass" || backgroundEvolutionPassed ? "pass" : executionState, { completedEvolutions: evolutions.length, audit: auditChecks.get("automatic_background_evolution") }),
    scenario("FC-05", "图治理与归档", graphPassed ? "pass" : "fail", { auditedTurns: turns.length, audit: pickChecks(auditChecks, ["graph_governance_committed", "graph_capacity_limits", "graph_archive_outlets"]) }),
    scenario("FC-06", "远期事实和原文召回", historicalQueryPassed ? "pass" : executionState, { longrun: fullChecks.get("historical_source_queries"), compression: reports.compression }),
    scenario("FC-07", "用户矛盾输入", turns.some((turn) => turn.chapterSequence === 12 && turn.mechanical?.passed) ? "pass" : executionState, { chapter12Completed: turns.some((turn) => turn.chapterSequence === 12) }),
    optionalScenario("FC-08", "两阶段机械压缩", reports.compression, "insufficient"),
    optionalScenario("FC-09", "错误、额度和检查点", reports.recovery),
    scenario("FC-10", "Finalization", turns.length > 0 && turns.every((turn) => turn.mechanical?.finalizationStatus === "completed" && turn.mechanical?.chapterMessages === 1) || finalizationPassed ? "pass" : executionState, { auditedTurns: turns.length, audit: auditChecks.get("chapter_finalization_complete") }),
    optionalScenario("FC-11", "历史与世界线", reports.history),
    optionalScenario("FC-12", "模型切换", reports.modelSwitch, "insufficient"),
    scenario("FC-13", "UI 与性能", reports.ui?.passed === true && checkState(auditChecks.get("effective_kv_cache_rate")) === "pass" ? "pass" : combine(reportState(reports.ui), checkState(auditChecks.get("effective_kv_cache_rate"))), { ui: reports.ui?.checks, kv: auditChecks.get("effective_kv_cache_rate")?.evidence }),
  ]
}

function optionalScenario(id, name, report, missingStatus = "not_implemented") {
  return scenario(id, name, report === undefined ? missingStatus : report.status === "pass" ? "pass" : report.status ?? "fail", report)
}

function scenario(id, name, status, evidence) {
  return { id, name, status, evidence }
}

function checksState(checks, ids) {
  return combine(...ids.map((id) => checkState(checks.get(id))))
}

function checkState(check) {
  return check?.status ?? "insufficient"
}

function pickChecks(checks, ids) {
  return Object.fromEntries(ids.map((id) => [id, checks.get(id)]))
}

function reportState(report) {
  if (report?.status === "paused") return "paused"
  if (report?.status === "fail") return "fail"
  return report === undefined ? "insufficient" : "insufficient"
}

function combine(...statuses) {
  const values = statuses.filter(Boolean)
  if (values.includes("fail")) return "fail"
  if (values.includes("paused")) return "paused"
  if (values.includes("not_implemented")) return "not_implemented"
  if (values.includes("insufficient") || values.length === 0) return "insufficient"
  return "pass"
}

function aggregateStatus(scenarios) {
  const statuses = scenarios.map((scenarioItem) => scenarioItem.status)
  if (statuses.includes("fail") || statuses.includes("not_implemented") || statuses.includes("insufficient")) return "fail"
  return statuses.includes("paused") ? "paused" : "pass"
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

async function mergeAuditReports(paths) {
  const reports = (await Promise.all(paths.map((path) => readJson(path)))).filter(Boolean)
  const ordered = reports.sort((left, right) => Date.parse(left.generatedAt ?? 0) - Date.parse(right.generatedAt ?? 0))
  const latest = ordered.at(-1)
  if (latest === undefined) return undefined
  const checks = new Map()
  for (const report of ordered) {
    for (const check of report.checks ?? []) checks.set(check.id, check)
  }
  return {
    ...latest,
    checks: [...checks.values()],
    sourceReports: ordered.map((report) => ({
      generatedAt: report.generatedAt,
      outputPath: report.outputPath,
    })),
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm"
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
