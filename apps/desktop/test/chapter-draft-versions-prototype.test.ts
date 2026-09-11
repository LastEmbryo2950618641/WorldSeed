import { describe, expect, it } from "vitest"

import {
  appendManualDraftVersion,
  buildPrototypeDraftVersions,
  COMMITTED_DRAFT_VERSION_ID,
  formatDraftSavedAt,
  formatStatusBarSavedAt,
  draftDisplayModeForSelection,
  fromPersistedDraftVersions,
  preferredWorkingDraftId,
  splitChapterPickerVersions,
  mergeDraftVersionContent,
} from "../src/renderer/src/features/editor/chapter-draft-versions-prototype.js"

describe("chapter draft versions prototype", () => {
  it("labels persisted agent versions as latest", () => {
    const versions = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "正文。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v1",
        heading: "第一章",
        body: "正文。\n\n扩写。",
        bodyDigest: "d1",
        createdAtMs: 2,
        isLatest: true,
      },
    ])
    expect(versions.at(-1)?.label).toBe("v1 AI 最新")
  })

  it("merges content into the latest version without adding a new entry", () => {
    const base = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "正文。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v1",
        heading: "第一章",
        body: "草稿 A",
        bodyDigest: "d1",
        createdAtMs: 2,
        isLatest: true,
      },
    ])
    const latestId = base.at(-1)?.versionId
    expect(latestId).toBeDefined()
    const merged = mergeDraftVersionContent(base, latestId!, {
      heading: "第一章",
      body: "草稿 B",
      updatedAtMs: 200,
    })
    expect(merged).toHaveLength(base.length)
    expect(merged.at(-1)?.body).toBe("草稿 B")
    expect(merged.at(-1)?.updatedAtMs).toBe(200)
    expect(merged.at(-1)?.label).toBe("v1 AI 最新")
  })

  it("appends a manual draft version from the current latest", () => {
    const base = buildPrototypeDraftVersions({
      committedHeading: "第一章",
      committedBody: "正文。",
    })
    const next = appendManualDraftVersion(base, {
      heading: "第一章",
      body: "手动草稿",
      createdAtMs: 300,
    })
    expect(next).toHaveLength(2)
    expect(next[0]?.versionId).toBe(COMMITTED_DRAFT_VERSION_ID)
    expect(next.at(-1)?.source).toBe("manual")
    expect(next.at(-1)?.label).toBe("v1 最新")
    expect(next.at(-1)?.body).toBe("手动草稿")
  })

  it("maps persisted backend drafts so agent versions appear next to 正文", () => {
    const versions = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "正式正文。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v1",
        heading: "第一章",
        body: "Agent 草稿。",
        bodyDigest: "d1",
        createdAtMs: 2,
        isLatest: true,
      },
    ])
    expect(versions[0]?.label).toBe("正文")
    expect(versions[1]?.label).toBe("v1 AI 最新")
    expect(versions[1]?.body).toBe("Agent 草稿。")
  })

  it("marks a covering draft as the current official body and keeps the previous body", () => {
    const versions = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "旧正文。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v2",
        heading: "第一章",
        body: "覆盖后的正文。",
        bodyDigest: "d2",
        createdAtMs: 2,
        isLatest: true,
        isCurrentOfficial: true,
      },
    ])
    expect(versions[0]?.label).toBe("历史正文")
    expect(versions[1]?.label).toBe("v2 AI · 已覆盖正文")
    const split = splitChapterPickerVersions(versions)
    expect(split.official.map((version) => version.label)).toEqual(["正文 · v1", "当前正文 · v2"])
    expect(split.drafts.map((version) => version.label)).toEqual(["草稿 · v1 · 已覆盖正文"])
  })

  it("splits official body versions from draft versions", () => {
    const versions = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "旧正文。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v1",
        heading: "第一章",
        body: "中间草稿。",
        bodyDigest: "d1",
        createdAtMs: 2,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111004",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111003",
        source: "agent",
        label: "v2",
        heading: "第一章",
        body: "覆盖后的正文。",
        bodyDigest: "d2",
        createdAtMs: 3,
        isLatest: true,
        isCurrentOfficial: true,
      },
    ])
    const split = splitChapterPickerVersions(versions)
    expect(split.official.map((version) => version.label)).toEqual(["正文 · v1", "当前正文 · v2"])
    expect(split.drafts.map((version) => version.label)).toEqual(["草稿 · v1", "草稿 · v2 · 已覆盖正文"])
    expect(split.official.map((version) => version.marks?.map((mark) => mark.kind))).toEqual([["ordinal"], ["current"]])
    expect(split.drafts[1]?.marks?.map((mark) => mark.text)).toEqual(["v2", "已覆盖正文"])
    expect(preferredWorkingDraftId(split.drafts)).toBe(versions[1]?.versionId)
    expect(draftDisplayModeForSelection(split.drafts, versions[1]!.versionId)).toBe("view")
    expect(draftDisplayModeForSelection(split.drafts, versions[2]!.versionId)).toBe("view")
  })

  it("numbers official and draft axes independently as more versions accumulate", () => {
    const versions = fromPersistedDraftVersions([
      {
        versionId: "11111111-1111-4111-8111-111111111001",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0",
        heading: "第一章",
        body: "正文一。",
        bodyDigest: "d0",
        createdAtMs: 1,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111003",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111001",
        source: "agent",
        label: "v1",
        heading: "第一章",
        body: "草稿一。",
        bodyDigest: "d1",
        createdAtMs: 2,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111004",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111003",
        source: "agent",
        label: "v2",
        heading: "第一章",
        body: "正文二。",
        bodyDigest: "d2",
        createdAtMs: 3,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111005",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        source: "baseline",
        label: "v0b",
        heading: "第一章",
        body: "正文二。",
        bodyDigest: "d2b",
        createdAtMs: 4,
        isLatest: false,
        isCurrentOfficial: false,
      },
      {
        versionId: "11111111-1111-4111-8111-111111111006",
        projectId: "11111111-1111-4111-8111-111111111000",
        revisionTaskId: "11111111-1111-4111-8111-111111111002",
        parentVersionId: "11111111-1111-4111-8111-111111111004",
        source: "agent",
        label: "v3",
        heading: "第一章",
        body: "正文三。",
        bodyDigest: "d3",
        createdAtMs: 5,
        isLatest: true,
        isCurrentOfficial: true,
      },
    ])
    const split = splitChapterPickerVersions(versions)
    expect(split.official.map((version) => version.label)).toEqual(["正文 · v1", "正文 · v2", "当前正文 · v3"])
    expect(split.drafts.map((version) => version.label)).toEqual([
      "草稿 · v1",
      "草稿 · v2",
      "草稿 · v3 · 已覆盖正文",
    ])
  })

  it("formats saved-at labels for recent and older timestamps", () => {
    const now = 1_000_000
    expect(formatDraftSavedAt(undefined, now)).toBe("尚未保存")
    expect(formatDraftSavedAt(now - 10_000, now)).toBe("刚刚保存")
    expect(formatDraftSavedAt(now - 120_000, now)).toBe("2 分钟前保存")
  })

  it("formats status bar saved labels", () => {
    const now = 1_000_000
    expect(formatStatusBarSavedAt(undefined, "idle", now)).toBe("尚未保存")
    expect(formatStatusBarSavedAt(now - 10_000, "saved", now)).toBe("刚刚")
    expect(formatStatusBarSavedAt(now - 10_000, "saving", now)).toBe("保存中…")
  })
})
