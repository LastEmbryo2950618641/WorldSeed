import type {
  HistoryCheckoutResult,
  HistoryEntrySummary,
  ProjectId,
} from "@worldseed/contracts"

import type {
  HistoryCheckoutMode,
  HistoryRepository,
  HistoryVcsPort,
  WorkspaceSnapshot,
  WorkspaceSnapshotPort,
} from "./ports/index.js"

export type CheckoutHistoryInput = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  operationId: string
  entryId: string
  mode: HistoryCheckoutMode
  startedAtMs: number
}>

export class HistoryCheckoutService {
  public constructor(
    private readonly repository: HistoryRepository,
    private readonly vcs: HistoryVcsPort,
    private readonly workspace: WorkspaceSnapshotPort,
    private readonly now: () => number = Date.now,
  ) {}

  public async findPreviousAutomaticEntry(projectId: ProjectId): Promise<HistoryEntrySummary> {
    return this.repository.findPreviousAutomaticEntry(projectId)
  }

  public async checkout(input: CheckoutHistoryInput): Promise<HistoryCheckoutResult> {
    const intent = await this.repository.beginCheckout(input)
    if (intent.completedResult !== undefined) return intent.completedResult
    const currentWorkspace = await this.workspace.capture(input.workspaceRootRef)
    let workspaceReplaced = false
    try {
      const snapshot = await this.vcs.readSnapshot(intent.commitOid)
      if (snapshot.manifest.projectId !== input.projectId || snapshot.manifest.entryId !== input.entryId) {
        throw new Error("History snapshot identity does not match the requested entry")
      }
      const targetWorkspace = toWorkspaceSnapshot(snapshot.manifest.baseRulesDigest, snapshot.manifest.workspace, snapshot.files)
      await this.workspace.restore(input.workspaceRootRef, targetWorkspace)
      workspaceReplaced = true
      return await this.repository.completeCheckout(intent, snapshot.manifest, this.now())
    } catch (error) {
      if (workspaceReplaced) {
        try {
          await this.workspace.restore(input.workspaceRootRef, currentWorkspace)
        } catch (rollbackError) {
          await this.repository.failCheckout(input.operationId, new AggregateError([error, rollbackError]), this.now())
          throw new AggregateError([error, rollbackError], "History checkout and workspace rollback both failed")
        }
      }
      await this.repository.failCheckout(input.operationId, error, this.now())
      throw error
    }
  }
}

function toWorkspaceSnapshot(
  baseRulesDigest: string,
  manifestFiles: readonly { relativePath: string; gitPath: string; digest: string; size: number }[],
  snapshotFiles: readonly { gitPath: string; content: string }[],
): WorkspaceSnapshot {
  const contentByGitPath = new Map(snapshotFiles.map((file) => [file.gitPath, file.content]))
  return {
    baseRulesDigest,
    files: manifestFiles.map((file) => {
      const content = contentByGitPath.get(file.gitPath)
      if (content === undefined) throw new Error(`History snapshot is missing workspace content: ${file.gitPath}`)
      return { ...file, content }
    }),
  }
}
