import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { NodeWorkspaceAdapter } from "../src/infrastructure/filesystem/node-workspace-adapter.js"
import { digest } from "../src/core/index.js"

describe("chapter publishing recovery", () => {
  it("recognizes the exact base version moved to the new title and retries idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-publish-recovery-"))
    const oldPath = "章节正文/第一卷 测试/第二章 日课.md"
    const newPath = "章节正文/第一卷 测试/第二章 补.md"
    const base = "# 第二章 日课\n\nOld chapter body.\n"
    const proposed = "# 第二章 补\n\nRevised chapter body.\n"
    try {
      await mkdir(join(root, "章节正文/第一卷 测试"), { recursive: true })
      await writeFile(join(root, oldPath), base)
      await rename(join(root, oldPath), join(root, newPath))
      const workspace = new NodeWorkspaceAdapter()
      await workspace.validatePublishedChapterReplacement(root, oldPath, newPath, digest(base), proposed)
      expect(await readFile(join(root, newPath), "utf8")).toBe(base)
      await workspace.replacePublishedChapter(root, oldPath, newPath, digest(base), proposed)
      await workspace.replacePublishedChapter(root, oldPath, newPath, digest(base), proposed)
      expect(await readFile(join(root, newPath), "utf8")).toBe(proposed)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it("preserves a different target even when the old path is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-publish-conflict-"))
    const path = "章节正文/第一卷 测试/第二章 补.md"
    try {
      await mkdir(join(root, "章节正文/第一卷 测试"), { recursive: true })
      await writeFile(join(root, path), "independent changes")
      await expect(new NodeWorkspaceAdapter().replacePublishedChapter(root, "章节正文/第一卷 测试/第二章 日课.md", path, digest("old body"), "replacement"))
        .rejects.toThrow("conflicts with an existing file")
      expect(await readFile(join(root, path), "utf8")).toBe("independent changes")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it("does not treat a duplicate base file as a rename while the original still exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-publish-duplicate-"))
    const oldPath = "章节正文/第一卷 测试/第二章 日课.md"
    const newPath = "章节正文/第一卷 测试/第二章 补.md"
    try {
      await mkdir(join(root, "章节正文/第一卷 测试"), { recursive: true })
      await writeFile(join(root, oldPath), "base")
      await writeFile(join(root, newPath), "base")
      const workspace = new NodeWorkspaceAdapter()
      await expect(workspace.replacePublishedChapter(root, oldPath, newPath, digest("base"), "replacement"))
        .rejects.toThrow("conflicts with an existing file")
      expect(await readFile(join(root, oldPath), "utf8")).toBe("base")
      expect(await readFile(join(root, newPath), "utf8")).toBe("base")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
