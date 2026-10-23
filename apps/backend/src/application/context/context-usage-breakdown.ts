import type { ModelContextMessage } from "@worldseed/contracts"

import { MODEL_CONTEXT_DELTA_HEADER } from "./model-context-appender.js"
import { estimateModelMessageTokens } from "./context-window-manager.js"

export const CONTEXT_USAGE_CATEGORY_IDS = [
  "system_rules",
  "skills",
  "phase_prompt",
  "tools",
  "presentation_rules",
  "memory",
  "evidence",
  "narrative",
  "conversation",
  "latest_delta",
] as const

export type ContextUsageCategoryId = (typeof CONTEXT_USAGE_CATEGORY_IDS)[number]

export type ContextUsageCategoryBreakdown = Readonly<{
  id: ContextUsageCategoryId
  label: string
  tokens: number
  share: number
  compressible: boolean
}>

export type ContextUsageBreakdown = Readonly<{
  usedTokens: number
  maxTokens: number
  percent: number
  categories: readonly ContextUsageCategoryBreakdown[]
  empty: boolean
}>

const CATEGORY_LABELS: Readonly<Record<ContextUsageCategoryId, string>> = {
  system_rules: "系统规则(索引)",
  skills: "已加载 Skills",
  phase_prompt: "阶段指令/协议",
  tools: "工具目录",
  presentation_rules: "表现/平台规则",
  memory: "Agent 记忆",
  evidence: "证据/读文件/图",
  narrative: "章正文/梗概/细纲",
  conversation: "对话与历史阶段",
  latest_delta: "最近一轮增量",
}

const CATEGORY_COMPRESSIBLE: Readonly<Record<ContextUsageCategoryId, boolean>> = {
  system_rules: false,
  skills: true,
  phase_prompt: false,
  tools: false,
  presentation_rules: false,
  memory: true,
  evidence: true,
  narrative: true,
  conversation: true,
  latest_delta: false,
}

/**
 * Build a Cursor-like context usage breakdown from the visible discuss model-context chain.
 * Prefer provider `lastRequestInputTokens` for the outer used total when available.
 */
export function buildContextUsageBreakdown(input: Readonly<{
  messages: readonly ModelContextMessage[]
  contextWindowTokens: number
  lastRequestInputTokens?: number
}>): ContextUsageBreakdown {
  const maxTokens = Math.max(1, Math.floor(input.contextWindowTokens))
  const buckets = emptyBuckets()
  const sorted = [...input.messages].sort((left, right) => left.sequence - right.sequence)
  if (sorted.length === 0) {
    return {
      usedTokens: 0,
      maxTokens,
      percent: 0,
      categories: finalizeCategories(buckets, 0),
      empty: true,
    }
  }

  const latestRequestIndex = findLatestPhaseRequestIndex(sorted)
  for (let index = 0; index < sorted.length; index += 1) {
    const message = sorted[index]
    if (message === undefined) continue
    const tokens = Math.max(0, message.tokenEstimate || estimateFromContent(message.content))
    if (tokens === 0) continue
    if (message.kind === "system_rules") {
      add(buckets, "system_rules", tokens)
      continue
    }
    if (message.kind === "phase_protocol") {
      add(buckets, "phase_prompt", tokens)
      continue
    }
    if (message.kind === "phase_instruction") {
      add(buckets, classifyPhaseInstruction(message.content), tokens)
      continue
    }
    if (message.kind === "canonical_chapter" || message.kind === "chapter_revision") {
      add(buckets, "narrative", tokens)
      continue
    }
    if (message.kind === "phase_response") {
      add(buckets, "conversation", tokens)
      continue
    }
    if (message.kind === "phase_request") {
      const isLatest = index === latestRequestIndex
      allocatePhaseRequest(buckets, message.content, tokens, isLatest)
      continue
    }
    add(buckets, "conversation", tokens)
  }

  const chainTokens = Object.values(buckets).reduce((sum, value) => sum + value, 0)
  const usedTokens = input.lastRequestInputTokens !== undefined && input.lastRequestInputTokens > 0
    ? input.lastRequestInputTokens
    : chainTokens
  const percent = Math.min(100, Math.round((usedTokens / maxTokens) * 1000) / 10)
  return {
    usedTokens,
    maxTokens,
    percent,
    categories: finalizeCategories(buckets, usedTokens),
    empty: chainTokens === 0,
  }
}

function emptyBuckets(): Record<ContextUsageCategoryId, number> {
  return {
    system_rules: 0,
    skills: 0,
    phase_prompt: 0,
    tools: 0,
    presentation_rules: 0,
    memory: 0,
    evidence: 0,
    narrative: 0,
    conversation: 0,
    latest_delta: 0,
  }
}

function add(buckets: Record<ContextUsageCategoryId, number>, id: ContextUsageCategoryId, tokens: number): void {
  buckets[id] += Math.max(0, tokens)
}

function finalizeCategories(
  buckets: Readonly<Record<ContextUsageCategoryId, number>>,
  usedTokens: number,
): readonly ContextUsageCategoryBreakdown[] {
  const denominator = usedTokens > 0 ? usedTokens : Object.values(buckets).reduce((sum, value) => sum + value, 0)
  return CONTEXT_USAGE_CATEGORY_IDS
    .map((id) => {
      const tokens = buckets[id]
      return {
        id,
        label: CATEGORY_LABELS[id],
        tokens,
        share: denominator === 0 ? 0 : tokens / denominator,
        compressible: CATEGORY_COMPRESSIBLE[id],
      }
    })
    .filter((category) => category.tokens > 0)
}

function findLatestPhaseRequestIndex(messages: readonly ModelContextMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "phase_request") return index
  }
  return -1
}

function estimateFromContent(content: string | undefined): number {
  if (content === undefined || content.length === 0) return 0
  return estimateModelMessageTokens(content)
}

function classifyPhaseInstruction(content: string | undefined): ContextUsageCategoryId {
  if (content === undefined || content.length === 0) return "phase_prompt"
  if (content.includes("【skill:") || content.includes("【skill-pack:") || content.includes("synopsis-skills-v1")) {
    return "skills"
  }
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "phase_prompt"
    const record = parsed as Record<string, unknown>
    // Ephemeral tool catalog injected for the wire call (rarely persisted).
    if (record.protocol === "synopsis-tools-v1" && Array.isArray(record.tools)) return "tools"
    if (record.protocol === "synopsis-skills-v1") return "skills"
    // Tool describe/invoke results and discuss gates live on the chain as phase_instruction.
    if (record.protocol === "synopsis-tools-v1" || record.protocol === "discuss-gate-v1") {
      return "conversation"
    }
    return "phase_prompt"
  } catch {
    // Markdown phase prompts (e.g. # synopsis_discuss) — not the tool catalog.
    return "phase_prompt"
  }
}

function allocatePhaseRequest(
  buckets: Record<ContextUsageCategoryId, number>,
  content: string | undefined,
  totalTokens: number,
  isLatest: boolean,
): void {
  const delta = parsePhaseRequestDelta(content)
  if (delta === undefined) {
    add(buckets, isLatest ? "latest_delta" : "conversation", totalTokens)
    return
  }
  const sectionTokens = measureDeltaSections(delta)
  const sectionSum = Object.values(sectionTokens).reduce((sum, value) => sum + value, 0)
  if (sectionSum <= 0) {
    add(buckets, isLatest ? "latest_delta" : "conversation", totalTokens)
    return
  }
  // Scale section estimates to the message's stored tokenEstimate so buckets sum to chain total.
  const scale = totalTokens / sectionSum
  for (const [id, tokens] of Object.entries(sectionTokens) as Array<[ContextUsageCategoryId, number]>) {
    if (tokens <= 0) continue
    const scaled = Math.max(0, Math.round(tokens * scale))
    if (isLatest && (id === "conversation" || id === "latest_delta")) {
      add(buckets, "latest_delta", scaled)
    } else if (!isLatest && id === "latest_delta") {
      add(buckets, "conversation", scaled)
    } else {
      add(buckets, id, scaled)
    }
  }
}

function parsePhaseRequestDelta(content: string | undefined): Record<string, unknown> | undefined {
  if (content === undefined || content.length === 0) return undefined
  const trimmed = content.startsWith(MODEL_CONTEXT_DELTA_HEADER)
    ? content.slice(MODEL_CONTEXT_DELTA_HEADER.length).trim()
    : content.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function measureDeltaSections(delta: Record<string, unknown>): Record<ContextUsageCategoryId, number> {
  const buckets = emptyBuckets()
  const input = asRecord(delta.input)
  const {
    readEvidence,
    presentationEvidence,
    presentation,
    synopsisDiscuss,
    workspaceCatalog,
    retrievalGaps,
    graphCapacity,
    verificationProbeExecutions,
    stageProjection,
    artifacts,
    projectSettings,
    userInput,
    workflow,
    ...restCore
  } = input

  add(buckets, "presentation_rules", estimateUnknown(presentation) + estimateUnknown(presentationEvidence))
  add(buckets, "narrative", estimateSynopsisDiscuss(synopsisDiscuss))
  allocateEvidenceList(buckets, readEvidence)
  add(buckets, "evidence",
    estimateUnknown(workspaceCatalog)
    + estimateUnknown(retrievalGaps)
    + estimateUnknown(graphCapacity)
    + estimateUnknown(verificationProbeExecutions)
    + estimateUnknown(stageProjection)
    + estimateUnknown(artifacts))
  add(buckets, "conversation",
    estimateUnknown(userInput)
    + estimateUnknown(workflow)
    + estimateUnknown(projectSettings)
    + estimateUnknown(restCore)
    + estimateUnknown({
      phase: delta.phase,
      protocolVersion: delta.protocolVersion,
      committedReadIds: delta.committedReadIds,
      visiblePendingIds: delta.visiblePendingIds,
      remainingBudget: delta.remainingBudget,
    }))
  return buckets
}

function allocateEvidenceList(buckets: Record<ContextUsageCategoryId, number>, value: unknown): void {
  if (!Array.isArray(value)) {
    add(buckets, "evidence", estimateUnknown(value))
    return
  }
  for (const item of value) {
    const record = asRecord(item)
    const tokens = estimateUnknown(item)
    if (isMemoryEvidence(record)) add(buckets, "memory", tokens)
    else if (record.ownerKind === "workspace:presentation") add(buckets, "presentation_rules", tokens)
    else add(buckets, "evidence", tokens)
  }
}

function isMemoryEvidence(record: Record<string, unknown>): boolean {
  const path = typeof record.relativePath === "string"
    ? record.relativePath
    : typeof record.path === "string"
      ? record.path
      : typeof record.sourcePath === "string"
        ? record.sourcePath
        : ""
  return path.includes("Agent记忆") || path.includes("MEMORY.md")
}

function estimateSynopsisDiscuss(value: unknown): number {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return estimateUnknown(value)
  return estimateUnknown(record.synopsisBody)
    + estimateUnknown(record.outlineBody)
    + estimateUnknown(record.chapterBody)
    + estimateUnknown(record.body)
    + estimateUnknown(record.heading)
    + estimateUnknown({
      ...record,
      synopsisBody: undefined,
      outlineBody: undefined,
      chapterBody: undefined,
      body: undefined,
      heading: undefined,
    })
}

function estimateUnknown(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === "string") {
    return value.length === 0 ? 0 : estimateModelMessageTokens(value)
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized === "null" || serialized === "{}" || serialized === "[]") return 0
    return estimateModelMessageTokens(serialized)
  } catch {
    return 0
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
