import {
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  digest,
  NodeInternalStoreAdapter,
  NodeWorkspaceAdapter,
  openProjectDatabase,
  openRegistryDatabase,
  ProjectLifecycleService,
  SqliteProjectRegistryRepository,
  SqliteProjectRepositoryFactory,
} from "../src/index.js"
import type { ProjectLifecycleError } from "../src/index.js"

const projectId = "00000000-0000-4000-8000-000000000001"
const sourceId = "00000000-0000-4000-8000-000000000002"
const temporaryDirectories: string[] = []

const defaults = {
  baseRules: "# Worldseed V1 基础规则\n\n平台只读规则。\n",
  plotSynopsisGuide: "# 剧情梗概讨论引导\n\n平台只读引导。\n",
  settingsQueryGuide: "# 设定集默认查询规则\n\n平台只读引导。\n",
  settingsRevisionGuide: "# 设定集修订规则\n\n平台只读引导。\n",
  settingsReadme: "# 设定集索引\n",
  referencesReadme: "# 参考文件索引\n",
  descriptionRules: "# 默认描写规则\n\n自动选择描写方式。\n",
  proseStyleRules: "# 默认笔风规则\n\n保持作品语言连续。\n",
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-filesystem-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("Node workspace adapter", () => {
  it("creates the fixed Markdown workspace and enforces actor permissions", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const adapter = new NodeWorkspaceAdapter()
    const report = await adapter.createLayout(workspaceRoot, defaults)

    expect(report.issues).toEqual([])
    expect(report.inventory.filter((entry) => !entry.path.includes("/") && entry.kind === "directory"))
      .toHaveLength(5)
    expect(await adapter.readMarkdown(workspaceRoot, "世界推演规则/基础规则/base-rules.md"))
      .toBe(defaults.baseRules)
    expect(await adapter.readMarkdown(workspaceRoot, "设定集/readme.md")).toBe(defaults.settingsReadme)
    expect(await adapter.readMarkdown(workspaceRoot, "参考文件/readme.md")).toBe(defaults.referencesReadme)

    await adapter.saveUserMarkdown(workspaceRoot, "设定集/readme.md", "# 已编辑的设定索引\n")
    expect(await adapter.readMarkdown(workspaceRoot, "设定集/readme.md")).toContain("已编辑")

    await adapter.saveUserMarkdown(workspaceRoot, "设定集/局部/规则.md", "# 规则\n")
    expect(await adapter.readMarkdown(workspaceRoot, "设定集/局部/规则.md")).toBe("# 规则\n")
    await expect(adapter.saveUserMarkdown(
      workspaceRoot,
      "世界推演规则/基础规则/base-rules.md",
      "changed",
    )).rejects.toThrow("Fixed workspace entry")
    await expect(adapter.saveUserMarkdown(workspaceRoot, "参考文件/data.json", "{}"))
      .rejects.toThrow("Only .md files")

    await adapter.publishChapter(workspaceRoot, "章节正文/第一章 开始.md", "# 第一章 开始\n\n正文。\n")
    expect(readFileSync(join(workspaceRoot, "章节正文", "第一章 开始.md"), "utf8"))
      .toContain("正文")
    await expect(adapter.publishChapter(
      workspaceRoot,
      "章节正文/第一章 开始.md",
      "overwrite",
    )).rejects.toThrow()
  })

  it("imports only Markdown files and validates the entire folder before copying", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const source = join(root, "source")
    mkdirSync(join(source, "nested"), { recursive: true })
    writeFileSync(join(source, "one.md"), "# One\n", "utf8")
    writeFileSync(join(source, "nested", "two.md"), "# Two\n", "utf8")
    const adapter = new NodeWorkspaceAdapter()
    await adapter.createLayout(workspaceRoot, defaults)

    expect(await adapter.importMarkdownFolder(workspaceRoot, "参考文件/导入", source)).toBe(2)
    expect(await adapter.readMarkdown(workspaceRoot, "参考文件/导入/nested/two.md")).toContain("Two")

    const invalidSource = join(root, "invalid-source")
    mkdirSync(invalidSource)
    writeFileSync(join(invalidSource, "valid.md"), "valid", "utf8")
    writeFileSync(join(invalidSource, "invalid.txt"), "invalid", "utf8")
    await expect(adapter.importMarkdownFolder(workspaceRoot, "参考文件/失败导入", invalidSource))
      .rejects.toThrow("only .md files")
    await expect(adapter.readMarkdown(workspaceRoot, "参考文件/失败导入/valid.md")).rejects.toThrow()
  })

  it("reports non-Markdown files and unexpected top-level directories without repairing them", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const adapter = new NodeWorkspaceAdapter()
    await adapter.createLayout(workspaceRoot, defaults)
    mkdirSync(join(workspaceRoot, "内部索引"))
    writeFileSync(join(workspaceRoot, "参考文件", "data.json"), "{}", "utf8")

    const issueCodes = (await adapter.validate(workspaceRoot)).issues.map((issue) => issue.code)
    expect(issueCodes).toContain("unexpected_root_entry")
    expect(issueCodes).toContain("invalid_file_type")
    expect(readFileSync(join(workspaceRoot, "参考文件", "data.json"), "utf8")).toBe("{}")
  })

  it("reports either mandatory index document when it is missing", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const adapter = new NodeWorkspaceAdapter()
    await adapter.createLayout(workspaceRoot, defaults)

    unlinkSync(join(workspaceRoot, "设定集", "readme.md"))
    const report = await adapter.validate(workspaceRoot)
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "missing_fixed_entry",
      path: "设定集/readme.md",
    }))
  })
})

describe("project lifecycle", () => {
  it("creates, registers, and reopens a physically separated project", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "user-workspace")
    const appDataRoot = join(root, "app-data", "Worldseed")
    const registryDatabase = await openRegistryDatabase(join(appDataRoot, "registry.sqlite"))
    const registry = new SqliteProjectRegistryRepository(registryDatabase)
    const workspace = new NodeWorkspaceAdapter()
    const internalStore = new NodeInternalStoreAdapter(appDataRoot)
    const lifecycle = new ProjectLifecycleService(
      registry,
      workspace,
      internalStore,
      new SqliteProjectRepositoryFactory(),
    )

    const created = await lifecycle.create({
      projectId,
      displayName: "Lifecycle Test",
      workspaceRootRef: workspaceRoot,
      defaults,
      nowMs: 100,
    })
    expect(created.manifest.workspaceRootRef).not.toContain(created.internalStore.internalStoreRef)
    expect(created.internalStore.internalStoreRef).not.toContain(created.manifest.workspaceRootRef)
    expect(created.internalStore.historyGitRef).toBe(join(created.internalStore.internalStoreRef, "history.git"))
    expect(created.internalStore.historyCheckoutRef).toBe(join(created.internalStore.internalStoreRef, "history-checkout"))
    expect(created.internalStore.historyRecoveryRef).toBe(join(created.internalStore.internalStoreRef, "emergency-recovery"))
    expect(() => readFileSync(join(workspaceRoot, ".git", "HEAD"), "utf8")).toThrow()
    expect(readFileSync(join(workspaceRoot, "世界推演规则", "基础规则", "base-rules.md"), "utf8"))
      .toBe(defaults.baseRules)

    const opened = await lifecycle.openByWorkspace(workspaceRoot, 200, defaults)
    expect(opened.manifest.id).toBe(projectId)
    expect((await registry.findById(projectId))?.lastOpenedAtMs).toBe(200)

    const objectRef = await internalStore.writeImmutableDocument(opened.internalStore, sourceId, "# immutable\n")
    expect(await internalStore.readDocument(objectRef)).toBe("# immutable\n")
    await expect(internalStore.writeImmutableDocument(opened.internalStore, sourceId, "replace"))
      .rejects.toThrow()
    await registryDatabase.destroy()
  })

  it("rejects base-rule drift and invalid workspaces on open", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const appDataRoot = join(root, "app-data")
    const registryDatabase = await openRegistryDatabase(join(appDataRoot, "registry.sqlite"))
    const lifecycle = new ProjectLifecycleService(
      new SqliteProjectRegistryRepository(registryDatabase),
      new NodeWorkspaceAdapter(),
      new NodeInternalStoreAdapter(appDataRoot),
      new SqliteProjectRepositoryFactory(),
    )
    await lifecycle.create({
      projectId,
      displayName: "Validation Test",
      workspaceRootRef: workspaceRoot,
      defaults,
      nowMs: 100,
    })

    writeFileSync(join(workspaceRoot, "世界推演规则", "基础规则", "base-rules.md"), "modified", "utf8")
    await expect(lifecycle.openByWorkspace(workspaceRoot, 200, defaults)).rejects.toMatchObject<Partial<ProjectLifecycleError>>({
      code: "manifest_mismatch",
    })
    writeFileSync(join(workspaceRoot, "世界推演规则", "基础规则", "base-rules.md"), defaults.baseRules, "utf8")
    mkdirSync(join(workspaceRoot, "第六目录"))
    await expect(lifecycle.openByWorkspace(workspaceRoot, 300, defaults)).rejects.toMatchObject<Partial<ProjectLifecycleError>>({
      code: "workspace_invalid",
    })
    await registryDatabase.destroy()
  })

  it("reconciles manifest when the workspace is valid but platform fixed entries expanded", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const appDataRoot = join(root, "app-data")
    const registryDatabase = await openRegistryDatabase(join(appDataRoot, "registry.sqlite"))
    const lifecycle = new ProjectLifecycleService(
      new SqliteProjectRegistryRepository(registryDatabase),
      new NodeWorkspaceAdapter(),
      new NodeInternalStoreAdapter(appDataRoot),
      new SqliteProjectRepositoryFactory(),
    )
    await lifecycle.create({
      projectId,
      displayName: "Upgrade Test",
      workspaceRootRef: workspaceRoot,
      defaults,
      nowMs: 100,
    })

    const store = await new NodeInternalStoreAdapter(appDataRoot).inspectProject(
      projectId,
      workspaceRoot,
      (await new SqliteProjectRegistryRepository(registryDatabase).findById(projectId))!.internalStoreRef,
    )
    const session = await new SqliteProjectRepositoryFactory().open(store, workspaceRoot)
    try {
      const manifest = (await session.repository.readManifest(projectId))!
      const legacyFixedEntries = manifest.fixedEntries.filter((entry) => (
        entry.key !== "plot-synopsis-guide"
        && entry.key !== "settings-query-guide"
        && entry.key !== "settings-revision-guide"
      ))
      const legacyDigest = digest({
        protocolVersion: manifest.protocolVersion,
        manifestVersion: manifest.manifestVersion,
        fixedEntries: legacyFixedEntries,
        projectId,
        displayName: manifest.displayName,
        workspaceRootRef: workspaceRoot,
        internalStoreRef: store.internalStoreRef,
        baseRulesDigest: digest(defaults.baseRules),
      })
      await session.repository.reconcileManifest({ ...manifest, fixedEntries: legacyFixedEntries, manifestDigest: legacyDigest }, 150)
    } finally {
      await session.close()
    }

    // Simulate an older on-disk workspace that never received the new platform guides.
    unlinkSync(join(workspaceRoot, "世界推演规则", "基础规则", "plot-synopsis-guide.md"))
    unlinkSync(join(workspaceRoot, "世界推演规则", "基础规则", "settings-query-guide.md"))
    unlinkSync(join(workspaceRoot, "世界推演规则", "基础规则", "settings-revision-guide.md"))

    const opened = await lifecycle.openByWorkspace(workspaceRoot, 200, defaults)
    expect(opened.manifest.fixedEntries.some((entry) => entry.key === "plot-synopsis-guide")).toBe(true)
    expect(opened.manifest.fixedEntries.some((entry) => entry.key === "settings-query-guide")).toBe(true)
    expect(opened.manifest.fixedEntries.some((entry) => entry.key === "settings-revision-guide")).toBe(true)
    expect(readFileSync(join(workspaceRoot, "世界推演规则", "基础规则", "settings-query-guide.md"), "utf8"))
      .toBe(defaults.settingsQueryGuide)
    expect(readFileSync(join(workspaceRoot, "世界推演规则", "基础规则", "settings-revision-guide.md"), "utf8"))
      .toBe(defaults.settingsRevisionGuide)
    await registryDatabase.destroy()
  })

  it("rejects internal storage nested inside the user workspace", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    mkdirSync(workspaceRoot)
    const adapter = new NodeInternalStoreAdapter(join(workspaceRoot, ".internal"))
    await expect(adapter.prepareProject(projectId, workspaceRoot)).rejects.toThrow("physically separate")
  })

  it("produces a project database that remains independently openable", async () => {
    const root = temporaryDirectory()
    const workspaceRoot = join(root, "workspace")
    const appDataRoot = join(root, "app-data")
    const workspace = new NodeWorkspaceAdapter()
    await workspace.createLayout(workspaceRoot, defaults)
    const internalStore = new NodeInternalStoreAdapter(appDataRoot)
    const store = await internalStore.prepareProject(projectId, workspaceRoot)
    const database = await openProjectDatabase(store.projectDatabaseRef)
    expect(await database.selectFrom("schema_migrations").selectAll().execute()).toHaveLength(33)
    await database.destroy()
  })
})
