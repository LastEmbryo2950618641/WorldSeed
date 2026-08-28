import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  digest,
  fixedWorkspaceEntries,
  NodeInternalStoreAdapter,
  NodeWorkspaceAdapter,
  NodeWorkspaceCatalogAdapter,
  openProjectDatabase,
  SqliteEvidenceStore,
  SqliteProjectRepository,
  SqliteTaskScopeRepository,
  SqliteWorkspaceCatalogSnapshotRepository,
  type ProjectManifest,
} from "../src/index.js"

const ids = {
  project: "00000000-0000-4000-8000-000000000101",
  task: "00000000-0000-4000-8000-000000000102",
  scope: "00000000-0000-4000-8000-000000000103",
  turn: "00000000-0000-4000-8000-000000000104",
  snapshot1: "00000000-0000-4000-8000-000000000105",
  snapshot2: "00000000-0000-4000-8000-000000000106",
  evidence1: "00000000-0000-4000-8000-000000000107",
  evidence2: "00000000-0000-4000-8000-000000000108",
}

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-catalog-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("workspace catalog", () => {
  it("builds a stable snapshot and changes digest when content changes", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const workspace = new NodeWorkspaceAdapter()
    await workspace.createLayout(workspaceRoot, {
      baseRules: "# 基础规则\n",
      plotSynopsisGuide: "# 剧情梗概讨论引导\n",
      settingsQueryGuide: "# 设定集默认查询规则\n",
      settingsRevisionGuide: "# 设定集修订规则\n",
      settingsReadme: "# 设定集索引\n",
      referencesReadme: "# 参考文件索引\n",
      descriptionRules: "# 描写规则\n",
      proseStyleRules: "# 笔风规则\n",
    })
    await workspace.saveUserMarkdown(workspaceRoot, "设定集/角色/主角.md", "# 主角\n")
    await workspace.saveUserMarkdown(workspaceRoot, "参考文件/术语/世界观.md", "# 世界观\n")

    const catalog = new NodeWorkspaceCatalogAdapter(workspace)
    const first = await catalog.createSnapshot({
      snapshotId: ids.snapshot1,
      projectId: ids.project,
      workspaceRootRef: workspaceRoot,
      generatedAtMs: 100,
    })

    expect(first.entries.map((entry) => entry.relativePath)).toEqual([...first.entries]
      .map((entry) => entry.relativePath)
      .slice()
      .sort((left, right) => left.localeCompare(right, "zh-CN")))
    expect(first.entries.find((entry) => entry.relativePath === "世界推演规则")).toMatchObject({
      entryKind: "directory",
      role: "world_rules",
    })
    expect(first.entries.find((entry) => entry.relativePath === "设定集/角色/主角.md")).toMatchObject({
      entryKind: "file",
      role: "settings",
      size: Buffer.byteLength("# 主角\n", "utf8"),
    })

    await workspace.saveUserMarkdown(workspaceRoot, "设定集/角色/主角.md", "# 主角（修订）\n")
    const second = await catalog.createSnapshot({
      snapshotId: ids.snapshot2,
      projectId: ids.project,
      workspaceRootRef: workspaceRoot,
      generatedAtMs: 200,
    })

    expect(second.digest).not.toBe(first.digest)
    expect(second.entries.find((entry) => entry.relativePath === "设定集/角色/主角.md")?.digest)
      .not.toBe(first.entries.find((entry) => entry.relativePath === "设定集/角色/主角.md")?.digest)
  })
})

describe("sqlite workspace catalog snapshot repository", () => {
  it("persists immutable snapshots and attaches one snapshot per task", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const appDataRoot = join(root, "app-data")
    const workspace = new NodeWorkspaceAdapter()
    await workspace.createLayout(workspaceRoot, {
      baseRules: "# 基础规则\n",
      plotSynopsisGuide: "# 剧情梗概讨论引导\n",
      settingsQueryGuide: "# 设定集默认查询规则\n",
      settingsRevisionGuide: "# 设定集修订规则\n",
      settingsReadme: "# 设定集索引\n",
      referencesReadme: "# 参考文件索引\n",
      descriptionRules: "# 描写规则\n",
      proseStyleRules: "# 笔风规则\n",
    })
    const internalStore = new NodeInternalStoreAdapter(appDataRoot)
    const store = await internalStore.prepareProject(ids.project, workspaceRoot)
    const database = await openProjectDatabase(store.projectDatabaseRef)
    const projectRepository = new SqliteProjectRepository(database, workspaceRoot, store.internalStoreRef)
    const taskRepository = new SqliteTaskScopeRepository(database)
    const repository = new SqliteWorkspaceCatalogSnapshotRepository(database)
    const manifest: ProjectManifest = {
      id: ids.project,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Catalog Test",
      workspaceRootRef: workspaceRoot,
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef: store.internalStoreRef,
      manifestDigest: digest(fixedWorkspaceEntries),
    }

    await projectRepository.create({
      projectId: ids.project,
      name: "Catalog Test",
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)
    await taskRepository.create({
      projectId: ids.project,
      taskId: ids.task,
      turnId: ids.turn,
      scopeId: ids.scope,
      kind: "turn",
      status: "created",
      reason: "catalog test",
      configSnapshot: {},
      promptSnapshot: {},
      createdAtMs: 10,
    })

    const snapshot = await new NodeWorkspaceCatalogAdapter(workspace).createSnapshot({
      snapshotId: ids.snapshot1,
      projectId: ids.project,
      workspaceRootRef: workspaceRoot,
      generatedAtMs: 20,
    })

    await repository.save(snapshot)
    expect(await repository.read(ids.snapshot1)).toEqual(snapshot)
    await repository.attachToTask(ids.task, ids.snapshot1)
    expect(await repository.readForTask(ids.task)).toEqual(snapshot)
    await expect(repository.save({
      ...snapshot,
      entries: [...snapshot.entries, { ...snapshot.entries[0], digest: "changed" }],
    })).rejects.toThrow("immutable")
    await expect(repository.attachToTask(ids.task, ids.snapshot1)).resolves.toBeUndefined()
    const otherSnapshot = { ...snapshot, snapshotId: ids.snapshot2 }
    await repository.save(otherSnapshot)
    await expect(repository.attachToTask(ids.task, ids.snapshot2)).rejects.toThrow("immutable")
    await database.destroy()
  })
})

describe("sqlite evidence store", () => {
  it("writes immutable evidence and reuses existing records", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const appDataRoot = join(root, "app-data")
    const workspace = new NodeWorkspaceAdapter()
    await workspace.createLayout(workspaceRoot, {
      baseRules: "# 基础规则\n",
      plotSynopsisGuide: "# 剧情梗概讨论引导\n",
      settingsQueryGuide: "# 设定集默认查询规则\n",
      settingsRevisionGuide: "# 设定集修订规则\n",
      settingsReadme: "# 设定集索引\n",
      referencesReadme: "# 参考文件索引\n",
      descriptionRules: "# 描写规则\n",
      proseStyleRules: "# 笔风规则\n",
    })
    const internalStore = new NodeInternalStoreAdapter(appDataRoot)
    const store = await internalStore.prepareProject(ids.project, workspaceRoot)
    const database = await openProjectDatabase(store.projectDatabaseRef)
    const projectRepository = new SqliteProjectRepository(database, workspaceRoot, store.internalStoreRef)
    const manifest: ProjectManifest = {
      id: ids.project,
      protocolVersion: "worldseed.v1",
      manifestVersion: 1,
      displayName: "Evidence Test",
      workspaceRootRef: workspaceRoot,
      fixedEntries: fixedWorkspaceEntries,
      internalStoreRef: store.internalStoreRef,
      manifestDigest: digest(fixedWorkspaceEntries),
    }

    await projectRepository.create({
      projectId: ids.project,
      name: "Evidence Test",
      manifestVersion: 1,
      committedSequence: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }, manifest)

    const evidenceStore = new SqliteEvidenceStore(database, internalStore, store)
    const first = await evidenceStore.writeImmutable({
      evidenceId: ids.evidence1,
      projectId: ids.project,
      contextId: ids.task,
      sourceKind: "workspace",
      ownerId: "设定集/readme.md",
      version: "v1",
      digest: digest("第一份证据"),
      locator: "workspace://设定集/readme.md",
      content: "第一份证据",
      readReason: "catalog read",
      createdAtMs: 100,
    })
    expect(await evidenceStore.read(ids.evidence1)).toEqual(first)
    expect(await evidenceStore.listByContext(ids.task)).toEqual([first])

    await expect(evidenceStore.writeImmutable({
      evidenceId: ids.evidence1,
      projectId: ids.project,
      contextId: ids.task,
      sourceKind: "workspace",
      ownerId: "设定集/readme.md",
      version: "v1",
      digest: digest("不同内容"),
      locator: "workspace://设定集/readme.md",
      content: "不同内容",
      readReason: "catalog read",
      createdAtMs: 100,
    })).rejects.toThrow("immutable")

    const second = await evidenceStore.writeImmutable({
      evidenceId: ids.evidence2,
      projectId: ids.project,
      contextId: ids.task,
      sourceKind: "graph",
      ownerId: "node-1",
      version: "v2",
      digest: digest("第二份证据"),
      locator: "graph://node-1",
      content: "第二份证据",
      readReason: "graph read",
      createdAtMs: 200,
    })
    expect(await evidenceStore.listByContext(ids.task)).toEqual([first, second])
    await database.destroy()
  })
})
