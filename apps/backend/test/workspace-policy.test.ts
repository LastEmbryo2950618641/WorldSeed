import { describe, expect, it } from "vitest"

import {
  assertWorkspaceMutationAllowed,
  fixedWorkspaceEntries,
  validateWorkspaceInventory,
  WorkspacePolicyError,
} from "../src/index.js"

describe("workspace policy", () => {
  it("accepts the fixed manifest inventory and Markdown descendants", () => {
    const inventory = fixedWorkspaceEntries.map((entry) => ({
      path: entry.relativePath,
      kind: entry.entryKind,
    }))
    inventory.push({ path: "设定集/局部/资料.md", kind: "file" })

    expect(validateWorkspaceInventory(inventory)).toEqual([])
    expect(assertWorkspaceMutationAllowed("设定集/局部/资料.md", "file", "user")).toBe("设定集/局部/资料.md")
  })

  it("rejects a sixth root and non-Markdown files", () => {
    const inventory = [
      ...fixedWorkspaceEntries.map((entry) => ({ path: entry.relativePath, kind: entry.entryKind })),
      { path: "内部索引", kind: "directory" as const },
      { path: "参考文件/data.json", kind: "file" as const },
    ]
    const codes = validateWorkspaceInventory(inventory).map((issue) => issue.code)

    expect(codes).toContain("unexpected_root_entry")
    expect(codes).toContain("invalid_file_type")
  })

  it("separates user edits, platform projections, and chapter publishing", () => {
    expect(() => assertWorkspaceMutationAllowed("世界推演规则/基础规则/base-rules.md", "file", "user"))
      .toThrow(WorkspacePolicyError)
    expect(() => assertWorkspaceMutationAllowed("章节正文/第一章 开端.md", "file", "user"))
      .toThrow(WorkspacePolicyError)
    expect(assertWorkspaceMutationAllowed("章节正文/第一章 开端.md", "file", "chapter_publisher"))
      .toBe("章节正文/第一章 开端.md")
    expect(() => assertWorkspaceMutationAllowed("参考文件/data.json", "file", "user"))
      .toThrow(WorkspacePolicyError)
  })
})
