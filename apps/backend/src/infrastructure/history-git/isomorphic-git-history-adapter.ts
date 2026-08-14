import fs from "node:fs"
import { createRequire } from "node:module"

import { historyManifestSchema, type HistoryManifest } from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type {
  HistorySnapshot,
  HistorySnapshotFile,
  HistoryVcsPort,
  WriteHistorySnapshotInput,
} from "../../application/index.js"

const historyRef = "refs/heads/worldseed-history"
const manifestPath = "manifest.json"

type GitInput = Readonly<Record<string, unknown>>
type GitTreeEntry = Readonly<{ mode: "100644" | "040000"; path: string; oid: string; type: "blob" | "tree" }>
type GitApi = Readonly<{
  init(input: GitInput): Promise<void>
  writeBlob(input: GitInput): Promise<string>
  writeTree(input: GitInput & { tree: readonly GitTreeEntry[] }): Promise<string>
  writeCommit(input: GitInput): Promise<string>
  writeRef(input: GitInput): Promise<void>
  readCommit(input: GitInput): Promise<{ commit: { tree: string; parent: readonly string[] } }>
  readTree(input: GitInput): Promise<{ tree: readonly GitTreeEntry[] }>
  readBlob(input: GitInput): Promise<{ blob: Uint8Array }>
}>
const git = createRequire(import.meta.url)("isomorphic-git") as GitApi

type TreeNode = {
  files: Map<string, string>
  directories: Map<string, TreeNode>
}

export class IsomorphicGitHistoryAdapter implements HistoryVcsPort {
  private initialized = false

  public constructor(private readonly gitdir: string) {}

  public async writeSnapshot(input: WriteHistorySnapshotInput): Promise<string> {
    await this.ensureInitialized()
    assertManifestDigest(input.manifest)
    const files = validateSnapshotFiles(input.manifest, input.files)
    const root = createTreeNode()
    await this.addBlob(root, manifestPath, JSON.stringify(input.manifest))
    for (const file of files) await this.addBlob(root, file.gitPath, file.content)
    const tree = await this.writeTree(root)
    const timestamp = Math.floor(input.manifest.createdAtMs / 1_000)
    const identity = {
      name: "Worldseed History",
      email: "history@worldseed.local",
      timestamp,
      timezoneOffset: 0,
    }
    const commitOid = await git.writeCommit({
      fs,
      gitdir: this.gitdir,
      commit: {
        tree,
        parent: input.parentCommitOid === undefined ? [] : [input.parentCommitOid],
        author: identity,
        committer: identity,
        message: `${input.manifest.entryId}\n`,
      },
    })
    await git.writeRef({ fs, gitdir: this.gitdir, ref: historyRef, value: commitOid, force: true })
    return commitOid
  }

  public async readSnapshot(commitOid: string): Promise<HistorySnapshot> {
    await this.ensureInitialized()
    const commit = await git.readCommit({ fs, gitdir: this.gitdir, oid: commitOid })
    const blobs = await this.readTree(commit.commit.tree)
    const manifestContent = blobs.get(manifestPath)
    if (manifestContent === undefined) throw new Error("History snapshot has no manifest.json")
    const manifest = historyManifestSchema.parse(JSON.parse(manifestContent))
    assertManifestDigest(manifest)
    const files = manifest.workspace.map((entry) => {
      const content = blobs.get(normalizeGitPath(entry.gitPath))
      if (content === undefined) throw new Error(`History snapshot is missing workspace file: ${entry.gitPath}`)
      if (digest(content) !== entry.digest) throw new Error(`History workspace file digest mismatch: ${entry.gitPath}`)
      return { gitPath: entry.gitPath, content }
    })
    return { commitOid, parentCommitOids: commit.commit.parent, manifest, files }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    await git.init({ fs, dir: this.gitdir, gitdir: this.gitdir, bare: true, defaultBranch: "worldseed-history" })
    this.initialized = true
  }

  private async addBlob(root: TreeNode, path: string, content: string): Promise<void> {
    const segments = normalizeGitPath(path).split("/")
    const filename = segments.pop()
    if (filename === undefined) throw new Error("History Git path has no filename")
    let node = root
    for (const segment of segments) {
      const existing = node.directories.get(segment)
      if (existing !== undefined) {
        node = existing
        continue
      }
      const created = createTreeNode()
      node.directories.set(segment, created)
      node = created
    }
    if (node.files.has(filename) || node.directories.has(filename)) {
      throw new Error(`Duplicate history Git path: ${path}`)
    }
    node.files.set(filename, await git.writeBlob({ fs, gitdir: this.gitdir, blob: Buffer.from(content, "utf8") }))
  }

  private async writeTree(node: TreeNode): Promise<string> {
    const entries: GitTreeEntry[] = []
    for (const [path, oid] of node.files) entries.push({ mode: "100644", path, oid, type: "blob" })
    for (const [path, child] of node.directories) {
      entries.push({ mode: "040000", path, oid: await this.writeTree(child), type: "tree" })
    }
    entries.sort((left, right) => left.path.localeCompare(right.path))
    return git.writeTree({ fs, gitdir: this.gitdir, tree: entries })
  }

  private async readTree(treeOid: string, prefix = "", result = new Map<string, string>()): Promise<Map<string, string>> {
    const tree = await git.readTree({ fs, gitdir: this.gitdir, oid: treeOid })
    for (const entry of tree.tree) {
      const path = prefix.length === 0 ? entry.path : `${prefix}/${entry.path}`
      if (entry.type === "tree") {
        await this.readTree(entry.oid, path, result)
      } else {
        const blob = await git.readBlob({ fs, gitdir: this.gitdir, oid: entry.oid })
        result.set(path, Buffer.from(blob.blob).toString("utf8"))
      }
    }
    return result
  }
}

function validateSnapshotFiles(
  manifest: HistoryManifest,
  files: readonly HistorySnapshotFile[],
): readonly HistorySnapshotFile[] {
  const byPath = new Map(files.map((file) => [normalizeGitPath(file.gitPath), file]))
  if (byPath.size !== files.length) throw new Error("History snapshot contains duplicate workspace paths")
  const expectedPaths = new Set(manifest.workspace.map((entry) => normalizeGitPath(entry.gitPath)))
  if (expectedPaths.has(manifestPath)) throw new Error("Workspace snapshot cannot replace manifest.json")
  if (expectedPaths.size !== manifest.workspace.length || byPath.size !== expectedPaths.size) {
    throw new Error("History manifest and workspace file set differ")
  }
  for (const entry of manifest.workspace) {
    const file = byPath.get(normalizeGitPath(entry.gitPath))
    if (file === undefined) throw new Error(`History workspace file is missing: ${entry.gitPath}`)
    if (digest(file.content) !== entry.digest) throw new Error(`History workspace file digest mismatch: ${entry.gitPath}`)
  }
  return [...files].sort((left, right) => left.gitPath.localeCompare(right.gitPath))
}

function assertManifestDigest(manifest: HistoryManifest): void {
  const { digest: recordedDigest, ...content } = manifest
  if (digest(content) !== recordedDigest) throw new Error("History manifest digest mismatch")
}

function normalizeGitPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "")
  const segments = normalized.split("/")
  if (normalized.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid history Git path: ${path}`)
  }
  return normalized
}

function createTreeNode(): TreeNode {
  return { files: new Map(), directories: new Map() }
}
