import { createRequire } from "node:module"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import process from "node:process"

import { connectElectron, invokeBackend, readActiveModel, runQuery } from "./lib/electron-backend.mjs"

if (process.env.WORLDSEED_ACCEPTANCE_REAL !== "1") {
  throw new Error("Real exact Source recall is disabled. Set WORLDSEED_ACCEPTANCE_REAL=1 explicitly.")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9232"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_EXACT_RECALL_REPORT
  ?? ".worldseed-data/acceptance/current/exact-source-recall.json")
const timeoutMs = Number(process.env.WORLDSEED_ACCEPTANCE_TURN_TIMEOUT_MS ?? 7_200_000)

const firstChapter = await readFirstChapter(workspace)
const question = [
  "禁止读取章节正文目录。",
  `请只通过已经持久化的图与 Source，返回《${firstChapter.heading}》中包含“${firstChapter.fragment}”的完整原句。`,
  "必须逐字返回；如果已读 Source 包含原句，不得声称无法核验。",
].join("\n")
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const startedAt = new Date().toISOString()
const startedAtMs = Date.now()
const { browser, page } = await connectElectron(cdpUrl, workspace)
let originalSettings

try {
  originalSettings = await invokeBackend(page, "project.settings.read", { projectId, workspaceRootRef: workspace })
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
  const { handle, snapshot } = await runQuery(page, {
    projectId,
    workspaceRootRef: workspace,
    question,
    allowWorkspaceChapterReads: false,
    model,
  }, { timeoutMs, autoRecover: true })
  const answer = snapshot.result?.answerMarkdown ?? ""
  const evidence = snapshot.result?.evidence ?? []
  const sourceEvidence = evidence.filter((item) => item.ownerKind === "source")
  const matchingSourceEvidence = sourceEvidence.filter((item) => {
    const projection = database.prepare(`
      select semantic_text from retrieval_projections where owner_id = ? and owner_kind = 'source'
    `).get(item.ownerId)
    return normalize(projection?.semantic_text ?? "").includes(normalize(firstChapter.expectedSentence))
  })
  const phaseRuns = database.prepare(`
    select phase, status, attempt, request_json, result_json
    from phase_runs where task_id = ? order by started_at, id
  `).all(handle.taskId).map((run) => ({
    phase: run.phase,
    status: run.status,
    attempt: run.attempt,
    request: parseJson(run.request_json),
    outcome: parseJson(run.result_json)?.outcome,
    reason: parseJson(run.result_json)?.reason,
    artifact: parseJson(run.result_json)?.artifact,
  }))
  const taskChapterEvidence = phaseRuns.flatMap((run) => (
    (run.request?.input?.readEvidence ?? []).filter((item) => item?.ownerKind === "workspace:chapters")
  ))
  const visibleContextChapterEvidence = readVisibleContextChapterEvidence(database, projectId)
  const visibleCanonicalChapterCount = database.prepare(`
    select count(*) as count
    from model_context_messages
    inner join model_context_chains on model_context_chains.id = model_context_messages.chain_id
    where model_context_chains.project_id = ?
      and model_context_messages.hidden_at is null
      and model_context_messages.kind = 'canonical_chapter'
  `).get(projectId).count
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    status: normalize(answer).includes(normalize(firstChapter.expectedSentence))
      && matchingSourceEvidence.length > 0
      && taskChapterEvidence.length === 0
      && visibleContextChapterEvidence.length === 0
      && visibleCanonicalChapterCount === 0
      && snapshot.status === "completed" ? "pass" : "fail",
    projectId,
    workspace,
    databasePath,
    model: { id: model.id, name: model.name, model: model.model },
    taskId: handle.taskId,
    taskStatus: snapshot.status,
    question,
    expectedSentence: firstChapter.expectedSentence,
    answer,
    checks: {
      exactSentenceReturned: normalize(answer).includes(normalize(firstChapter.expectedSentence)),
      workspaceChapterReadsDisabled: true,
      evidenceCount: evidence.length,
      sourceEvidenceCount: sourceEvidence.length,
      matchingSourceEvidenceIds: matchingSourceEvidence.map((item) => item.readId),
      taskChapterEvidenceCount: taskChapterEvidence.length,
      visibleContextChapterEvidenceCount: visibleContextChapterEvidence.length,
      visibleCanonicalChapterCount,
      draftRuns: phaseRuns.filter((run) => run.phase === "draft").length,
      reviewRuns: phaseRuns.filter((run) => run.phase === "response_review").length,
    },
    evidence,
    phaseRuns: phaseRuns.map(({ request: _request, ...run }) => run),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} finally {
  if (originalSettings !== undefined) {
    await invokeBackend(page, "project.settings.save", {
      projectId,
      workspaceRootRef: workspace,
      settings: originalSettings,
    })
  }
  database.close()
  await browser.close()
}

function readVisibleContextChapterEvidence(database, activeProjectId) {
  const rows = database.prepare(`
    select distinct phase_runs.id, phase_runs.request_json
    from model_context_messages
    inner join model_context_chains on model_context_chains.id = model_context_messages.chain_id
    inner join phase_runs on phase_runs.id = model_context_messages.origin_phase_run_id
    where model_context_chains.project_id = ? and model_context_messages.hidden_at is null
  `).all(activeProjectId)
  return rows.flatMap((row) => (
    (parseJson(row.request_json)?.input?.readEvidence ?? [])
      .filter((item) => item?.ownerKind === "workspace:chapters")
  ))
}

async function readFirstChapter(workspaceRoot) {
  const directory = join(workspaceRoot, "章节正文")
  const { readdir } = await import("node:fs/promises")
  const files = await readdir(directory)
  const file = files.find((candidate) => candidate.startsWith("第一章") && candidate.endsWith(".md"))
  if (file === undefined) throw new Error("The acceptance workspace has no first chapter")
  const content = await readFile(join(directory, file), "utf8")
  const lines = content.split(/\r?\n/u)
  const headingLine = lines.find((line) => line.trim().length > 0)?.trim() ?? file.replace(/\.md$/u, "")
  const heading = headingLine.replace(/^#\s+/u, "")
  const body = lines.slice(lines.indexOf(headingLine) + 1).join("\n").replace(/\s+/gu, "").trim()
  const sentences = body.match(/[^。！？]+[。！？]/gu) ?? []
  const expectedSentence = sentences.find((sentence) => sentence.replace(/\s+/gu, "").length >= 48)
    ?? sentences.find((sentence) => sentence.replace(/\s+/gu, "").length > 24)
  if (expectedSentence === undefined) throw new Error("The first chapter has no complete sentence")
  const fragmentSource = expectedSentence.replace(/[。！？]$/u, "")
  const start = Math.max(0, Math.floor((fragmentSource.length - 24) / 2))
  return { heading, expectedSentence, fragment: fragmentSource.slice(start, start + 24) }
}

function normalize(value) {
  return value.replace(/\s+/gu, "")
}

function parseJson(value) {
  if (typeof value !== "string") return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
