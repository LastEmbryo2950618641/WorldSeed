import type { RevisionDraftVersion } from "@worldseed/contracts"

export type DraftVersionSource = "baseline" | "agent" | "manual" | "rollback"

export const COMMITTED_DRAFT_VERSION_ID = "proto-v0"

export type VersionMarkKind = "ordinal" | "current" | "covered"

export type VersionMark = Readonly<{
  kind: VersionMarkKind
  text: string
}>

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
  isCurrentOfficial?: boolean
  sequenceNo?: number
  title?: string
  marks?: readonly VersionMark[]
}>

export type DiffLine = Readonly<{
  type: "context" | "add" | "del"
  text: string
}>

export function fromPersistedDraftVersions(
  versions: readonly RevisionDraftVersion[],
): PrototypeDraftVersion[] {
  return versions.map((version, index) => ({
    versionId: version.versionId,
    parentVersionId: version.parentVersionId ?? undefined,
    source: version.source,
    label: displayPersistedDraftLabel(version, index),
    heading: version.heading,
    body: version.body,
    messageId: version.messageId ?? undefined,
    createdAtMs: version.createdAtMs,
    ...(version.isCurrentOfficial === undefined ? {} : { isCurrentOfficial: version.isCurrentOfficial }),
  }))
}

function draftSourceTag(source: DraftVersionSource | RevisionDraftVersion["source"]): string {
  if (source === "agent") return " AI"
  if (source === "rollback") return " 回退"
  return ""
}

export function isCoveringDraft(version: Readonly<{ source: DraftVersionSource; isCurrentOfficial?: boolean }>): boolean {
  return version.source !== "baseline" && version.isCurrentOfficial === true
}

export function preferredWorkingDraftId(drafts: readonly PrototypeDraftVersion[]): string | undefined {
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const version = drafts[index]
    if (version !== undefined && !isCoveringDraft(version)) return version.versionId
  }
  return drafts.at(-1)?.versionId
}

export function draftDisplayModeForSelection(
  drafts: readonly PrototypeDraftVersion[],
  versionId: string,
): "edit" | "view" {
  if (drafts.length === 0) return "edit"
  const version = drafts.find((item) => item.versionId === versionId)
  if (version === undefined || isCoveringDraft(version)) return "view"
  return version.versionId === drafts.at(-1)?.versionId ? "edit" : "view"
}

export function joinVersionLabel(title: string, marks: readonly VersionMark[]): string {
  return [title, ...marks.map((mark) => mark.text)].join(" · ")
}

function withVersionPresentation(
  version: PrototypeDraftVersion,
  input: Readonly<{ title: string; sequenceNo: number; marks: readonly VersionMark[] }>,
): PrototypeDraftVersion {
  return {
    ...version,
    sequenceNo: input.sequenceNo,
    title: input.title,
    marks: input.marks,
    label: joinVersionLabel(input.title, input.marks),
  }
}

function sortByCreatedAt(versions: readonly PrototypeDraftVersion[]): PrototypeDraftVersion[] {
  return [...versions].sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs
    return left.versionId.localeCompare(right.versionId)
  })
}

export function presentOfficialAxis(versions: readonly PrototypeDraftVersion[]): PrototypeDraftVersion[] {
  const ordered = sortByCreatedAt(versions)
  const currentId = ordered.find((version) => version.isCurrentOfficial === true)?.versionId
    ?? ordered.at(-1)?.versionId
  return ordered.map((version, index) => {
    const sequenceNo = index + 1
    const current = version.versionId === currentId
    return withVersionPresentation(version, {
      title: current ? "当前正文" : "正文",
      sequenceNo,
      marks: [{ kind: current ? "current" : "ordinal", text: `v${String(sequenceNo)}` }],
    })
  })
}

export function presentDraftAxis(versions: readonly PrototypeDraftVersion[]): PrototypeDraftVersion[] {
  const ordered = sortByCreatedAt(versions.filter((version) => version.source !== "baseline"))
  return ordered.map((version, index) => {
    const sequenceNo = index + 1
    const marks: VersionMark[] = [{ kind: "ordinal", text: `v${String(sequenceNo)}` }]
    if (isCoveringDraft(version)) marks.push({ kind: "covered", text: "已覆盖正文" })
    return withVersionPresentation(version, {
      title: "草稿",
      sequenceNo,
      marks,
    })
  })
}

function displayPersistedDraftLabel(
  version: RevisionDraftVersion,
  index: number,
): string {
  if (isCoveringDraft(version)) {
    return `${version.label}${draftSourceTag(version.source)} · 已覆盖正文`
  }
  if (version.source === "baseline" && index === 0) {
    return version.isCurrentOfficial === false ? "历史正文" : "正文"
  }
  if (version.source === "baseline") return `历史正文 ${String(index + 1)}`
  return `${version.label}${draftSourceTag(version.source)}${version.isLatest ? " 最新" : ""}`
}

export function buildPrototypeDraftVersions(input: Readonly<{
  committedHeading: string
  committedBody: string
}>): PrototypeDraftVersion[] {
  return [{
    versionId: COMMITTED_DRAFT_VERSION_ID,
    parentVersionId: undefined,
    source: "baseline",
    label: "正文",
    heading: input.committedHeading,
    body: input.committedBody,
    messageId: undefined,
    createdAtMs: 0,
    isCurrentOfficial: true,
  }]
}

export function splitChapterPickerVersions(versions: readonly PrototypeDraftVersion[]): Readonly<{
  official: PrototypeDraftVersion[]
  drafts: PrototypeDraftVersion[]
}> {
  const drafts = presentDraftAxis(versions)
  const official = presentOfficialAxis(versions.filter((version) => (
    version.source === "baseline" || version.isCurrentOfficial === true
  )))
  return { official, drafts }
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
    if (isLast && version.source !== "baseline" && !isCoveringDraft(version) && !version.label.endsWith(" 最新")) {
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
