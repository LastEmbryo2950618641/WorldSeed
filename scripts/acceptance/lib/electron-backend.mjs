import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { chromium } from "playwright-core"

const protocolVersion = "worldseed.v1"

export async function connectElectron(cdpUrl, workspaceRootRef) {
  const browser = await chromium.connectOverCDP(cdpUrl)
  const page = browser.contexts()[0]?.pages()[0]
  if (page === undefined) throw new Error(`No Electron renderer page is available at ${cdpUrl}`)
  if (workspaceRootRef !== undefined) {
    await invokeBackend(page, "project.open", { workspaceRootRef })
  }
  return { browser, page }
}

export async function invokeBackend(page, method, payload) {
  return page.evaluate(async ({ requestProtocolVersion, requestMethod, requestPayload }) => {
    const response = await window.worldseed.invoke({
      protocolVersion: requestProtocolVersion,
      requestId: crypto.randomUUID(),
      method: requestMethod,
      payload: requestPayload,
    })
    if (!response.ok) throw new Error(response.error.message)
    return response.data
  }, {
    requestProtocolVersion: protocolVersion,
    requestMethod: method,
    requestPayload: payload,
  })
}

export async function readActiveModel(page) {
  const selection = await page.evaluate(async () => window.worldseed.readModelProfiles())
  const profile = selection.profiles.find((candidate) => candidate.id === selection.activeProfileId)
  if (profile === undefined) throw new Error(`Active model profile is missing: ${selection.activeProfileId}`)
  const { apiKey, hasApiKey: _hasApiKey, ...model } = profile
  return typeof apiKey === "string" && apiKey.trim().length > 0
    ? { ...model, apiKey: apiKey.trim() }
    : model
}

export async function runTurn(page, input, options = {}) {
  const handle = await invokeBackend(page, "turn.start", input)
  const snapshot = await waitForTask(page, handle.taskId, {
    timeoutMs: options.timeoutMs,
    autoRecover: options.autoRecover,
    maxRecoveries: options.maxRecoveries,
    model: input.model,
  })
  return { handle, snapshot }
}

export async function runQuery(page, input, options = {}) {
  const handle = await invokeBackend(page, "world.query", input)
  const snapshot = await waitForTask(page, handle.taskId, {
    timeoutMs: options.timeoutMs,
    autoRecover: options.autoRecover,
    maxRecoveries: options.maxRecoveries,
    model: input.model,
  })
  return { handle, snapshot }
}

export async function waitForTask(page, taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 7_200_000
  const maxRecoveries = options.maxRecoveries ?? 3
  const deadline = Date.now() + timeoutMs
  let recoveries = 0
  while (Date.now() < deadline) {
    const snapshot = await invokeBackend(page, "turn.status", { taskId })
    if (snapshot.status === "completed") return snapshot
    if (snapshot.status === "awaiting_user_decision" || snapshot.status === "paused") {
      if (!options.autoRecover) {
        throw new Error(`Task ${taskId} paused at ${snapshot.lastPhase ?? "unknown"}: ${snapshot.interruption?.message ?? "unknown interruption"}`)
      }
      if (recoveries >= maxRecoveries) {
        throw new Error(`Task ${taskId} exceeded ${String(maxRecoveries)} automatic recoveries at ${snapshot.lastPhase ?? "unknown"}: ${snapshot.interruption?.message ?? "unknown interruption"}`)
      }
      const metricIds = snapshot.interruption?.blockedMetrics ?? []
      if (metricIds.length > 0) await invokeBackend(page, "turn.metrics.reset", { taskId, metricIds })
      try {
        await invokeBackend(page, "turn.resume", {
          taskId,
          mode: "continue",
          resetMetricIds: [],
          ...(options.model === undefined ? {} : { model: options.model }),
        })
        recoveries += 1
      } catch (error) {
        const latest = await invokeBackend(page, "turn.status", { taskId })
        if (latest.status !== "created" && latest.status !== "running" && latest.status !== "committing") throw error
      }
    }
    if (snapshot.status === "cancelled" || snapshot.status === "failed") {
      throw new Error(`Task ${taskId} ended with ${snapshot.status}: ${snapshot.interruption?.message ?? snapshot.error?.message ?? "unknown error"}`)
    }
    await page.waitForTimeout(2_000)
  }
  throw new Error(`Task ${taskId} did not complete within ${String(timeoutMs)} ms`)
}

export async function chapterFiles(workspaceRoot) {
  const directory = join(workspaceRoot, "章节正文")
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
}
