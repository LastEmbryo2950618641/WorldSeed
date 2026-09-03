import { describe, expect, it } from "vitest"

import {
  assertUserCanCreateDirectory,
  assertUserCanCreateMarkdown,
  assertUserCanDeleteVolumeDirectory,
  assertUserCanDeleteMarkdown,
  assertWorkspaceMutationAllowed,
  fixedWorkspaceEntries,
  isPlatformLockedPath,
  resolveWorkspaceLockKind,
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
    expect(assertWorkspaceMutationAllowed("设定集/readme.md", "file", "user")).toBe("设定集/readme.md")
  })

  it("rejects a seventh unknown root and non-Markdown files", () => {
    const inventory = [
      ...fixedWorkspaceEntries.map((entry) => ({ path: entry.relativePath, kind: entry.entryKind })),
      { path: "内部索引", kind: "directory" as const },
      { path: "参考文件/data.json", kind: "file" as const },
    ]
    const codes = validateWorkspaceInventory(inventory).map((issue) => issue.code)

    expect(codes).toContain("unexpected_root_entry")
    expect(codes).toContain("invalid_file_type")
  })

  it("accepts staging root markdown edits", () => {
    expect(assertWorkspaceMutationAllowed("暂存区/本章讨论笔记.md", "file", "user")).toBe("暂存区/本章讨论笔记.md")
    expect(assertWorkspaceMutationAllowed("暂存区/readme.md", "file", "platform")).toBe("暂存区/readme.md")
  })

  it("rejects synopsis files that lack 第N章 or sit outside a volume", () => {
    expect(() => assertWorkspaceMutationAllowed("章节正文/第一卷 测试/第一桶金 [剧情梗概].md", "file", "user"))
      .toThrow(WorkspacePolicyError)
    expect(() => assertWorkspaceMutationAllowed("章节正文/第一卷 测试/第一桶金 [剧情梗概].md", "file", "platform"))
      .toThrow(/第N章/)
    const inventory = [
      ...fixedWorkspaceEntries.map((entry) => ({ path: entry.relativePath, kind: entry.entryKind })),
      { path: "章节正文/第一桶金 [剧情梗概].md", kind: "file" as const },
      { path: "章节正文/坏卷名", kind: "directory" as const },
    ]
    const issues = validateWorkspaceInventory(inventory)
    expect(issues.some((issue) => issue.code === "chapter_missing_volume")).toBe(true)
    expect(issues.some((issue) => issue.code === "invalid_volume_name")).toBe(true)
  })

  it("separates user edits, platform projections, and chapter publishing under volumes", () => {
    expect(() => assertWorkspaceMutationAllowed("世界推演规则/基础规则/base-rules.md", "file", "user"))
      .toThrow(WorkspacePolicyError)
    expect(() => assertWorkspaceMutationAllowed("章节正文/第一章 开端.md", "file", "user"))
      .toThrow(WorkspacePolicyError)
    expect(() => assertWorkspaceMutationAllowed("章节正文/第一章 开端.md", "file", "chapter_publisher"))
      .toThrow(/卷/)
    expect(assertWorkspaceMutationAllowed("章节正文/第一卷 测试/第一章 开端 [剧情梗概].md", "file", "user"))
      .toBe("章节正文/第一卷 测试/第一章 开端 [剧情梗概].md")
    expect(assertWorkspaceMutationAllowed("章节正文/第一卷 测试/第一章 开端 [剧情梗概].md", "file", "platform"))
      .toBe("章节正文/第一卷 测试/第一章 开端 [剧情梗概].md")
    expect(assertWorkspaceMutationAllowed("章节正文/第一卷 测试/第一章 开端.md", "file", "chapter_publisher"))
      .toBe("章节正文/第一卷 测试/第一章 开端.md")
    expect(assertWorkspaceMutationAllowed("章节正文/第一卷 测试", "directory", "user"))
      .toBe("章节正文/第一卷 测试")
    expect(() => assertWorkspaceMutationAllowed("章节正文/坏名字", "directory", "user"))
      .toThrow(/第N卷/)
    expect(() => assertWorkspaceMutationAllowed("参考文件/data.json", "file", "user"))
      .toThrow(WorkspacePolicyError)
  })

  it("allows creating user markdown and blocks platform / immutable deletes", () => {
    expect(assertUserCanCreateMarkdown("设定集/人物/顾青衡.md")).toBe("设定集/人物/顾青衡.md")
    expect(assertUserCanDeleteMarkdown("设定集/人物/顾青衡.md")).toBe("设定集/人物/顾青衡.md")
    expect(() => assertUserCanDeleteMarkdown("设定集/readme.md")).toThrow(/固定脚手架/)
    expect(() => assertUserCanDeleteMarkdown("世界推演规则/基础规则/base-rules.md")).toThrow(/平台只读/)
    expect(() => assertUserCanCreateMarkdown("世界推演规则/基础规则/extra.md")).toThrow(/平台只读/)
    expect(() => assertUserCanDeleteMarkdown("章节正文/第一卷 测试/第一章 开端.md")).toThrow(/正式章节/)
    expect(assertUserCanDeleteMarkdown("章节正文/第一卷 测试/第二章 标题 [剧情梗概].md"))
      .toBe("章节正文/第一卷 测试/第二章 标题 [剧情梗概].md")
  })

  it("allows creating folders under writable roots and volume folders under chapters", () => {
    expect(assertUserCanCreateDirectory("表现输出/笔风规则/自定义")).toBe("表现输出/笔风规则/自定义")
    expect(assertUserCanCreateDirectory("设定集/人物")).toBe("设定集/人物")
    expect(assertUserCanCreateDirectory("章节正文/第一卷 潮水退去时")).toBe("章节正文/第一卷 潮水退去时")
    expect(() => assertUserCanCreateDirectory("设定集")).toThrow(/固定脚手架/)
    expect(() => assertUserCanCreateDirectory("暂存区/子目录")).toThrow(/不允许/)
    expect(() => assertUserCanCreateDirectory("世界推演规则/基础规则/extra")).toThrow(/平台只读/)
  })

  it("flags duplicate volume sequences in inventory", () => {
    const inventory = [
      ...fixedWorkspaceEntries.map((entry) => ({ path: entry.relativePath, kind: entry.entryKind })),
      { path: "章节正文/第一卷 待命名", kind: "directory" as const },
      { path: "章节正文/第一卷 潮水退去时", kind: "directory" as const },
    ]
    const issues = validateWorkspaceInventory(inventory)
    expect(issues.some((issue) => issue.code === "duplicate_volume_sequence")).toBe(true)
  })

  it("allows deleting empty volume directories and blocks chapter body deletes", () => {
    expect(assertUserCanDeleteVolumeDirectory("章节正文/第一卷 测试")).toBe("章节正文/第一卷 测试")
    expect(assertUserCanDeleteVolumeDirectory("章节正文/坏卷名")).toBe("章节正文/坏卷名")
    expect(() => assertUserCanDeleteVolumeDirectory("章节正文")).toThrow(/卷文件夹/)
    expect(() => assertUserCanDeleteMarkdown("章节正文/第一卷 测试/第一章 开端.md")).toThrow(/正式章节/)
  })

  it("does not lock bare volume folders as chapter_workflow", () => {
    expect(resolveWorkspaceLockKind("章节正文/第一卷 测试")).toBeUndefined()
    expect(resolveWorkspaceLockKind("章节正文/坏卷名")).toBeUndefined()
    expect(resolveWorkspaceLockKind("章节正文")).toBe("chapter_workflow")
    expect(resolveWorkspaceLockKind("章节正文/第一卷 测试/第一章 开端.md")).toBe("chapter_workflow")
  })

  it("classifies lock kinds for UI", () => {
    expect(isPlatformLockedPath("世界推演规则/基础规则/plot-synopsis-guide.md")).toBe(true)
    expect(resolveWorkspaceLockKind("设定集")).toBe("immutable_scaffold")
    expect(resolveWorkspaceLockKind("设定集/readme.md")).toBe("immutable_scaffold")
    expect(resolveWorkspaceLockKind("设定集/人物/顾青衡.md")).toBeUndefined()
    expect(resolveWorkspaceLockKind("章节正文")).toBe("chapter_workflow")
  })
})
