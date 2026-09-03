import type {
  ProjectId,
  SettingsExtractionProposal,
  SettingsExtractionProposalInput,
  SettingsExtractionSnapshot,
  SettingsProposalPayload,
  WorldDivergenceMode,
} from "@worldseed/contracts"
import { settingsProposalPayloadSchema } from "@worldseed/contracts"

import { assertWorkspaceMutationAllowed } from "../../core/index.js"
import type { WorkspacePort } from "../workspace/index.js"
import type { SqliteSettingsExtractionRepository } from "../../infrastructure/sqlite/repositories/sqlite-settings-extraction-repository.js"
import { allowsSettingsCreate } from "./world-divergence-policy.js"
import type { SettingsLineageService } from "./settings-lineage-service.js"

export class SettingsExtractionService {
  public constructor(private readonly dependencies: Readonly<{
    proposals: SqliteSettingsExtractionRepository
    workspace: WorkspacePort
    createId: () => string
    now: () => number
    lineage?: SettingsLineageService
    resolveCausingChapterSequence?: (taskId: string) => Promise<number | undefined>
  }>) {}

  public async listByTask(taskId: string): Promise<SettingsExtractionSnapshot> {
    const proposals = await this.dependencies.proposals.listByTask(taskId)
    return { proposals: [...proposals] }
  }

  public async listPendingByTask(taskId: string): Promise<readonly SettingsExtractionProposal[]> {
    return this.dependencies.proposals.listPendingByTask(taskId)
  }

  public async createProposalsFromArtifact(input: Readonly<{
    projectId: ProjectId
    taskId: string
    phaseRunId: string
    proposals: readonly SettingsExtractionProposalInput[]
    worldDivergenceMode?: WorldDivergenceMode
  }>): Promise<readonly SettingsExtractionProposal[]> {
    const allowCreate = allowsSettingsCreate(input.worldDivergenceMode ?? "world_consistent")
    const created: SettingsExtractionProposal[] = []
    for (const item of input.proposals) {
      const payload = settingsProposalPayloadSchema.parse(item.payload)
      if (!this.isValidPayload(payload)) continue
      if (!allowCreate && payload.kind === "create") continue
      const proposal: SettingsExtractionProposal = {
        proposalId: this.dependencies.createId(),
        projectId: input.projectId,
        taskId: input.taskId,
        kind: payload.kind,
        payload,
        status: "pending",
        phaseRunId: input.phaseRunId,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        ...(item.conflictNotes === undefined ? {} : { conflictNotes: item.conflictNotes }),
        createdAtMs: this.dependencies.now(),
      }
      await this.dependencies.proposals.insert(proposal)
      created.push(proposal)
    }
    return created
  }

  public async approveProposals(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    proposalIds: readonly string[]
    reasonOverride?: string
  }>): Promise<SettingsExtractionSnapshot> {
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.proposals.find(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`settings proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      await this.applyProposal(input.workspaceRootRef, proposal, input.reasonOverride)
      await this.dependencies.proposals.resolve(proposalId, "approved", this.dependencies.now())
    }
    const taskId = (await this.resolveTaskId(input.proposalIds)) ?? ""
    return taskId.length === 0
      ? { proposals: [] }
      : this.listByTask(taskId)
  }

  public async rejectProposals(input: Readonly<{
    projectId: ProjectId
    proposalIds: readonly string[]
  }>): Promise<SettingsExtractionSnapshot> {
    const now = this.dependencies.now()
    let taskId = ""
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.proposals.find(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`settings proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      taskId = proposal.taskId
      await this.dependencies.proposals.resolve(proposalId, "rejected", now)
    }
    return taskId.length === 0 ? { proposals: [] } : this.listByTask(taskId)
  }

  public async assertTaskReadyToContinue(taskId: string): Promise<void> {
    const pending = await this.dependencies.proposals.listPendingByTask(taskId)
    if (pending.length > 0) {
      throw new Error(`仍有 ${String(pending.length)} 条设定提案待确认，请先采纳或拒绝后再继续图治理`)
    }
  }

  private async resolveTaskId(proposalIds: readonly string[]): Promise<string | undefined> {
    for (const proposalId of proposalIds) {
      const proposal = await this.dependencies.proposals.find(proposalId)
      if (proposal !== undefined) return proposal.taskId
    }
    return undefined
  }

  private isValidPayload(payload: SettingsProposalPayload): boolean {
    try {
      if (payload.kind === "create" || payload.kind === "update") {
        assertWorkspaceMutationAllowed(payload.relativePath, "file", "user")
      } else {
        assertWorkspaceMutationAllowed(payload.targetPath, "file", "user")
        for (const path of payload.mergedFromPaths) assertWorkspaceMutationAllowed(path, "file", "user")
      }
      return true
    } catch {
      return false
    }
  }

  private async applyProposal(
    workspaceRootRef: string,
    proposal: SettingsExtractionProposal,
    reasonOverride?: string,
  ): Promise<void> {
    const payload = proposal.payload
    const summary = reasonOverride?.trim() || proposal.reason
    const causingChapterSequence = this.dependencies.resolveCausingChapterSequence === undefined
      ? undefined
      : await this.dependencies.resolveCausingChapterSequence(proposal.taskId)
    const record = async (relativePath: string, markdown: string): Promise<void> => {
      await this.dependencies.workspace.saveUserMarkdown(workspaceRootRef, relativePath, markdown)
      await this.dependencies.lineage?.recordUpsert({
        relativePath,
        markdown,
        sourceKind: "extraction_approve",
        sourceRef: proposal.proposalId,
        ...(summary === undefined || summary.length === 0 ? {} : { summary }),
        ...(causingChapterSequence === undefined ? {} : { causingChapterSequence }),
      })
    }
    if (payload.kind === "create") {
      await record(payload.relativePath, payload.markdown)
      if (payload.readmeEntry !== undefined && payload.readmeEntry.trim().length > 0) {
        await this.appendReadmeEntry(workspaceRootRef, payload.readmeEntry.trim(), proposal.proposalId)
      }
      return
    }
    if (payload.kind === "update") {
      await record(payload.relativePath, payload.markdown)
      return
    }
    await record(payload.targetPath, payload.markdown)
  }

  private async appendReadmeEntry(
    workspaceRootRef: string,
    entry: string,
    proposalId: string,
  ): Promise<void> {
    const readmePath = "设定集/readme.md"
    let current = ""
    try {
      current = await this.dependencies.workspace.readMarkdown(workspaceRootRef, readmePath)
    } catch {
      current = "# 设定集索引\n\n"
    }
    if (current.includes(entry)) return
    const suffix = current.endsWith("\n") ? "" : "\n"
    const next = `${current}${suffix}- ${entry}\n`
    await this.dependencies.workspace.saveUserMarkdown(workspaceRootRef, readmePath, next)
    await this.dependencies.lineage?.recordUpsert({
      relativePath: readmePath,
      markdown: next,
      sourceKind: "extraction_approve",
      sourceRef: proposalId,
      summary: "更新设定集索引",
    })
  }
}
