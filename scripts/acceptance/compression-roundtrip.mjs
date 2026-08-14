/* global window */

import { createHash, randomUUID } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { connectElectron, readActiveModel, runQuery } from "./lib/electron-backend.mjs"

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const projectId = requiredEnvironment("WORLDSEED_ACCEPTANCE_PROJECT_ID")
const workspace = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_WORKSPACE"))
const databasePath = resolve(requiredEnvironment("WORLDSEED_ACCEPTANCE_DB"))
const cdpUrl = process.env.WORLDSEED_ACCEPTANCE_CDP_URL ?? "http://127.0.0.1:9230"
const outputPath = resolve(process.env.WORLDSEED_ACCEPTANCE_COMPRESSION_REPORT ?? ".worldseed-data/acceptance/current/compression.json")
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
const { browser, page } = await connectElectron(cdpUrl, workspace)
const profiles = await page.evaluate(async () => window.worldseed.readModelProfiles())
const active = profiles.profiles.find((profile) => profile.id === profiles.activeProfileId)
let restoreEntry
let historyRestored = false

try {
  if (active === undefined) throw new Error(`Active model profile is missing: ${profiles.activeProfileId}`)
  const before = stateSnapshot(database)
  const reducedWindow = Math.max(60_000, Math.floor(before.visibleTokenEstimate * 0.8))
  if (reducedWindow >= active.contextWindowTokens) {
    throw new Error(`Cannot lower context window below the current visible chain: ${String(before.visibleTokenEstimate)} tokens`)
  }
  restoreEntry = await page.evaluate(async ({ request }) => window.worldseed.invoke(request), {
    request: request("history.saveManual", {
      projectId,
      workspaceRootRef: workspace,
      operationId: randomUUID(),
      name: `压缩验收前 ${new Date().toISOString()}`,
      note: "FC-08 context roundtrip",
    }),
  }).then(assertResponse)
  const modifiedProfiles = profiles.profiles.map((profile) => profile.id === active.id
    ? { ...profile, contextWindowTokens: reducedWindow }
    : profile)
  await saveProfiles(page, modifiedProfiles, active.id)
  const selectedModel = await readActiveModel(page)
  const oldestChapter = await readOldestChapter(workspace)
  const { handle, snapshot } = await runQuery(page, {
    projectId,
    workspaceRootRef: workspace,
    question: `禁止读取章节目录，只能通过图与 Source 返回第一章中包含“${oldestChapter.fragment}”的完整原句，并区分当时状态与当前状态。`,
    allowWorkspaceChapterReads: false,
    model: selectedModel,
  }, { timeoutMs: 7_200_000, autoRecover: true })
  const compressed = stateSnapshot(database)
  await restoreHistory(page, restoreEntry.entryId)
  historyRestored = true
  await saveProfiles(page, profiles.profiles, profiles.activeProfileId)
  const restored = stateSnapshot(database)
  const answer = snapshot.result?.answerMarkdown ?? ""
  const normalizedAnswer = normalizeText(answer)
  const checks = [
    check("reduced_profile_applied", selectedModel.contextWindowTokens === reducedWindow, { expected: reducedWindow, actual: selectedModel.contextWindowTokens }),
    check("mechanical_compaction_applied", compressed.compressionGeneration > before.compressionGeneration && compressed.hiddenMessageCount > before.hiddenMessageCount, { before, compressed }),
    check("exact_source_recalled", normalizedAnswer.includes(oldestChapter.expectedSentence), {
      fragment: oldestChapter.fragment,
      expectedSentence: oldestChapter.expectedSentence,
      answer,
    }),
    check("facts_not_deleted", compressed.chapterCount === before.chapterCount && compressed.sourceCount === before.sourceCount && compressed.nodeHeadCount === before.nodeHeadCount && compressed.linkHeadCount === before.linkHeadCount, { before, compressed }),
    check("history_restored_visible_chain", restored.contextDigest === before.contextDigest && restored.visibleMessageCount === before.visibleMessageCount && restored.hiddenMessageCount === before.hiddenMessageCount, { before, restored }),
    check("history_restored_world", restored.worldDigest === before.worldDigest, { before: before.worldDigest, restored: restored.worldDigest }),
    check("single_chain_preserved", before.chainCount === 1 && compressed.chainCount === 1 && restored.chainCount === 1 && before.chainId === compressed.chainId && before.chainId === restored.chainId, { before: before.chainId, compressed: compressed.chainId, restored: restored.chainId }),
  ]
  const report = {
    generatedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "pass") ? "pass" : "fail",
    taskId: handle.taskId,
    restoreEntryId: restoreEntry.entryId,
    originalContextWindowTokens: active.contextWindowTokens,
    reducedContextWindowTokens: reducedWindow,
    checks,
  }
  await persist(report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.status === "pass" ? 0 : 1
} catch (error) {
  const recovery = []
  if (restoreEntry !== undefined && !historyRestored) {
    recovery.push(await restoreHistory(page, restoreEntry.entryId).then(() => "history_restored").catch((restoreError) => errorValue(restoreError)))
  }
  recovery.push(await saveProfiles(page, profiles.profiles, profiles.activeProfileId).then(() => "profile_restored").catch((restoreError) => errorValue(restoreError)))
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    error: errorValue(error),
    recovery,
  }
  await persist(report)
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} finally {
  database.close()
  await browser.close()
}

function stateSnapshot(databaseHandle) {
  const chains = databaseHandle.prepare("select id, message_count, token_estimate from model_context_chains where project_id = ? order by updated_at desc").all(projectId)
  const chain = chains[0]
  const messages = chain === undefined ? [] : databaseHandle.prepare("select sequence_no, content_digest, token_estimate, hidden_at from model_context_messages where chain_id = ? order by sequence_no").all(chain.id)
  const visible = messages.filter((message) => message.hidden_at === null)
  const hiddenAt = new Set(messages.flatMap((message) => message.hidden_at === null ? [] : [message.hidden_at]))
  const chapters = databaseHandle.prepare("select chapter_id, document_version_id from active_document_heads order by chapter_id").all()
  const nodes = databaseHandle.prepare("select node_id, revision_id, digest from node_heads where visibility = 'committed' order by node_id").all()
  const links = databaseHandle.prepare("select link_id, revision_id, digest from link_heads where visibility = 'committed' order by link_id").all()
  const sources = databaseHandle.prepare("select id, digest from source_units order by id").all()
  const contextDigest = digest(JSON.stringify(messages.map(({ sequence_no, content_digest, hidden_at }) => ({ sequence_no, content_digest, hidden_at }))))
  const worldDigest = digest(JSON.stringify({ chapters, nodes, links, sources }))
  return {
    chainCount: chains.length,
    chainId: chain?.id,
    messageCount: messages.length,
    visibleMessageCount: visible.length,
    hiddenMessageCount: messages.length - visible.length,
    visibleTokenEstimate: visible.reduce((total, message) => total + message.token_estimate, 0),
    compressionGeneration: hiddenAt.size,
    chapterCount: chapters.length,
    sourceCount: sources.length,
    nodeHeadCount: nodes.length,
    linkHeadCount: links.length,
    contextDigest,
    worldDigest,
  }
}

async function readOldestChapter(root) {
  const directory = join(root, "章节正文")
  const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(".md")).sort((left, right) => left.localeCompare(right, "zh-CN"))
  const file = files.find((candidate) => candidate.startsWith("第一章")) ?? files[0]
  if (file === undefined) throw new Error("Compression acceptance requires a committed chapter")
  const content = await readFile(join(directory, file), "utf8")
  const paragraphs = content.split(/\r?\n\s*\r?\n/gu).map((value) => value.trim()).filter(Boolean)
  const bodyParagraphs = /^#*\s*第[^\s]+章(?:\s|$)/u.test(paragraphs[0] ?? "") ? paragraphs.slice(1) : paragraphs
  const body = normalizeText(bodyParagraphs.join("\n"))
  const sentence = body.split(/[。！？]/u).find((value) => value.length >= 18)
  if (sentence === undefined) throw new Error("The first chapter has no stable exact fragment")
  const start = Math.max(0, Math.floor((sentence.length - 24) / 2))
  return { file, fragment: sentence.slice(start, start + 24), expectedSentence: sentence }
}

function normalizeText(value) {
  return value.replace(/\s+/gu, "").trim()
}

async function saveProfiles(pageHandle, profileDrafts, activeProfileId) {
  return pageHandle.evaluate(async ({ drafts, selectedId }) => window.worldseed.saveModelProfiles({ profiles: drafts, activeProfileId: selectedId }), {
    drafts: profileDrafts,
    selectedId: activeProfileId,
  })
}

async function restoreHistory(pageHandle, entryId) {
  return pageHandle.evaluate(async ({ requestValue }) => window.worldseed.invoke(requestValue), {
    requestValue: request("history.restore", {
      projectId,
      workspaceRootRef: workspace,
      operationId: randomUUID(),
      entryId,
    }),
  }).then(assertResponse)
}

function request(method, payload) {
  return { protocolVersion: "worldseed.v1", requestId: randomUUID(), method, payload }
}

function assertResponse(response) {
  if (!response.ok) throw new Error(response.error.message)
  return response.data
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

async function persist(report) {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}
