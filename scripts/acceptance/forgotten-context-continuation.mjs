/* global window */

import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { setTimeout as delay } from "node:timers/promises"

import { connectElectron, invokeBackend, readActiveModel, runTurn } from "./lib/electron-backend.mjs"
import { deduplicateEvidenceByVersion, readEvidenceProjectionText } from "./lib/evidence-audit.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Real forgotten-context continuation is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9232"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_FORGOTTEN_REPORT
  ?? ".worldseed-data/acceptance/current/forgotten-context-continuation.json")
const timeoutMs = Number(process.env.WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS ?? 7_200_000)
const database = new Database(databasePath, { fileMustExist: true })
const { browser, page } = await connectElectron(cdpUrl, workspace)
const startedAt = new Date().toISOString()
const startedAtMs = Date.now()
let restoreEntry
let originalSettings
let originalProfiles
let historyRestored = false
let baselineContextState
let acceptanceTaskId

try {
  originalSettings = await invokeBackend(page, "project.settings.read", { projectId, workspaceRootRef: workspace })
  originalProfiles = await page.evaluate(async () => window.worldseed.readModelProfiles())
  const active = originalProfiles.profiles.find((profile) => profile.id === originalProfiles.activeProfileId)
  if (active === undefined) throw new Error(`Active model profile is missing: ${originalProfiles.activeProfileId}`)
  const before = stateSnapshot(database)
  baselineContextState = contextStateSnapshot(database)
  if (before.chapterCount < 20) throw new Error(`Strict continuation requires at least 20 chapters, found ${String(before.chapterCount)}`)

  restoreEntry = await invokeBackend(page, "history.saveManual", {
    projectId,
    workspaceRootRef: workspace,
    operationId: randomUUID(),
    name: `严格遗忘续写验收前 ${new Date().toISOString()}`,
    note: "Restore the 20-chapter world after strict graph continuity acceptance.",
  })

  const forgottenContext = hideVisibleContextMessages(database)
  const afterForgetting = stateSnapshot(database)
  if (forgottenContext.hiddenMessageCount === 0 || afterForgetting.visibleOldMessageIds.length !== 0) {
    throw new Error("The acceptance fixture did not remove the inherited activity chain from model visibility")
  }

  const strictContextWindowTokens = Math.max(100_000, Math.min(
    active.contextWindowTokens,
    Math.floor(before.visibleTokenEstimate * 1.8),
  ))
  await saveProfiles(page, {
    profiles: originalProfiles.profiles.map((profile) => profile.id === active.id
      ? { ...profile, contextWindowTokens: strictContextWindowTokens }
      : profile),
    activeProfileId: originalProfiles.activeProfileId,
  })
  await invokeBackend(page, "project.settings.save", {
    projectId,
    workspaceRootRef: workspace,
    settings: {
      ...originalSettings,
      execution: {
        ...originalSettings.execution,
        contextCompactionThresholdRatio: 0.5,
        contextCompressionTargetRatio: 0.1,
      },
    },
  })

  const model = await readActiveModel(page)
  const chapterSequence = before.chapterCount + 1
  const userInput = [
    "旅人在当前所在之处醒来后，根据目前持有的事物和仍未完成的线索，自主决定下一步行动。",
    "只依赖本轮实际选择性读取的持久化图与 Source，以及本轮新产生的内容继续推演。",
    "不要把资料未定义处当作拒绝理由；做最小一致补全，并保持时间、空间、历史演化和当前状态连续。",
  ].join("\n")
  const { handle, snapshot } = await runTurn(page, {
    projectId,
    workspaceRootRef: workspace,
    userInput,
    chapterSequence,
    allowWorkspaceChapterReads: false,
    presentation: { minimumWordCount: 2000, maximumWordCount: 3000 },
    model,
  }, { timeoutMs, autoRecover: true, maxRecoveries: 8 })
  acceptanceTaskId = handle.taskId

  const automaticHistory = await waitForAutomaticHistory(handle.taskId, Math.min(timeoutMs, 180_000))
  await cancelAutomaticEvolutionForTrigger(page, handle.taskId)

  const chapterPath = snapshot.result?.chapterPath
  if (typeof chapterPath !== "string") throw new Error(`Turn ${handle.taskId} completed without a chapter path`)
  const chapter = await readFile(resolve(workspace, chapterPath), "utf8")
  const audit = auditTask(database, handle.taskId, before.visibleOldMessageIds)
  const after = stateSnapshot(database)
  const expectedFacts = expectedContinuityFacts()
  const evidenceText = audit.factualEvidence.map((item) => item.semanticText).join("\n")
  const opening = chapter.slice(0, Math.min(chapter.length, 1_500))
  const completedActionMentioned = includesAny(chapter, ["灰船", "老码头"])
  const checks = [
    check("fixture_removed_inherited_context", afterForgetting.visibleOldMessageIds.length === 0, {
      forgottenContext,
      afterForgetting,
    }),
    check("context_forgotten", audit.visibleOldMessageCount === 0, audit.visibleOldMessages),
    check("workspace_chapter_evidence_absent", audit.workspaceChapterEvidenceCount === 0, audit.workspaceChapterEvidence),
    check("no_inherited_old_factual_evidence", audit.initialFactualEvidenceCount === 0, audit.initialFactualEvidence),
    check("graph_evidence_selected", audit.graphEvidenceCount > 0, { count: audit.graphEvidenceCount }),
    check("current_state_recalled", includesAll(evidenceText, ["柳渡", "簿子", "空信封", "三张车票"]), { evidenceText }),
    check("completed_action_supported_if_used", !completedActionMentioned || includesAll(evidenceText, ["灰船", "老码头", "拴"]), {
      completedActionMentioned,
      evidenceText,
    }),
    check("new_chapter_committed", after.chapterCount === before.chapterCount + 1 && snapshot.status === "completed", {
      before: before.chapterCount,
      after: after.chapterCount,
      taskStatus: snapshot.status,
    }),
    check("new_graph_committed", audit.committedGraphRevisionCount > 0, { count: audit.committedGraphRevisionCount }),
    check("location_continuity_visible", (
      opening.includes("柳渡")
      || (includesAll(evidenceText, ["柳渡", "镇口候车亭"]) && includesAny(opening, ["镇口", "候车亭"]))
    ) && !includesAny(opening, ["东全渡口", "候船棚"]), {
      expected: "开篇延续柳渡镇口候车亭，不得回退到东全渡口；正文可使用已读局部名称而不重复行政地名",
      opening,
    }),
    check("completed_action_continuity_visible", !includesAny(chapter, [
      "灰船拴在东全",
      "灰的靠在右",
      "灰船仍在东全",
      "两条铁壳船拴在木桩上",
    ]), {
      expected: "灰船保持在老码头，不得重新出现在东全渡口",
    }),
    check("inventory_continuity_visible", countMatches(chapter, ["簿子", "信封", "车票"]) >= 2, {
      matched: ["簿子", "信封", "车票"].filter((value) => chapter.includes(value)),
    }),
  ]
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    projectId,
    workspace,
    databasePath,
    model: { id: model.id, name: model.name, model: model.model },
    taskId: handle.taskId,
    chapterSequence,
    chapterPath,
    userInput,
    strictContextWindowTokens,
    forgottenContext,
    automaticHistory,
    visibleCanonicalChaptersBeforeCompaction: before.visibleCanonicalChapterCount,
    expectedFacts,
    sourcePolicy: {
      exactSourceRequired: false,
      reason: "This continuation asks for current state, not verbatim historical wording.",
      selectedSourceEvidenceCount: audit.sourceEvidenceCount,
    },
    checks,
    audit,
    chapter,
  }
  await persist(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} catch (error) {
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    status: "fail",
    error: errorValue(error),
  }
  await persist(report)
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} finally {
  if (acceptanceTaskId !== undefined) {
    await cancelAutomaticEvolutionForTrigger(page, acceptanceTaskId).catch(() => undefined)
  }
  if (restoreEntry !== undefined && !historyRestored) {
    await invokeBackend(page, "history.restore", {
      projectId,
      workspaceRootRef: workspace,
      operationId: randomUUID(),
      entryId: restoreEntry.entryId,
    }).then(async () => {
      historyRestored = true
      if (acceptanceTaskId !== undefined) {
        await cancelAutomaticEvolutionForTrigger(page, acceptanceTaskId).catch(() => undefined)
      }
      const restoredContextState = contextStateSnapshot(database)
      const automaticEvolutionTaskCount = acceptanceTaskId === undefined
        ? 0
        : automaticEvolutionTasksForTrigger(database, acceptanceTaskId).length
      const restoration = {
        status: JSON.stringify(restoredContextState) === JSON.stringify(baselineContextState)
          && automaticEvolutionTaskCount === 0 ? "pass" : "fail",
        entryId: restoreEntry.entryId,
        automaticEvolutionTaskCount,
        baselineContextState,
        restoredContextState,
      }
      const existing = JSON.parse(await readFile(outputPath, "utf8"))
      await persist({
        ...existing,
        status: existing.status === "pass" && restoration.status === "pass" ? "pass" : "fail",
        restoration,
      })
      if (restoration.status !== "pass") process.exitCode = 1
    }).catch(async (error) => {
      const restoration = { status: "fail", entryId: restoreEntry.entryId, error: errorValue(error) }
      const existing = JSON.parse(await readFile(outputPath, "utf8"))
      await persist({ ...existing, status: "fail", restoration })
      process.stderr.write(`${JSON.stringify({ restoration }, null, 2)}\n`)
      process.exitCode = 1
    })
  }
  if (originalSettings !== undefined) {
    await invokeBackend(page, "project.settings.save", {
      projectId,
      workspaceRootRef: workspace,
      settings: originalSettings,
    }).catch(() => undefined)
  }
  if (originalProfiles !== undefined) await saveProfiles(page, originalProfiles).catch(() => undefined)
  database.close()
  await browser.close()
}

function stateSnapshot(databaseHandle) {
  const chain = databaseHandle.prepare(`
    select id from model_context_chains where project_id = ? order by updated_at desc limit 1
  `).get(projectId)
  const visibleMessages = chain === undefined ? [] : databaseHandle.prepare(`
    select id, kind, task_id, token_estimate from model_context_messages
    where chain_id = ? and hidden_at is null order by sequence_no
  `).all(chain.id)
  return {
    chapterCount: databaseHandle.prepare("select count(*) count from canonical_chapter_messages").get().count,
    visibleCanonicalChapterCount: visibleMessages.filter((message) => message.kind === "canonical_chapter").length,
    visibleTokenEstimate: visibleMessages.reduce((total, message) => total + message.token_estimate, 0),
    visibleOldMessageIds: visibleMessages.filter((message) => message.kind !== "system_rules").map((message) => message.id),
  }
}

function hideVisibleContextMessages(databaseHandle) {
  return databaseHandle.transaction(() => {
    const chain = databaseHandle.prepare(`
      select id from model_context_chains where project_id = ? order by updated_at desc limit 1
    `).get(projectId)
    if (chain === undefined) throw new Error(`No model context chain exists for project ${projectId}`)
    const messages = databaseHandle.prepare(`
      select id, kind, token_estimate from model_context_messages
      where chain_id = ? and hidden_at is null and kind <> 'system_rules'
      order by sequence_no
    `).all(chain.id)
    const hiddenAtMs = Date.now()
    const removedTokens = messages.reduce((total, message) => total + message.token_estimate, 0)
    if (messages.length > 0) {
      const update = databaseHandle.prepare(`
        update model_context_messages set hidden_at = ? where chain_id = ? and id = ? and hidden_at is null
      `)
      for (const message of messages) update.run(hiddenAtMs, chain.id, message.id)
    }
    const visibleTokens = databaseHandle.prepare(`
      select coalesce(sum(token_estimate), 0) token_estimate
      from model_context_messages where chain_id = ? and hidden_at is null
    `).get(chain.id).token_estimate
    databaseHandle.prepare(`
      update model_context_chains set token_estimate = ?, updated_at = ? where id = ?
    `).run(visibleTokens, hiddenAtMs, chain.id)
    return {
      chainId: chain.id,
      hiddenAtMs,
      hiddenMessageCount: messages.length,
      hiddenCanonicalChapterCount: messages.filter((message) => message.kind === "canonical_chapter").length,
      removedTokens,
      visibleTokens,
    }
  }).immediate()
}

function contextStateSnapshot(databaseHandle) {
  const chain = databaseHandle.prepare(`
    select id, message_count, token_estimate from model_context_chains
    where project_id = ? order by updated_at desc limit 1
  `).get(projectId)
  if (chain === undefined) return undefined
  const messages = databaseHandle.prepare(`
    select id, sequence_no, kind, token_estimate, hidden_at
    from model_context_messages where chain_id = ? order by sequence_no
  `).all(chain.id)
  return {
    chain,
    messages,
    visibleTokenEstimate: messages
      .filter((message) => message.hidden_at === null)
      .reduce((total, message) => total + message.token_estimate, 0),
  }
}

function auditTask(databaseHandle, taskId, oldMessageIds) {
  const parse = (value) => {
    try { return JSON.parse(value) } catch { return undefined }
  }
  const runs = databaseHandle.prepare(`
    select id, phase, attempt, request_json, result_json from phase_runs
    where task_id = ? order by started_at, id
  `).all(taskId).map((row) => ({ ...row, request: parse(row.request_json), result: parse(row.result_json) }))
  const evidence = deduplicateEvidenceByVersion(runs.flatMap((run) => run.request?.input?.readEvidence ?? []))
  const initialEvidence = runs.find((run) => run.phase === "interpret")?.request?.input?.readEvidence ?? []
  const factualEvidence = evidence.filter((item) => ["node", "link", "source", "revision"].includes(item.ownerKind))
    .map((item) => ({ ...item, semanticText: readEvidenceProjectionText(databaseHandle, projectId, item) }))
  const visibleOldMessages = oldMessageIds.length === 0 ? [] : databaseHandle.prepare(`
    select id, kind, task_id from model_context_messages where id in (${oldMessageIds.map(() => "?").join(",")}) and hidden_at is null
  `).all(...oldMessageIds)
  const workspaceChapterEvidence = evidence.filter((item) => item.ownerKind === "workspace:chapters")
  const task = databaseHandle.prepare("select scope_id from tasks where id = ?").get(taskId)
  return {
    phaseRuns: runs.map((run) => ({ id: run.id, phase: run.phase, attempt: run.attempt, outcome: run.result?.outcome })),
    visibleOldMessageCount: visibleOldMessages.length,
    visibleOldMessages,
    workspaceChapterEvidenceCount: workspaceChapterEvidence.length,
    workspaceChapterEvidence,
    initialFactualEvidenceCount: initialEvidence.filter((item) => ["node", "link", "source", "revision"].includes(item.ownerKind)).length,
    initialFactualEvidence: initialEvidence.filter((item) => ["node", "link", "source", "revision"].includes(item.ownerKind)),
    graphEvidenceCount: factualEvidence.filter((item) => ["node", "link", "revision"].includes(item.ownerKind)).length,
    sourceEvidenceCount: factualEvidence.filter((item) => item.ownerKind === "source").length,
    factualEvidence,
    committedGraphRevisionCount: task === undefined ? 0 : databaseHandle.prepare(`
      select count(*) count from graph_revisions revisions
      join artifact_scopes scopes on scopes.id = revisions.scope_id
      where revisions.scope_id = ? and scopes.visibility = 'committed'
    `).get(task.scope_id).count,
  }
}

function expectedContinuityFacts() {
  return {
    currentLocation: "柳渡",
    inventory: ["深绿色簿子", "空信封", "三张车票"],
    openLead: "柳渡镇口桥上的圆圈仍未关闭",
    completedAction: "灰船已归还老码头并重新拴好",
    historicalState: "白房子井沿的帆布袋已被取走",
    unknownBoundaries: ["灰衣人身份未确认", "雾港年轻女人身份未确认"],
  }
}

async function cancelAutomaticEvolutionForTrigger(pageHandle, triggerTaskId) {
  const tasks = automaticEvolutionTasksForTrigger(database, triggerTaskId)
  for (const task of tasks) {
    if (["created", "running", "committing", "awaiting_user_decision", "paused"].includes(task.status)) {
      await invokeBackend(pageHandle, "turn.cancel", { taskId: task.id }).catch(() => undefined)
    }
  }
}

function automaticEvolutionTasksForTrigger(databaseHandle, triggerTaskId) {
  return databaseHandle.prepare(`
    select id, status, config_snapshot_json from tasks where kind = 'evolution' order by created_at
  `).all().filter((task) => {
    try {
      const origin = JSON.parse(task.config_snapshot_json).executionOrigin
      return origin?.kind === "automatic_evolution" && origin.triggerTaskId === triggerTaskId
    } catch {
      return false
    }
  })
}

async function waitForAutomaticHistory(taskId, historyTimeoutMs) {
  const deadline = Date.now() + historyTimeoutMs
  while (Date.now() < deadline) {
    const entry = database.prepare(`
      select id, status from history_entries where task_id = ? and kind = 'automatic'
      order by created_at desc limit 1
    `).get(taskId)
    if (entry?.status === "ready") return { entryId: entry.id, status: entry.status }
    if (entry?.status === "failed") throw new Error(`Automatic history failed for acceptance task ${taskId}`)
    await delay(250)
  }
  throw new Error(`Automatic history did not finish for acceptance task ${taskId}`)
}

async function saveProfiles(pageHandle, value) {
  return pageHandle.evaluate(async (profiles) => window.worldseed.saveModelProfiles(profiles), value)
}

function includesAll(value, fragments) {
  return fragments.every((fragment) => value.includes(fragment))
}

function includesAny(value, fragments) {
  return fragments.some((fragment) => value.includes(fragment))
}

function countMatches(value, fragments) {
  return fragments.filter((fragment) => value.includes(fragment)).length
}

function check(id, passed, evidence) {
  return { id, status: passed ? "pass" : "fail", evidence }
}

function errorValue(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }
}

async function persist(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
