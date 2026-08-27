import type { ChapterRevisionConversationMessage } from "@worldseed/contracts"

export type DraftVersionSource = "baseline" | "agent" | "manual" | "rollback"

export const COMMITTED_DRAFT_VERSION_ID = "proto-v0"

export type PrototypeDraftVersion = Readonly<{
  versionId: string
  parentVersionId: string | undefined
  source: DraftVersionSource
  label: string
  heading: string
  body: string
  messageId: string | undefined
  createdAtMs: number
  updatedAtMs?: number
}>

export type DiffLine = Readonly<{
  type: "context" | "add" | "del"
  text: string
}>

export function buildPrototypeDraftVersions(input: Readonly<{
  committedHeading: string
  committedBody: string
  messages: readonly ChapterRevisionConversationMessage[]
}>): PrototypeDraftVersion[] {
  const versions: PrototypeDraftVersion[] = [{
    versionId: COMMITTED_DRAFT_VERSION_ID,
    parentVersionId: undefined,
    source: "baseline",
    label: "正文",
    heading: input.committedHeading,
    body: input.committedBody,
    messageId: undefined,
    createdAtMs: 0,
  }]
  let parentId = COMMITTED_DRAFT_VERSION_ID
  let index = 1
  for (const message of input.messages) {
    if (message.role !== "assistant" || message.proposal === undefined) continue
    const versionId = `proto-${message.messageId}`
    versions.push({
      versionId,
      parentVersionId: parentId,
      source: "agent",
      label: `v${String(index)} AI`,
      heading: message.proposal.heading ?? input.committedHeading,
      body: message.proposal.body,
      messageId: message.messageId,
      createdAtMs: message.createdAtMs,
    })
    parentId = versionId
    index += 1
  }
  if (versions.length > 1) {
    relabelLatestDraftVersion(versions)
  }
  return versions
}

export function relabelLatestDraftVersion(versions: PrototypeDraftVersion[]): PrototypeDraftVersion[] {
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index]
    if (version === undefined) continue
    const isLast = index === versions.length - 1
    if (!isLast && version.label.endsWith(" 最新")) {
      versions[index] = {
        ...version,
        label: version.source === "agent"
          ? version.label.replace(/ 最新$/u, " AI")
          : version.label.replace(/ 最新$/u, ""),
      }
      continue
    }
    if (isLast && version.source !== "baseline" && !version.label.endsWith(" 最新")) {
      versions[index] = { ...version, label: `${version.label} 最新` }
    }
  }
  return versions
}

export function mergeDraftVersionContent(
  versions: readonly PrototypeDraftVersion[],
  versionId: string,
  patch: Readonly<{ heading: string; body: string; updatedAtMs: number }>,
): PrototypeDraftVersion[] {
  return relabelLatestDraftVersion(versions.map((version) => (
    version.versionId === versionId
      ? { ...version, heading: patch.heading, body: patch.body, updatedAtMs: patch.updatedAtMs }
      : version
  )))
}

export function appendManualDraftVersion(
  versions: readonly PrototypeDraftVersion[],
  input: Readonly<{ heading: string; body: string; createdAtMs: number }>,
): PrototypeDraftVersion[] {
  if (versions.length === 0) return [...versions]
  const parent = versions.at(-1)
  if (parent === undefined) return [...versions]
  const versionIndex = versions.filter((version) => version.source !== "baseline").length + 1
  const stripped = versions.map((version) => (
    version.label.endsWith(" 最新")
      ? {
          ...version,
          label: version.source === "agent"
            ? version.label.replace(/ 最新$/u, " AI")
            : version.label.replace(/ 最新$/u, ""),
        }
      : version
  ))
  stripped.push({
    versionId: `proto-manual-${String(input.createdAtMs)}`,
    parentVersionId: parent.versionId,
    source: "manual",
    label: `v${String(versionIndex)} 最新`,
    heading: input.heading,
    body: input.body,
    messageId: undefined,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs,
  })
  return relabelLatestDraftVersion(stripped)
}

export function formatDraftSavedAt(savedAtMs: number | undefined, nowMs = Date.now()): string {
  if (savedAtMs === undefined) return "尚未保存"
  const elapsedMs = nowMs - savedAtMs
  if (elapsedMs < 45_000) return "刚刚保存"
  if (elapsedMs < 3_600_000) return `${String(Math.max(1, Math.floor(elapsedMs / 60_000)))} 分钟前保存`
  return `${new Date(savedAtMs).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} 保存`
}

export function formatStatusBarSavedAt(
  savedAtMs: number | undefined,
  saveState: "idle" | "saving" | "saved" | "error",
  nowMs = Date.now(),
): string {
  if (saveState === "saving") return "保存中…"
  if (saveState === "error") return "保存失败"
  if (savedAtMs === undefined) return "尚未保存"
  const elapsedMs = nowMs - savedAtMs
  if (elapsedMs < 45_000) return "刚刚"
  if (elapsedMs < 3_600_000) return `${String(Math.max(1, Math.floor(elapsedMs / 60_000)))} 分钟前`
  return new Date(savedAtMs).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function computeLineDiff(base: string, head: string): DiffLine[] {
  const left = base.replace(/\r\n/gu, "\n").split("\n")
  const right = head.replace(/\r\n/gu, "\n").split("\n")
  const rows: DiffLine[] = []
  const max = Math.max(left.length, right.length)
  for (let index = 0; index < max; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) {
      if (a !== undefined) rows.push({ type: "context", text: a })
      continue
    }
    if (a !== undefined) rows.push({ type: "del", text: a })
    if (b !== undefined) rows.push({ type: "add", text: b })
  }
  return rows
}

export function countChapterCharacters(text: string): number {
  return text.replace(/\s+/gu, "").length
}
