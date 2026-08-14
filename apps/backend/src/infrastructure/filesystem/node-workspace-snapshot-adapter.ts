import { Buffer } from "node:buffer"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import { digest, normalizeWorkspacePath } from "../../core/index.js"
import type { WorkspacePort, WorkspaceSnapshot, WorkspaceSnapshotPort } from "../../application/index.js"

const baseRulesPath = "世界推演规则/基础规则/base-rules.md"

export class NodeWorkspaceSnapshotAdapter implements WorkspaceSnapshotPort {
  public constructor(private readonly workspace: WorkspacePort) {}

  public async capture(workspaceRootRef: string): Promise<WorkspaceSnapshot> {
    const report = await this.workspace.validate(workspaceRootRef)
    if (report.issues.length > 0) {
      throw new Error(`Cannot save invalid Markdown workspace: ${report.issues.map((issue) => issue.path).join(", ")}`)
    }
    const paths = report.inventory
      .filter((entry) => entry.kind === "file" && entry.path !== baseRulesPath)
      .map((entry) => entry.path)
      .sort()
    const files = await Promise.all(paths.map(async (relativePath) => {
      const content = await this.workspace.readMarkdown(workspaceRootRef, relativePath)
      return {
        relativePath,
        gitPath: `workspace/${relativePath}`,
        content,
        digest: digest(content),
        size: Buffer.byteLength(content, "utf8"),
      }
    }))
    return { baseRulesDigest: report.baseRulesDigest, files }
  }

  public async restore(workspaceRootRef: string, snapshot: WorkspaceSnapshot): Promise<void> {
    const root = await realpath(resolve(workspaceRootRef))
    const baseRulesContent = await readFile(resolveSafeInside(root, baseRulesPath), "utf8")
    if (digest(baseRulesContent) !== snapshot.baseRulesDigest) {
      throw new Error("History snapshot base rules do not match the current platform rules")
    }
    const current = await this.capture(root)
    try {
      await replaceWorkspaceFiles(root, current, snapshot)
    } catch (error) {
      try {
        await replaceWorkspaceFiles(root, snapshot, current)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "History workspace restore and rollback both failed")
      }
      throw error
    }
  }
}

async function replaceWorkspaceFiles(
  root: string,
  current: WorkspaceSnapshot,
  target: WorkspaceSnapshot,
): Promise<void> {
  const targetByPath = new Map(target.files.map((file) => [normalizeHistoryPath(file.relativePath), file]))
  if (targetByPath.size !== target.files.length) throw new Error("History snapshot contains duplicate workspace paths")
  for (const file of current.files) {
    const relativePath = normalizeHistoryPath(file.relativePath)
    if (!targetByPath.has(relativePath)) await rm(resolveInside(root, relativePath), { force: true })
  }
  for (const [relativePath, file] of targetByPath) {
    if (digest(file.content) !== file.digest || Buffer.byteLength(file.content, "utf8") !== file.size) {
      throw new Error(`History workspace file failed integrity validation: ${relativePath}`)
    }
    const path = resolveInside(root, relativePath)
    await mkdir(resolve(path, ".."), { recursive: true })
    await writeFile(path, file.content, "utf8")
  }
}

function normalizeHistoryPath(path: string): string {
  const normalized = normalizeWorkspacePath(path)
  if (!normalized.endsWith(".md") || normalized === baseRulesPath) {
    throw new Error(`History snapshot contains a non-restorable workspace path: ${path}`)
  }
  return normalized
}

function resolveInside(root: string, relativePath: string): string {
  return resolveSafeInside(root, normalizeHistoryPath(relativePath))
}

function resolveSafeInside(root: string, relativePath: string): string {
  const target = resolve(root, ...normalizeWorkspacePath(relativePath).split("/"))
  const fromRoot = relative(root, target)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("History workspace path escapes the project root")
  return target
}
