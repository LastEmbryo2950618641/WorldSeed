import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION } from "@worldseed/contracts"
import type {
  SettingsLineageCommitResult,
  SettingsLineageListResult,
  SettingsLineagePathsResult,
  SettingsLineageReadAsOfResult,
} from "@worldseed/contracts"

import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Settings Lineage Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

async function invoke<T>(harness: ChapterHarness, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) expect.fail(JSON.stringify(response.error))
  return response.data as T
}

describe("settings lineage", () => {
  it("seeds existing settings and records workspace.save along timeline", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const dir = join(harness.workspaceRootRef, "设定集", "人物")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "林照.md"), "# 林照\n\n凡人盐工。\n", "utf8")

      const paths = await invoke<SettingsLineagePathsResult>(harness, "settings.lineage.paths", base)
      expect(paths.paths.some((path) => path.endsWith("林照.md") || path.includes("readme.md"))).toBe(true)

      await invoke(harness, "workspace.save", {
        ...base,
        relativePath: "设定集/人物/林照.md",
        content: "# 林照\n\n觉醒血脉后的盐工。\n",
      })

      const listed = await invoke<SettingsLineageListResult>(harness, "settings.lineage.list", {
        ...base,
        relativePath: "设定集/人物/林照.md",
      })
      expect(listed.entries.length).toBeGreaterThanOrEqual(1)
      expect(listed.entries[0]?.sourceKind).toBe("workspace_save")

      const commit = await invoke<SettingsLineageCommitResult>(harness, "settings.lineage.getCommit", {
        ...base,
        commitId: listed.entries[0]!.commitId,
      })
      expect(commit.markdown).toContain("觉醒血脉")
      expect(commit.previousMarkdown === undefined || commit.previousMarkdown.includes("凡人")).toBe(true)
    })
  }, 30_000)

  it("reads settings as-of a chapter via settings.lineage.readAsOf", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const dir = join(harness.workspaceRootRef, "设定集", "人物")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "林照.md"), "# 林照\n\n初版。\n", "utf8")

      await invoke(harness, "settings.lineage.paths", base)

      await invoke(harness, "workspace.save", {
        ...base,
        relativePath: "设定集/人物/林照.md",
        content: "# 林照\n\n当前真相。\n",
      })

      const asOf = await invoke<SettingsLineageReadAsOfResult>(harness, "settings.lineage.readAsOf", {
        ...base,
        relativePath: "设定集/人物/林照.md",
        chapterSequence: 1,
      })
      expect(asOf.markdown).toContain("当前真相")
      expect(asOf.commitSeq).toBeGreaterThan(0)
    })
  }, 30_000)

  it("realigns lineage after history restore when disk diverges from heads", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const dir = join(harness.workspaceRootRef, "设定集", "人物")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, "林照.md")
      writeFileSync(path, "# 林照\n\n账本版。\n", "utf8")

      await invoke(harness, "settings.lineage.paths", base)

      writeFileSync(path, "# 林照\n\n恢复后磁盘版。\n", "utf8")

      const runtime = await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef)
      const realigned = await runtime.createSettingsLineageService().realignAfterHistoryRestore("test-entry")
      expect(realigned).toBe(1)

      const listed = await invoke<SettingsLineageListResult>(harness, "settings.lineage.list", {
        ...base,
        relativePath: "设定集/人物/林照.md",
      })
      expect(listed.entries[0]?.sourceKind).toBe("history_restore")
      const commit = await invoke<SettingsLineageCommitResult>(harness, "settings.lineage.getCommit", {
        ...base,
        commitId: listed.entries[0]!.commitId,
      })
      expect(commit.markdown).toContain("恢复后磁盘版")
    })
  }, 30_000)

  it("annotates optional story time and restores as current only with exact confirm phrase", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const dir = join(harness.workspaceRootRef, "设定集", "人物")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "林照.md"), "# 林照\n\n旧版设定。\n", "utf8")

      await invoke(harness, "settings.lineage.paths", base)
      // Ensure at least one lineage entry exists even if migration seed already ran.
      await invoke(harness, "workspace.save", {
        ...base,
        relativePath: "设定集/人物/林照.md",
        content: "# 林照\n\n旧版设定。\n",
      })
      await invoke(harness, "workspace.save", {
        ...base,
        relativePath: "设定集/人物/林照.md",
        content: "# 林照\n\n当前真相。\n",
      })

      const listed = await invoke<SettingsLineageListResult>(harness, "settings.lineage.list", {
        ...base,
        relativePath: "设定集/人物/林照.md",
      })
      expect(listed.entries.length).toBeGreaterThanOrEqual(2)

      let olderCommitId: string | undefined
      for (const entry of listed.entries) {
        const commit = await invoke<SettingsLineageCommitResult>(harness, "settings.lineage.getCommit", {
          ...base,
          commitId: entry.commitId,
        })
        if (commit.markdown.includes("旧版设定")) {
          olderCommitId = entry.commitId
          break
        }
      }
      expect(olderCommitId).toBeDefined()

      const annotated = await invoke<{ entry: { storyTime?: string } }>(harness, "settings.lineage.annotate", {
        ...base,
        commitId: olderCommitId!,
        storyTime: "盐雾城 · 觉醒前",
      })
      expect(annotated.entry.storyTime).toBe("盐雾城 · 觉醒前")

      const rejected = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "settings.lineage.restoreAsCurrent",
        payload: {
          ...base,
          commitId: olderCommitId!,
          confirmPhrase: "确认恢复",
        },
      })
      expect(rejected.ok).toBe(false)

      const restored = await invoke<{ entry: { summary?: string; sourceKind: string } }>(
        harness,
        "settings.lineage.restoreAsCurrent",
        {
          ...base,
          commitId: olderCommitId!,
          confirmPhrase: "恢复为当前",
        },
      )
      expect(restored.entry.summary).toContain("从沿革恢复")
      expect(restored.entry.sourceKind).toBe("workspace_save")

      const disk = await invoke<{ content: string }>(harness, "workspace.read", {
        ...base,
        relativePath: "设定集/人物/林照.md",
      })
      expect(disk.content).toContain("旧版设定")
    })
  }, 30_000)
})
