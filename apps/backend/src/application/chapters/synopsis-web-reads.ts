import type { PhaseResultEnvelope, ProjectSettings } from "@worldseed/contracts"
import { defaultProjectSettings } from "@worldseed/config"

import { digest } from "../../core/index.js"
import type { TurnReadEvidence } from "../turns/ports/ai-model-port.js"
import type {
  WebResearchPort,
  WebResearchProviderAttempt,
  WebResearchSearchDetail,
  WebSearchHit,
} from "../retrieval/ports/web-research-port.js"

export type SynopsisWebReadStreamUpdate = Readonly<{
  query: string
  status: "running" | "completed" | "failed"
  resultSummary?: string
}>

/**
 * Execute `sourceKinds: ["web"]` reads for synopsis ReAct and return model-visible evidence.
 * Always returns at least one diagnostic evidence item when search fails or returns empty.
 */
export async function executeSynopsisWebReads(input: Readonly<{
  requests: PhaseResultEnvelope["requestedReads"]
  existingEvidence: readonly TurnReadEvidence[]
  createId: () => string
  webResearch: WebResearchPort
  settings?: ProjectSettings
}>): Promise<readonly TurnReadEvidence[]> {
  if (input.settings !== undefined && !input.settings.retrieval.webResearchEnabled) {
    return input.requests.flatMap((request) => {
      const query = resolveWebQuery(request)
      if (query === undefined) return []
      return [buildDisabledEvidence(query, input.createId)]
    })
  }

  const seen = new Set(input.existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
  const collected: TurnReadEvidence[] = []

  for (const request of input.requests) {
    const query = resolveWebQuery(request)
    if (query === undefined) continue

    const maxResults = Math.min(
      request.query.maxCandidates,
      input.settings?.retrieval.maxWebResults ?? defaultProjectSettings.retrieval.maxWebResults,
    )

    try {
      const detail = await searchWebDetailed(input.webResearch, {
        query,
        maxResults,
        signal: AbortSignal.timeout(8_000),
      })
      if (detail.hits.length > 0) {
        for (const hit of detail.hits) {
          const evidence = buildSearchHitEvidence(query, hit, input.createId)
          const key = `${evidence.ownerId}:${evidence.digest}`
          if (seen.has(key)) continue
          seen.add(key)
          collected.push(evidence)
        }
        continue
      }

      const summary = formatFailureSummary(detail.attempts)
      const diagnostic = buildDiagnosticEvidence(query, summary, detail.attempts, input.createId)
      const key = `${diagnostic.ownerId}:${diagnostic.digest}`
      if (!seen.has(key)) {
        seen.add(key)
        collected.push(diagnostic)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const diagnostic = buildDiagnosticEvidence(
        query,
        `联网检索异常：${message}`,
        [{ provider: "composite", status: "error", message }],
        input.createId,
      )
      const key = `${diagnostic.ownerId}:${diagnostic.digest}`
      if (!seen.has(key)) {
        seen.add(key)
        collected.push(diagnostic)
      }
    }
  }

  return collected
}

async function searchWebDetailed(
  port: WebResearchPort,
  input: Readonly<{ query: string; maxResults: number; signal?: AbortSignal }>,
): Promise<WebResearchSearchDetail> {
  if (port.searchDetailed !== undefined) {
    return port.searchDetailed(input)
  }
  try {
    const hits = await port.search(input)
    return {
      hits,
      attempts: hits.length === 0
        ? [{ provider: "default", status: "empty" }]
        : [{ provider: "default", status: "ok", hitCount: hits.length }],
    }
  } catch (error) {
    return {
      hits: [],
      attempts: [{
        provider: "default",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }],
    }
  }
}

function resolveWebQuery(request: PhaseResultEnvelope["requestedReads"][number]): string | undefined {
  const query = [...request.query.exactKeys, ...request.query.semanticTexts]
    .map((term) => term.trim())
    .find((term) => term.length > 0)
    ?? request.expectedEvidence.slice(0, 200).trim()
  return query.length === 0 ? undefined : query
}

function buildSearchHitEvidence(
  query: string,
  hit: WebSearchHit,
  createId: () => string,
): TurnReadEvidence {
  const semanticText = formatWebSearchHitEvidence(query, hit)
  return {
    readId: createId(),
    visibility: "committed",
    ownerKind: "web:search",
    ownerId: hit.url,
    exactKeys: [hit.url, hit.title, query],
    semanticText,
    sourceRefs: [{ sourceKind: "web", url: hit.url, title: hit.title, query }],
    digest: digest(semanticText),
  }
}

function buildDiagnosticEvidence(
  query: string,
  summary: string,
  attempts: readonly WebResearchProviderAttempt[],
  createId: () => string,
): TurnReadEvidence {
  const semanticText = formatWebDiagnosticEvidence(query, summary, attempts)
  const ownerId = `web:diagnostic:${query}`
  return {
    readId: createId(),
    visibility: "committed",
    ownerKind: "web:diagnostic",
    ownerId,
    exactKeys: [query, ownerId],
    semanticText,
    sourceRefs: [{ sourceKind: "web", query }],
    digest: digest(semanticText),
  }
}

function buildDisabledEvidence(query: string, createId: () => string): TurnReadEvidence {
  const semanticText = [
    "# 联网检索未执行",
    "",
    `- 查询：${query}`,
    "- 原因：项目设置已关闭联网检索（retrieval.webResearchEnabled=false）",
    "",
    "说明：请基于 workspace 内已有资料继续；如需公开互联网背景，请在项目设置中开启联网检索。",
  ].join("\n")
  const ownerId = `web:disabled:${query}`
  return {
    readId: createId(),
    visibility: "committed",
    ownerKind: "web:diagnostic",
    ownerId,
    exactKeys: [query, ownerId],
    semanticText,
    sourceRefs: [{ sourceKind: "web", query }],
    digest: digest(semanticText),
  }
}

function formatFailureSummary(attempts: readonly WebResearchProviderAttempt[]): string {
  if (attempts.length === 0) return "未找到可用公开资料（无搜索引擎响应）"
  const errors = attempts.filter((attempt) => attempt.status === "error")
  if (errors.length === attempts.length) {
    return `联网检索失败：${errors.map(formatAttempt).join("；")}`
  }
  const empties = attempts.filter((attempt) => attempt.status === "empty")
  if (empties.length === attempts.length) {
    return "未找到可用公开资料（各搜索引擎均无匹配结果）"
  }
  if (errors.length > 0) {
    return `部分搜索引擎失败：${errors.map(formatAttempt).join("；")}；其余来源无匹配结果`
  }
  return "未找到可用公开资料"
}

function formatAttempt(attempt: WebResearchProviderAttempt): string {
  const detail = attempt.message === undefined ? "" : `（${attempt.message}）`
  if (attempt.status === "ok") {
    return `${attempt.provider}：${String(attempt.hitCount ?? 0)} 条${detail}`
  }
  if (attempt.status === "empty") return `${attempt.provider}：无结果`
  return `${attempt.provider}：失败${detail}`
}

function formatWebSearchHitEvidence(
  query: string,
  hit: Readonly<{ title: string; url: string; snippet: string }>,
): string {
  return [
    "# 联网检索结果",
    "",
    `- 查询：${query}`,
    `- 标题：${hit.title}`,
    `- URL：${hit.url}`,
    hit.snippet.length === 0 ? undefined : `- 摘要：${hit.snippet}`,
    "",
    "说明：这是公开互联网资料，仅作背景参考，不能覆盖已提交世界图中的当前状态，也不能直接当作作品内已发生事实。",
  ].filter((line): line is string => line !== undefined).join("\n")
}

function formatWebDiagnosticEvidence(
  query: string,
  summary: string,
  attempts: readonly WebResearchProviderAttempt[],
): string {
  const attemptLines = attempts.length === 0
    ? ["- （无搜索引擎明细）"]
    : attempts.map((attempt) => `- ${formatAttempt(attempt)}`)
  return [
    "# 联网检索未成功",
    "",
    `- 查询：${query}`,
    `- 状态：${summary}`,
    "",
    "各来源明细：",
    ...attemptLines,
    "",
    "说明：这不是 workspace 资料缺失，而是公开互联网检索未返回可用结果。请基于已有 readEvidence 继续；",
    "若判断为网络/环境故障，可告知用户检查网络或稍后重试；若判断为关键词问题，可换更短或更通用的检索词。",
  ].join("\n")
}
