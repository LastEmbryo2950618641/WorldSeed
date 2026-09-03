import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { buildTree, WorkspaceTree } from "../src/renderer/src/features/workspace/WorkspaceTree.js"
import {
  canCreateFolderInDirectory,
  canCreateMarkdownInDirectory,
  canDeleteWorkspacePath,
  resolveCreateDestination,
  resolveWorkspaceLockKind,
} from "../src/renderer/src/features/workspace/workspace-locks.js"

describe("workspace locks", () => {
  it("locks platform rules and scaffolding without treating every top-level folder as read-only", () => {
    expect(resolveWorkspaceLockKind("设定集")).toBe("immutable_scaffold")
    expect(resolveWorkspaceLockKind("设定集/readme.md")).toBe("immutable_scaffold")
    expect(resolveWorkspaceLockKind("设定集/人物/顾青衡.md")).toBeUndefined()
    expect(resolveWorkspaceLockKind("世界推演规则/基础规则/base-rules.md")).toBe("platform_readonly")
    expect(resolveWorkspaceLockKind("章节正文/第一章 开端.md")).toBe("chapter_workflow")
    expect(resolveWorkspaceLockKind("章节正文/第一章 开端 [剧情梗概].md")).toBeUndefined()
    expect(canDeleteWorkspacePath("设定集/人物/顾青衡.md")).toBe(true)
    expect(canDeleteWorkspacePath("设定集/readme.md")).toBe(false)
    expect(canCreateMarkdownInDirectory("表现输出/笔风规则")).toBe(true)
    expect(canCreateFolderInDirectory("表现输出/笔风规则")).toBe(true)
    expect(canCreateFolderInDirectory("章节正文")).toBe(true)
    expect(canCreateFolderInDirectory("章节正文/第一卷 测试")).toBe(false)
    expect(canCreateMarkdownInDirectory("世界推演规则/基础规则")).toBe(false)
    expect(resolveCreateDestination("设定集/人物/顾青衡.md")).toBe("设定集/人物")
    expect(resolveCreateDestination("世界推演规则/基础规则/base-rules.md")).toBe("设定集")
    expect(resolveCreateDestination("表现输出/笔风规则")).toBe("表现输出/笔风规则")
  })

  it("does not mark every top-level directory with a read-only lock badge", () => {
    const html = renderToStaticMarkup(React.createElement(WorkspaceTree, {
      entries: [
        { path: "设定集", kind: "directory" },
        { path: "设定集/人物.md", kind: "file" },
        { path: "参考文件", kind: "directory" },
        { path: "表现输出/笔风规则", kind: "directory" },
        { path: "世界推演规则/基础规则", kind: "directory" },
        { path: "世界推演规则/基础规则/base-rules.md", kind: "file" },
      ],
      selectedPath: "设定集/人物.md",
      onSelect: () => {},
      onSelectLineage: () => {},
      onRefresh: () => {},
      onCreateMarkdown: () => {},
      onCreateDirectory: () => {},
      onDeletePath: () => {},
    }))
    expect(html).toContain('aria-label="新建 Markdown"')
    expect(html).toContain('aria-label="新建文件夹"')
    expect(html).not.toContain("上传")
    expect(html).toContain('aria-label="在 笔风规则 下新建 Markdown"')
    expect(html).toContain('aria-label="在 笔风规则 下新建文件夹"')
    expect(html).toContain('aria-label="删除 人物.md"')
    expect(html).toContain("平台只读")
    expect(html).not.toContain("只读</span>")
  })

  it("assembles nested inventory even when parents are missing from the list", () => {
    const tree = buildTree([
      { path: "设定集/人物/顾青衡.md", kind: "file" },
      { path: "表现输出/笔风规则/默认笔风规则.md", kind: "file" },
    ])
    const settings = tree.find((node) => node.path === "设定集")
    expect(settings?.children[0]?.path).toBe("设定集/人物")
    expect(settings?.children[0]?.children[0]?.path).toBe("设定集/人物/顾青衡.md")
  })
})
