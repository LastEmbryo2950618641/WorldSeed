import type { HistoryManifest, ProjectId } from "@worldseed/contracts"

import { digest } from "../../core/index.js"
import type {
  HistoryRepository,
  HistoryProjectionSnapshot,
  HistorySaveIntent,
  HistorySnapshotFile,
  WorkspaceSnapshotPort,
  WorkspaceSnapshot,
} from "./ports/index.js"

export type BuiltHistoryManifest = Readonly<{
  manifest: HistoryManifest
  files: readonly HistorySnapshotFile[]
}>

type HistoryCandidate = Readonly<{
  projection: HistoryProjectionSnapshot
  workspace: WorkspaceSnapshot
}>

export class HistoryManifestBuilder {
  public constructor(
    private readonly repository: HistoryRepository,
    private readonly workspace: WorkspaceSnapshotPort,
  ) {}

  public async build(
    projectId: ProjectId,
    workspaceRootRef: string,
    intent: HistorySaveIntent,
  ): Promise<BuiltHistoryManifest> {
    let stable: HistoryCandidate | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.readCandidate(projectId, workspaceRootRef, intent.entry.checkpointId)
      const after = await this.readCandidate(projectId, workspaceRootRef, intent.entry.checkpointId)
      if (candidateDigest(before) === candidateDigest(after)) {
        stable = after
        break
      }
    }
    if (stable === undefined) throw new Error("History snapshot changed repeatedly while it was being captured")
    const { projection, workspace } = stable
    const content = {
      schemaVersion: 1 as const,
      projectId,
      entryId: intent.entry.entryId,
      branchId: intent.branch.branchId,
      ...(intent.entry.parentEntryId === undefined ? {} : { parentEntryId: intent.entry.parentEntryId }),
      createdAtMs: intent.entry.createdAtMs,
      committedSequence: projection.committedSequence,
      activeGeneration: projection.activeGeneration,
      activeScopeIds: [...projection.activeScopeIds].sort(),
      nodeHeads: [...projection.nodeHeads].sort(compareObjectHead),
      linkHeads: [...projection.linkHeads].sort(compareObjectHead),
      documentHeads: [...projection.documentHeads].sort((left, right) => left.chapterId.localeCompare(right.chapterId)),
      canonicalChapters: [...projection.canonicalChapters].sort((left, right) => left.chapterSequence - right.chapterSequence),
      ...(projection.modelContext === undefined ? {} : {
        modelContext: {
          chainId: projection.modelContext.chainId,
          messages: [...projection.modelContext.messages],
          hiddenMessages: [...projection.modelContext.hiddenMessages],
        },
      }),
      ...(intent.entry.state === "paused_checkpoint" && intent.entry.checkpointId !== undefined
        ? { taskCheckpointId: intent.entry.checkpointId }
        : {}),
      workspace: workspace.files.map(({ content: ignoredContent, ...file }) => {
        void ignoredContent
        return file
      }),
      baseRulesDigest: workspace.baseRulesDigest,
    }
    return {
      manifest: { ...content, digest: digest(content) },
      files: workspace.files.map((file) => ({ gitPath: file.gitPath, content: file.content })),
    }
  }

  private async readCandidate(projectId: ProjectId, workspaceRootRef: string, checkpointId?: string): Promise<HistoryCandidate> {
    const [projection, workspace] = await Promise.all([
      this.repository.readProjectionSnapshot(projectId, checkpointId),
      this.workspace.capture(workspaceRootRef),
    ])
    return { projection, workspace }
  }
}

function candidateDigest(candidate: HistoryCandidate): string {
  return digest({
    projection: candidate.projection,
    workspace: {
      baseRulesDigest: candidate.workspace.baseRulesDigest,
      files: candidate.workspace.files.map(({ content: ignoredContent, ...file }) => {
        void ignoredContent
        return file
      }),
    },
  })
}

function compareObjectHead(
  left: { objectId: string; revisionId: string },
  right: { objectId: string; revisionId: string },
): number {
  return left.objectId.localeCompare(right.objectId) || left.revisionId.localeCompare(right.revisionId)
}
