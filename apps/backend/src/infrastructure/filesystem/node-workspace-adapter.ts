import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"

import {
  assertWorkspaceMutationAllowed,
  digest,
  fixedWorkspaceEntries,
  normalizeWorkspacePath,
  validateWorkspaceInventory,
  type WorkspaceInventoryEntry,
  type WorkspaceValidationIssue,
} from "../../core/index.js"
import type {
  WorkspaceDefaultDocuments,
  WorkspacePort,
  WorkspaceValidationReport,
} from "../../application/index.js"

export class NodeWorkspaceAdapter implements WorkspacePort {
  public async createLayout(
    workspaceRootRef: string,
    defaults: WorkspaceDefaultDocuments,
  ): Promise<WorkspaceValidationReport> {
    const requestedRoot = resolve(workspaceRootRef)
    await mkdir(requestedRoot, { recursive: true })
    const root = await realpath(requestedRoot)
    const existing = await readdir(root)
    if (existing.length > 0) {
      throw new Error("A new project workspace must be empty")
    }

    for (const entry of fixedWorkspaceEntries) {
      const path = resolveInside(root, entry.relativePath)
      if (entry.entryKind === "directory") {
        await mkdir(path, { recursive: true })
      }
    }
    await writeFile(resolveInside(root, "世界推演规则/基础规则/base-rules.md"), defaults.baseRules, {
      encoding: "utf8",
      flag: "wx",
    })
    await writeFile(resolveInside(root, "表现输出/描写规则/默认描写规则.md"), defaults.descriptionRules, {
      encoding: "utf8",
      flag: "wx",
    })
    await writeFile(resolveInside(root, "表现输出/笔风规则/默认笔风规则.md"), defaults.proseStyleRules, {
      encoding: "utf8",
      flag: "wx",
    })
    return this.validate(root)
  }

  public async validate(workspaceRootRef: string): Promise<WorkspaceValidationReport> {
    const root = await realpath(resolve(workspaceRootRef))
    const { inventory, issues: scanIssues } = await scanWorkspace(root)
    const issues = [...scanIssues, ...validateWorkspaceInventory(inventory)]
    const baseRulesPath = resolveInside(root, "世界推演规则/基础规则/base-rules.md")
    let baseRulesDigest = "missing"
    try {
      baseRulesDigest = digest(await readFile(baseRulesPath, "utf8"))
    } catch {
      if (!issues.some((issue) => issue.path === "世界推演规则/基础规则/base-rules.md")) {
        issues.push({
          code: "missing_fixed_entry",
          path: "世界推演规则/基础规则/base-rules.md",
          message: "Platform base rules projection is missing",
        })
      }
    }
    return {
      workspaceRootRef: root,
      inventory,
      issues,
      baseRulesDigest,
    }
  }

  public async readMarkdown(workspaceRootRef: string, relativePath: string): Promise<string> {
    const root = await realpath(resolve(workspaceRootRef))
    const normalized = normalizeWorkspacePath(relativePath)
    if (!normalized.endsWith(".md")) {
      throw new Error("Only Markdown files can be read from the user workspace")
    }
    const path = await resolveExistingInside(root, normalized)
    return readFile(path, "utf8")
  }

  public async saveUserMarkdown(workspaceRootRef: string, relativePath: string, content: string): Promise<void> {
    const root = await realpath(resolve(workspaceRootRef))
    const normalized = assertWorkspaceMutationAllowed(relativePath, "file", "user")
    const path = resolveInside(root, normalized)
    await assertParentChainContainsNoLinks(root, path)
    await mkdir(resolve(path, ".."), { recursive: true })
    await writeFile(path, content, { encoding: "utf8" })
  }

  public async publishChapter(workspaceRootRef: string, relativePath: string, content: string): Promise<void> {
    const root = await realpath(resolve(workspaceRootRef))
    const normalized = assertWorkspaceMutationAllowed(relativePath, "file", "chapter_publisher")
    const path = resolveInside(root, normalized)
    await assertParentChainContainsNoLinks(root, path)
    await writeFile(path, content, { encoding: "utf8", flag: "wx" })
  }

  public async importMarkdownFiles(
    workspaceRootRef: string,
    destination: string,
    sourcePaths: readonly string[],
  ): Promise<number> {
    const root = await realpath(resolve(workspaceRootRef))
    const copies = await Promise.all(sourcePaths.map(async (sourcePath) => {
      const source = await realpath(resolve(sourcePath))
      const sourceStats = await lstat(source)
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || extname(source) !== ".md") {
        throw new Error(`Imported files must be regular .md files: ${sourcePath}`)
      }
      const targetRelativePath = normalizeWorkspacePath(`${destination}/${basename(source)}`)
      assertWorkspaceMutationAllowed(targetRelativePath, "file", "user")
      return { source, target: resolveInside(root, targetRelativePath) }
    }))
    for (const copy of copies) {
      await assertParentChainContainsNoLinks(root, copy.target)
      await mkdir(resolve(copy.target, ".."), { recursive: true })
      await copyFile(copy.source, copy.target, constants.COPYFILE_EXCL)
    }
    return copies.length
  }

  public async importMarkdownFolder(
    workspaceRootRef: string,
    destination: string,
    sourceFolder: string,
  ): Promise<number> {
    const sourceRoot = await realpath(resolve(sourceFolder))
    const sourceStats = await lstat(sourceRoot)
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error("Imported folder must be a regular directory")
    }
    const files = await scanImportFolder(sourceRoot, sourceRoot)
    const root = await realpath(resolve(workspaceRootRef))
    const copies = files.map((source) => {
      const sourceRelativePath = relative(sourceRoot, source).replaceAll("\\", "/")
      const targetRelativePath = normalizeWorkspacePath(`${destination}/${sourceRelativePath}`)
      assertWorkspaceMutationAllowed(targetRelativePath, "file", "user")
      return { source, target: resolveInside(root, targetRelativePath) }
    })
    for (const copy of copies) {
      await assertParentChainContainsNoLinks(root, copy.target)
      await mkdir(resolve(copy.target, ".."), { recursive: true })
      await copyFile(copy.source, copy.target, constants.COPYFILE_EXCL)
    }
    return copies.length
  }
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = normalizeWorkspacePath(relativePath)
  const target = resolve(root, ...normalized.split("/"))
  const fromRoot = relative(root, target)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Workspace path escapes the project root")
  }
  return target
}

async function resolveExistingInside(root: string, relativePath: string): Promise<string> {
  const candidate = resolveInside(root, relativePath)
  const target = await realpath(candidate)
  const fromRoot = relative(root, target)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Workspace path resolves outside the project root")
  }
  const stats = await lstat(candidate)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Workspace document must be a regular file")
  }
  return target
}

async function assertParentChainContainsNoLinks(root: string, target: string): Promise<void> {
  let current = resolve(target, "..")
  while (current !== root) {
    const fromRoot = relative(root, current)
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error("Workspace parent escapes the project root")
    }
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Symbolic links and directory junctions are not allowed in the workspace")
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        current = resolve(current, "..")
        continue
      }
      throw error
    }
    current = resolve(current, "..")
  }
}

async function scanWorkspace(root: string): Promise<{
  inventory: WorkspaceInventoryEntry[]
  issues: WorkspaceValidationIssue[]
}> {
  const inventory: WorkspaceInventoryEntry[] = []
  const issues: WorkspaceValidationIssue[] = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(root, path).replaceAll("\\", "/")
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) {
        issues.push({ code: "invalid_path", path: relativePath, message: "Symbolic links and directory junctions are not allowed" })
        continue
      }
      if (stats.isDirectory()) {
        inventory.push({ path: relativePath, kind: "directory" })
        await visit(path)
      } else if (stats.isFile()) {
        inventory.push({ path: relativePath, kind: "file" })
      } else {
        issues.push({ code: "invalid_path", path: relativePath, message: "Only directories and regular Markdown files are allowed" })
      }
    }
  }

  await visit(root)
  return { inventory, issues }
}

async function scanImportFolder(root: string, directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`Imported folders cannot contain symbolic links: ${relative(root, path)}`)
    }
    if (stats.isDirectory()) {
      files.push(...await scanImportFolder(root, path))
    } else if (stats.isFile() && extname(path) === ".md") {
      files.push(path)
    } else {
      throw new Error(`Imported folders can contain only .md files: ${relative(root, path)}`)
    }
  }
  return files
}
