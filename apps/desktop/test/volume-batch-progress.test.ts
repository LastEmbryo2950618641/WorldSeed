import { describe, expect, it } from "vitest"

import {
  buildVolumeBatchProgress,
  PUBLISHING_REVISION_STATUSES,
  volumeBatchProgressStageLabel,
} from "../src/renderer/src/features/editor/volume-batch-deduction.js"

describe("volume batch progress", () => {
  const chapters = [
    { sequence: 1, label: "第一章", bodyPath: "章节正文/卷一/第一章.md" },
    { sequence: 2, label: "第二章", bodyPath: "章节正文/卷一/第二章.md" },
    { sequence: 3, label: "第三章", outlinePath: "章节正文/卷一/第三章 [剧情细纲].md" },
    { sequence: 4, label: "第四章" },
  ]

  it("marks submitted chapters as publishing ahead of draft/body", () => {
    const rows = buildVolumeBatchProgress(chapters, new Set([3]), new Set([2]))
    expect(rows.map((row) => row.stage)).toEqual(["body", "publishing", "draft", "empty"])
    expect(rows.filter((row) => row.done)).toHaveLength(1)
    expect(volumeBatchProgressStageLabel("publishing")).toBe("图修订中")
  })

  it("treats graph sync statuses as publishing", () => {
    expect(PUBLISHING_REVISION_STATUSES.has("graph_sync_pending")).toBe(true)
    expect(PUBLISHING_REVISION_STATUSES.has("editing")).toBe(false)
  })
})
