import { describe, expect, it } from "vitest"

import {
  formatSynopsisSearchLabel,
  grepMarkdownContent,
  selectSynopsisWorkspaceEntries,
  sliceMarkdownLines,
} from "../src/application/chapters/synopsis-workspace-reads.js"
import type { WorkspaceCatalogSnapshot } from "@worldseed/contracts"

const catalog: WorkspaceCatalogSnapshot = {
  snapshotId: "snap",
  projectId: "11111111-1111-4111-8111-111111111111",
  createdAtMs: 1,
  digest: "d",
  entries: [
    {
      relativePath: "设定集",
      entryKind: "directory",
      role: "settings",
      version: 1,
      digest: "dir",
      size: 0,
    },
    {
      relativePath: "设定集/readme.md",
      entryKind: "file",
      role: "settings",
      version: 1,
      digest: "a",
      size: 44,
    },
    {
      relativePath: "设定集/角色/主角.md",
      entryKind: "file",
      role: "settings",
      version: 1,
      digest: "b",
      size: 12_000,
    },
    {
      relativePath: "暂存区/弧线规划.md",
      entryKind: "file",
      role: "staging",
      version: 1,
      digest: "c",
      size: 800,
    },
    {
      relativePath: "表现输出/笔风规则/默认笔风规则.md",
      entryKind: "file",
      role: "presentation",
      version: 1,
      digest: "p1",
      size: 120,
    },
    {
      relativePath: "表现输出/描写规则/默认描写规则.md",
      entryKind: "file",
      role: "presentation",
      version: 1,
      digest: "p2",
      size: 140,
    },
    {
      relativePath: "世界推演规则/用户规则.md",
      entryKind: "file",
      role: "world_rules",
      version: 1,
      digest: "w1",
      size: 90,
    },
  ],
}

function readRequest(partial: {
  exactKeys?: string[]
  semanticTexts?: string[]
  readMode?: "read_full" | "list" | "grep"
  sourceKinds?: Array<"reference" | "rule" | "source">
}): Parameters<typeof selectSynopsisWorkspaceEntries>[1] {
  return {
    requestId: "22222222-2222-4222-8222-222222222222",
    reason: "test",
    expectedEvidence: "evidence",
    query: {
      exactKeys: partial.exactKeys ?? [],
      semanticTexts: partial.semanticTexts ?? [],
      anchorIds: [],
      directions: ["both"],
      maxCandidates: 24,
      maxDepth: 2,
      sourceKinds: partial.sourceKinds ?? ["reference"],
      ...(partial.readMode === undefined ? {} : { readMode: partial.readMode }),
    },
  }
}

describe("synopsis workspace reads helpers", () => {
  it("selects files by exact path and includes staging for reference", () => {
    const selected = selectSynopsisWorkspaceEntries(
      catalog,
      readRequest({ exactKeys: ["设定集/角色/主角.md"] }),
      5,
      false,
    )
    expect(selected.map((entry) => entry.relativePath)).toEqual(["设定集/角色/主角.md"])
  })

  it("greps content with context windows merged across nearby hits", () => {
    const content = [
      "line1",
      "alpha here",
      "line3",
      "line4",
      "also ALPHA again",
      "line6",
    ].join("\n")
    const snippets = grepMarkdownContent({
      content,
      keywords: ["alpha"],
      contextLines: 1,
      maxMatches: 10,
    })
    // Nearby hits with context merge into one window spanning both.
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toMatchObject({ lineStart: 1, lineEnd: 6, hitLines: [2, 5] })
    expect(snippets[0]?.text).toContain("alpha here")
    expect(snippets[0]?.text).toContain("also ALPHA again")
  })

  it("keeps distant grep hits as separate windows", () => {
    const content = ["a", "alpha", "b", "c", "d", "e", "f", "alpha", "g"].join("\n")
    const snippets = grepMarkdownContent({
      content,
      keywords: ["alpha"],
      contextLines: 0,
      maxMatches: 10,
    })
    expect(snippets).toHaveLength(2)
    expect(snippets[0]).toMatchObject({ lineStart: 2, lineEnd: 2 })
    expect(snippets[1]).toMatchObject({ lineStart: 8, lineEnd: 8 })
  })

  it("slices markdown by inclusive 1-based line range", () => {
    const sliced = sliceMarkdownLines("a\nb\nc\nd", 2, 3)
    expect(sliced).toEqual({
      text: "b\nc",
      ranged: true,
      lineStart: 2,
      lineEnd: 3,
      totalLines: 4,
    })
  })

  it("labels search mode in the UI string", () => {
    expect(formatSynopsisSearchLabel(readRequest({
      exactKeys: ["设定集/"],
      readMode: "list",
    }))).toBe("list(reference): 设定集/")
    expect(formatSynopsisSearchLabel(readRequest({
      exactKeys: ["设定集/角色/主角.md"],
      semanticTexts: ["灵根"],
      readMode: "grep",
    }))).toContain("grep(reference):")
  })

  it("selects presentation rules when sourceKinds includes rule", () => {
    const selected = selectSynopsisWorkspaceEntries(
      catalog,
      readRequest({
        exactKeys: ["表现输出/笔风规则/默认笔风规则.md"],
        sourceKinds: ["rule"],
      }),
      5,
      false,
    )
    expect(selected.map((entry) => entry.relativePath)).toEqual([
      "表现输出/笔风规则/默认笔风规则.md",
    ])
  })

  it("still selects world rules under rule sourceKind", () => {
    const selected = selectSynopsisWorkspaceEntries(
      catalog,
      readRequest({
        exactKeys: ["世界推演规则/用户规则.md"],
        sourceKinds: ["rule"],
      }),
      5,
      false,
    )
    expect(selected.map((entry) => entry.relativePath)).toEqual([
      "世界推演规则/用户规则.md",
    ])
  })

  it("unlocks presentation when exact path mentions 笔风/描写 even without rule kind", () => {
    const selected = selectSynopsisWorkspaceEntries(
      catalog,
      readRequest({
        exactKeys: ["表现输出/笔风规则/默认笔风规则.md"],
        sourceKinds: ["reference"],
      }),
      5,
      false,
    )
    expect(selected.map((entry) => entry.relativePath)).toEqual([
      "表现输出/笔风规则/默认笔风规则.md",
    ])
  })
})
