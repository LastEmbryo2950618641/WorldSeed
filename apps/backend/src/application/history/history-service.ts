import type { HistoryEntrySummary, ProjectId } from "@worldseed/contracts"

import type { HistoryManifestBuilder } from "./history-manifest-builder.js"
import type { HistoryRepository, HistoryVcsPort } from "./ports/index.js"

export type SaveHistoryInput = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  operationId: string
  name: string
  note?: string
  taskId?: string
  checkpointId?: string
  createdAtMs: number
}>

export class HistoryService {
  public constructor(
    private readonly repository: HistoryRepository,
    private readonly manifests: HistoryManifestBuilder,
    private readonly vcs: HistoryVcsPort,
    private readonly now: () => number = Date.now,
  ) {}

  public saveAutomatic(input: SaveHistoryInput): Promise<HistoryEntrySummary> {
    return this.save(input, "automatic", "complete_world")
  }

  public saveManual(input: SaveHistoryInput, pausedCheckpoint: boolean): Promise<HistoryEntrySummary> {
    return this.save(input, "manual", pausedCheckpoint ? "paused_checkpoint" : "complete_world")
  }

  public listEntries(projectId: ProjectId): Promise<readonly HistoryEntrySummary[]> {
    return this.repository.listEntries(projectId)
  }

  private async save(
    input: SaveHistoryInput,
    kind: "automatic" | "manual",
    state: "complete_world" | "paused_checkpoint",
  ): Promise<HistoryEntrySummary> {
    const intent = await this.repository.beginSave({
      projectId: input.projectId,
      operationId: input.operationId,
      kind,
      state,
      name: input.name,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
      createdAtMs: input.createdAtMs,
    })
    if (intent.alreadyReady) return intent.entry
    try {
      const snapshot = await this.manifests.build(input.projectId, input.workspaceRootRef, intent)
      const commitOid = await this.vcs.writeSnapshot({
        manifest: snapshot.manifest,
        files: snapshot.files,
        ...(intent.parentCommitOid === undefined ? {} : { parentCommitOid: intent.parentCommitOid }),
      })
      return await this.repository.completeSave(
        intent.entry.entryId,
        commitOid,
        snapshot.manifest.digest,
        this.now(),
      )
    } catch (error) {
      await this.repository.failSave(intent.entry.entryId, error, this.now())
      throw error
    }
  }
}
