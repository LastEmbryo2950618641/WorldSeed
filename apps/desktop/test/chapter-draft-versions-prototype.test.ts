import { describe, expect, it } from "vitest"

import {
  appendManualDraftVersion,
  buildPrototypeDraftVersions,
  COMMITTED_DRAFT_VERSION_ID,
  formatDraftSavedAt,
  formatStatusBarSavedAt,
  mergeDraftVersionContent,
} from "../src/renderer/src/features/editor/chapter-draft-versions-prototype.js"

describe("chapter draft versions prototype", () => {
  it("labels the latest agent version", () => {
    const versions = buildPrototypeDraftVersions({
      committedHeading: "第一章",
      committedBody: "正文。",
      messages: [{
        messageId: "m1",
        revisionTaskId: "r1",
        projectId: "p1",
        role: "assistant",
        content: "扩写",
        proposal: { heading: "第一章", body: "正文。\n\n扩写。" },
        createdAtMs: 100,
      }],
    })
    expect(versions.at(-1)?.label).toBe("v1 AI 最新")
  })

  it("merges content into the latest version without adding a new entry", () => {
    const base = buildPrototypeDraftVersions({
      committedHeading: "第一章",
      committedBody: "正文。",
      messages: [{
        messageId: "m1",
        revisionTaskId: "r1",
        projectId: "p1",
        role: "assistant",
        content: "扩写",
        proposal: { heading: "第一章", body: "草稿 A" },
        createdAtMs: 100,
      }],
    })
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
      messages: [],
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
