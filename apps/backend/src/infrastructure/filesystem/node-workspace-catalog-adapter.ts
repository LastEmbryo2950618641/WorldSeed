import { Buffer } from "node:buffer"

import {
  workspaceCatalogSnapshotSchema,
  type WorkspaceCatalogEntry,
  type WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"

import type {
  CreateWorkspaceCatalogSnapshotInput,
  WorkspaceCatalogPort,
  WorkspacePort,
} from "../../application/index.js"
import { digest } from "../../core/index.js"
import { NodeWorkspaceAdapter } from "./node-workspace-adapter.js"

export class NodeWorkspaceCatalogAdapter implements WorkspaceCatalogPort {
  public constructor(private readonly workspace: WorkspacePort = new NodeWorkspaceAdapter()) {}

  public async createSnapshot(input: CreateWorkspaceCatalogSnapshotInput): Promise<WorkspaceCatalogSnapshot> {
    const report = await this.workspace.validate(input.workspaceRootRef)
    if (report.issues.length > 0) {
      throw new Error(`Cannot catalog an invalid workspace: ${report.issues.map((issue) => issue.path).join(", ")}`)
    }

    const entries = await Promise.all([...report.inventory]
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
      .map(async (entry): Promise<WorkspaceCatalogEntry> => {
        if (entry.kind === "directory") {
          const entryDigest = digest({ relativePath: entry.path, entryKind: entry.kind })
          return {
            relativePath: entry.path,
            entryKind: entry.kind,
            role: classifyRole(entry.path),
            version: entryDigest,
            digest: entryDigest,
            size: 0,
          }
        }
        const content = await this.workspace.readMarkdown(report.workspaceRootRef, entry.path)
        const entryDigest = digest(content)
        return {
          relativePath: entry.path,
          entryKind: entry.kind,
          role: classifyRole(entry.path),
          version: entryDigest,
          digest: entryDigest,
          size: Buffer.byteLength(content, "utf8"),
        }
      }))

    return workspaceCatalogSnapshotSchema.parse({
      snapshotId: input.snapshotId,
      projectId: input.projectId,
      generatedAtMs: input.generatedAtMs,
      entries,
      digest: digest(entries),
    })
  }
}

function classifyRole(relativePath: string): WorkspaceCatalogEntry["role"] {
  const topLevel = relativePath.split("/")[0]
  switch (topLevel) {
    case "世界推演规则": return "world_rules"
    case "设定集": return "settings"
    case "参考文件": return "references"
    case "章节正文": return "chapters"
    case "表现输出": return "presentation"
    case "暂存区": return "staging"
    default: throw new Error(`Unknown workspace catalog root: ${relativePath}`)
  }
}
