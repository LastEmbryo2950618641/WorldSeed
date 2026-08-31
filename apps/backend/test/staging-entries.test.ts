import { describe, expect, it } from "vitest"

import {
  evictStagingEntries,
  mergeStagingPatches,
  parseStagingEntries,
  serializeStagingEntries,
} from "../src/application/chapters/staging-entries.js"

describe("staging entries", () => {
  it("round-trips parse and serialize", () => {
    const markdown = serializeStagingEntries("本章讨论笔记", [{
      entryId: "e1",
      title: "清冷求道",
      body: "基调已确认",
      status: "open",
      updatedAtMs: 100,
    }])
    const parsed = parseStagingEntries(markdown)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.entryId).toBe("e1")
    expect(parsed[0]?.title).toBe("清冷求道")
    expect(parsed[0]?.body).toContain("基调已确认")
  })

  it("merges patches without downgrading settled", () => {
    const merged = mergeStagingPatches(
      [{
        entryId: "e1",
        title: "旧",
        body: "旧正文",
        status: "settled",
        updatedAtMs: 1,
        settledAtMs: 1,
      }],
      [{ entryId: "e1", title: "新", body: "新正文", status: "open" }],
      50,
      () => "x",
    )
    expect(merged[0]?.status).toBe("settled")
    expect(merged[0]?.body).toBe("新正文")
  })

  it("evicts settled before open when over budget", () => {
    const openEntry = {
      entryId: "open",
      title: "进行中",
      body: "y".repeat(20),
      status: "open" as const,
      updatedAtMs: 2,
    }
    const settledEntry = {
      entryId: "old-settled",
      title: "旧已落盘",
      body: "x".repeat(400),
      status: "settled" as const,
      updatedAtMs: 1,
      settledAtMs: 1,
    }
    const openOnlyChars = serializeStagingEntries("本章讨论笔记", [openEntry]).length
    const files = {
      "暂存区/本章讨论笔记.md": [settledEntry, openEntry],
    }
    const result = evictStagingEntries(
      files,
      openOnlyChars + 10,
      (_key, entries) => serializeStagingEntries("本章讨论笔记", entries),
    )
    expect(result.removedTitles).toContain("旧已落盘")
    expect(result.files["暂存区/本章讨论笔记.md"]?.some((entry) => entry.entryId === "open")).toBe(true)
  })
})
