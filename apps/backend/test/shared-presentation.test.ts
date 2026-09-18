import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { BackendContainer } from "../src/bootstrap/container.js"
import { FakeAiModelAdapter } from "../src/infrastructure/models/fake-ai-model-adapter.js"
import { NodeWorkspaceSnapshotAdapter } from "../src/infrastructure/filesystem/node-workspace-snapshot-adapter.js"

const roots: string[] = []
const containers: BackendContainer[] = []
const promptPackageRoot = fileURLToPath(new URL("../../../packages/prompt-contracts/", import.meta.url))
afterEach(async () => {
  for (const container of containers.splice(0)) await container.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("shares bundled presets, edits, imports and deletions across projects and restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "worldseed-shared-"))
  roots.push(root)
  const options = { applicationDataRoot: join(root, "data"), promptPackageRoot, model: new FakeAiModelAdapter() }
  const container = await BackendContainer.open(options)
  containers.push(container)
  const a = join(root, "a")
  const b = join(root, "b")
  await container.createProject({ projectId: "11111111-1111-4111-8111-111111111111", displayName: "A", workspaceRootRef: a })
  await container.createProject({ projectId: "22222222-2222-4222-8222-222222222222", displayName: "B", workspaceRootRef: b })
  const path = "表现输出/笔风规则/仙侠.md"
  expect(await container.workspace.readMarkdown(a, path)).toContain("古典书面叙事")
  const report = await container.workspace.validate(b)
  expect(report.issues).toEqual([])
  expect(report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/笔风规则/"))).toHaveLength(41)
  expect(report.inventory.filter((entry) => entry.kind === "file" && entry.path.startsWith("表现输出/描写规则/"))).toHaveLength(11)
  await container.workspace.saveUserMarkdown(a, path, "shared edit")
  expect(await container.workspace.readMarkdown(b, path)).toBe("shared edit")
  await container.workspace.saveUserMarkdown(a, "表现输出/本作品描写/私有.md", "private")
  await expect(container.workspace.readMarkdown(b, "表现输出/本作品描写/私有.md")).rejects.toThrow()
  const importRoot = join(root, "import")
  await mkdir(importRoot)
  await writeFile(join(importRoot, "新规则.md"), "imported")
  await container.workspace.importMarkdownFiles(a, "表现输出/笔风规则", [join(importRoot, "新规则.md")])
  expect(await container.workspace.readMarkdown(b, "表现输出/笔风规则/新规则.md")).toBe("imported")
  await container.workspace.importMarkdownFolder(a, "表现输出/描写规则/导入", importRoot)
  expect(await container.workspace.readMarkdown(b, "表现输出/描写规则/导入/新规则.md")).toBe("imported")
  await container.workspace.removeUserMarkdown(b, path)
  await container.close()
  containers.pop()
  const restarted = await BackendContainer.open(options)
  containers.push(restarted)
  await restarted.openProject(a)
  await expect(restarted.workspace.readMarkdown(a, path)).rejects.toThrow()
  expect((await restarted.workspace.validate(a)).inventory.some((entry) => entry.path === path)).toBe(false)
})

it("migrates legacy presets without overwriting conflicts or reviving deleted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "worldseed-shared-"))
  roots.push(root)
  const container = await BackendContainer.open({ applicationDataRoot: join(root, "data"), promptPackageRoot, model: new FakeAiModelAdapter() })
  containers.push(container)
  const legacy = join(root, "legacy")
  const folder = join(legacy, "表现输出", "笔风规则")
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, "仙侠.md"), "legacy variant")
  await writeFile(join(folder, "自定义.md"), "legacy custom")
  // Opening an unregistered legacy workspace can fail registration after migrating its files.
  await expect(container.openProject(legacy)).rejects.toThrow()
  const shared = join(root, "data", "shared-workspace", "表现输出", "笔风规则")
  expect(await readFile(join(shared, "自定义.md"), "utf8")).toBe("legacy custom")
  expect(await readFile(join(folder, "仙侠.md"), "utf8")).toBe("legacy variant")
  const variants = (await readdir(shared)).filter((name) => name.startsWith("仙侠-迁移-"))
  expect(variants).toHaveLength(1)
  expect(await readFile(join(shared, variants[0] ?? "missing"), "utf8")).toBe("legacy variant")
  await container.workspace.removeUserMarkdown(legacy, "表现输出/笔风规则/自定义.md")
  await expect(container.openProject(legacy)).rejects.toThrow()
  await expect(readFile(join(shared, "自定义.md"))).rejects.toThrow()
})

it("keeps shared rules outside project history, including older snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "worldseed-shared-"))
  roots.push(root)
  const container = await BackendContainer.open({ applicationDataRoot: join(root, "data"), promptPackageRoot, model: new FakeAiModelAdapter() })
  containers.push(container)
  const project = join(root, "project")
  await container.createProject({ projectId: "11111111-1111-4111-8111-111111111111", displayName: "Project", workspaceRootRef: project })
  const history = new NodeWorkspaceSnapshotAdapter(container.workspace)
  const snapshot = await history.capture(project)
  expect(snapshot.files.some((file) => file.relativePath.startsWith("表现输出/笔风规则/"))).toBe(false)
  const path = "表现输出/笔风规则/仙侠.md"
  await container.workspace.saveUserMarkdown(project, path, "new global content")
  await history.restore(project, { ...snapshot, files: [...snapshot.files, { relativePath: path, gitPath: `workspace/${path}`, content: "old", digest: "legacy", size: 3 }] })
  expect(await container.workspace.readMarkdown(project, path)).toBe("new global content")
  await expect(readFile(join(project, path))).rejects.toThrow()
})

it("routes imports at the parent directory and rejects shared-directory junctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "worldseed-shared-"))
  roots.push(root)
  const container = await BackendContainer.open({ applicationDataRoot: join(root, "data"), promptPackageRoot, model: new FakeAiModelAdapter() })
  containers.push(container)
  const project = join(root, "project")
  await container.createProject({ projectId: "11111111-1111-4111-8111-111111111111", displayName: "Project", workspaceRootRef: project })
  const incoming = join(root, "incoming")
  await mkdir(join(incoming, "笔风规则"), { recursive: true })
  await writeFile(join(incoming, "笔风规则", "导入预设.md"), "parent import")
  await container.workspace.importMarkdownFolder(project, "表现输出", incoming)
  expect(await container.workspace.readMarkdown(project, "表现输出/笔风规则/导入预设.md")).toBe("parent import")
  await expect(readFile(join(project, "表现输出/笔风规则/导入预设.md"))).rejects.toThrow()
  const outside = join(root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "protected.md"), "protected")
  await symlink(outside, join(root, "data/shared-workspace/表现输出/笔风规则/escape"), "junction")
  const path = "表现输出/笔风规则/escape/protected.md"
  await expect(container.workspace.readMarkdown(project, path)).rejects.toThrow()
  await expect(container.workspace.saveUserMarkdown(project, path, "bad")).rejects.toThrow()
  await expect(container.workspace.removeUserMarkdown(project, path)).rejects.toThrow()
  await expect(container.workspace.saveUserMarkdown(project, "表现输出/笔风规则/../../bad.md", "bad")).rejects.toThrow()
  expect(await readFile(join(outside, "protected.md"), "utf8")).toBe("protected")
})
