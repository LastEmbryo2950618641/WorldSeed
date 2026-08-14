import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { digest, IsomorphicGitHistoryAdapter } from "../src/index.js"
import type { HistoryManifest } from "@worldseed/contracts"

const temporaryDirectories: string[] = []
const projectId = "00000000-0000-4000-8000-000000000001"
const entryId = "00000000-0000-4000-8000-000000000002"
const branchId = "00000000-0000-4000-8000-000000000003"
const chainId = "00000000-0000-4000-8000-000000000004"

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("IsomorphicGitHistoryAdapter", () => {
  it("writes and verifies an isolated bare history snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-history-git-"))
    temporaryDirectories.push(root)
    const workspace = join(root, "workspace")
    const gitdir = join(root, "app-data", "projects", projectId, "history.git")
    writeFileSync(join(root, "outside-git-marker"), "unchanged", "utf8")
    const content = "# 第一章 开始\n\n正文。\n"
    const manifest = createManifest(content)
    const workspaceFile = manifest.workspace[0]
    if (workspaceFile === undefined) throw new Error("History manifest is missing its workspace file")
    const adapter = new IsomorphicGitHistoryAdapter(gitdir)

    const commitOid = await adapter.writeSnapshot({
      manifest,
      files: [{ gitPath: workspaceFile.gitPath, content }],
    })
    const snapshot = await adapter.readSnapshot(commitOid)

    expect(snapshot.manifest).toEqual(manifest)
    expect(snapshot.files).toEqual([{ gitPath: "workspace/章节正文/第一章 开始.md", content }])
    expect(existsSync(join(gitdir, "objects"))).toBe(true)
    expect(existsSync(join(workspace, ".git"))).toBe(false)
    expect(readFileSync(join(root, "outside-git-marker"), "utf8")).toBe("unchanged")
  })

  it("rejects content that does not match the manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "worldseed-history-git-"))
    temporaryDirectories.push(root)
    const adapter = new IsomorphicGitHistoryAdapter(join(root, "history.git"))
    const manifest = createManifest("expected")
    const workspaceFile = manifest.workspace[0]
    if (workspaceFile === undefined) throw new Error("History manifest is missing its workspace file")

    await expect(adapter.writeSnapshot({
      manifest,
      files: [{ gitPath: workspaceFile.gitPath, content: "changed" }],
    })).rejects.toThrow("digest mismatch")
  })
})

function createManifest(content: string): HistoryManifest {
  const contentWithoutDigest = {
    schemaVersion: 1 as const,
    projectId,
    entryId,
    branchId,
    createdAtMs: 1_000,
    committedSequence: 1,
    activeGeneration: 0,
    activeScopeIds: [],
    nodeHeads: [],
    linkHeads: [],
    documentHeads: [],
    modelContext: { chainId, messages: [] },
    workspace: [{
      relativePath: "章节正文/第一章 开始.md",
      gitPath: "workspace/章节正文/第一章 开始.md",
      digest: digest(content),
      size: Buffer.byteLength(content, "utf8"),
    }],
    baseRulesDigest: "base-rules",
  }
  return { ...contentWithoutDigest, digest: digest(contentWithoutDigest) }
}
