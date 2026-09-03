import type {
  GoalProposalPayload,
  ProjectId,
  SynopsisStagingPromoteListResult,
  SynopsisStagingPromoteProposal,
  SynopsisStagingPromoteWrite,
} from "@worldseed/contracts"
import { assertWorkspaceMutationAllowed } from "../../core/index.js"
import type { WorkspacePort } from "../workspace/index.js"
import type { DeductionGoalsService } from "./deduction-goals-service.js"
import type { SettingsLineageService } from "../settings/settings-lineage-service.js"
import type { SqliteSynopsisStagingPromoteRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-staging-promote-repository.js"
import {
  STAGING_FILE_KEYS,
  mergeStagingPatches,
  parseStagingEntries,
  serializeStagingEntries,
  stagingFileTitle,
  type StagingEntry,
} from "./staging-entries.js"

export type StagingPromoteServiceDependencies = Readonly<{
  proposals: SqliteSynopsisStagingPromoteRepository
  goals: DeductionGoalsService
  workspace: WorkspacePort
  createId: () => string
  now: () => number
  lineage?: SettingsLineageService
  resolveSessionChapterSequence?: (sessionId: string) => Promise<number | undefined>
}>

export class StagingPromoteService {
  public constructor(private readonly dependencies: StagingPromoteServiceDependencies) {}

  public async list(input: Readonly<{
    projectId: ProjectId
    sessionId?: string
  }>): Promise<SynopsisStagingPromoteListResult> {
    const proposals = input.sessionId === undefined
      ? await this.dependencies.proposals.listPendingByProject(input.projectId)
      : await this.dependencies.proposals.listPendingBySession(input.sessionId)
    return { proposals: [...proposals] }
  }

  public async createFromArtifact(input: Readonly<{
    projectId: ProjectId
    sessionId: string
    sourceMessageId?: string
    settingsWrites: readonly SynopsisStagingPromoteWrite[]
    goalProposals?: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
    reason?: string
  }>): Promise<SynopsisStagingPromoteProposal> {
    for (const write of input.settingsWrites) {
      assertWorkspaceMutationAllowed(write.relativePath, "file", "user")
    }
    const proposal: SynopsisStagingPromoteProposal = {
      proposalId: this.dependencies.createId(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "pending",
      settingsWrites: [...input.settingsWrites],
      ...(input.goalProposals === undefined || input.goalProposals.length === 0
        ? {}
        : { goalProposals: input.goalProposals.map((item) => ({
            payload: item.payload,
            ...(item.reason === undefined ? {} : { reason: item.reason }),
          })) }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      createdAtMs: this.dependencies.now(),
    }
    await this.dependencies.proposals.insert(proposal)
    return proposal
  }

  public async approve(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    proposalIds: readonly string[]
    reasonOverride?: string
  }>): Promise<SynopsisStagingPromoteListResult> {
    const nowMs = this.dependencies.now()
    let sessionId: string | undefined
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.proposals.find(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`staging promote proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      sessionId = proposal.sessionId
      const causingChapterSequence = this.dependencies.resolveSessionChapterSequence === undefined
        ? undefined
        : await this.dependencies.resolveSessionChapterSequence(proposal.sessionId)
      for (const write of proposal.settingsWrites) {
        assertWorkspaceMutationAllowed(write.relativePath, "file", "user")
        await this.dependencies.workspace.saveUserMarkdown(
          input.workspaceRootRef,
          write.relativePath,
          write.markdown,
        )
        const promoteSummary = input.reasonOverride?.trim() || proposal.reason
        await this.dependencies.lineage?.recordUpsert({
          relativePath: write.relativePath,
          markdown: write.markdown,
          sourceKind: "staging_promote",
          sourceRef: proposal.proposalId,
          ...(promoteSummary === undefined || promoteSummary.length === 0
            ? {}
            : { summary: promoteSummary }),
          ...(causingChapterSequence === undefined ? {} : { causingChapterSequence }),
        })
        if (write.mode === "create" && write.readmeEntry !== undefined && write.readmeEntry.trim().length > 0) {
          await this.appendReadmeEntry(
            input.workspaceRootRef,
            write.readmeEntry.trim(),
            proposal.proposalId,
            causingChapterSequence,
          )
        }
      }
      if (proposal.goalProposals !== undefined && proposal.goalProposals.length > 0) {
        await this.dependencies.goals.createProposalsFromArtifact({
          projectId: input.projectId,
          proposals: proposal.goalProposals.map((item) => ({
            payload: item.payload,
            ...(item.reason === undefined ? {} : { reason: item.reason }),
          })),
          ...(proposal.sourceMessageId === undefined ? {} : { sourceMessageId: proposal.sourceMessageId }),
        })
      }
      await this.markStagingEntriesSettled({
        workspaceRootRef: input.workspaceRootRef,
        entryIds: proposal.settingsWrites.map((write) => write.entryId),
        nowMs,
      })
      await this.dependencies.proposals.resolve(proposalId, "approved", nowMs)
    }
    if (sessionId === undefined) return { proposals: [] }
    return this.list({ projectId: input.projectId, sessionId })
  }

  public async reject(input: Readonly<{
    projectId: ProjectId
    proposalIds: readonly string[]
  }>): Promise<SynopsisStagingPromoteListResult> {
    const nowMs = this.dependencies.now()
    let sessionId: string | undefined
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.proposals.find(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`staging promote proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      sessionId = proposal.sessionId
      await this.dependencies.proposals.resolve(proposalId, "rejected", nowMs)
    }
    if (sessionId === undefined) return { proposals: [] }
    return this.list({ projectId: input.projectId, sessionId })
  }

  private async markStagingEntriesSettled(input: Readonly<{
    workspaceRootRef: string
    entryIds: readonly string[]
    nowMs: number
  }>): Promise<void> {
    const idSet = new Set(input.entryIds)
    if (idSet.size === 0) return
    const paths = Object.values(STAGING_FILE_KEYS)
    for (const relativePath of paths) {
      let raw = ""
      try {
        raw = await this.dependencies.workspace.readMarkdown(input.workspaceRootRef, relativePath)
      } catch {
        continue
      }
      const existing = parseStagingEntries(raw)
      let changed = false
      const next: StagingEntry[] = existing.map((entry) => {
        if (!idSet.has(entry.entryId) || entry.status === "settled") return entry
        changed = true
        return {
          ...entry,
          status: "settled",
          updatedAtMs: input.nowMs,
          settledAtMs: input.nowMs,
        }
      })
      if (!changed) continue
      // Also accept patches that only flip status for matching ids via merge helper.
      const patched = mergeStagingPatches(
        next,
        next.filter((entry) => idSet.has(entry.entryId)).map((entry) => ({
          entryId: entry.entryId,
          title: entry.title,
          body: entry.body.length > 0 ? entry.body : entry.title,
          status: "settled" as const,
          ...(entry.promoteTargetPath === undefined ? {} : { promoteTargetPath: entry.promoteTargetPath }),
        })),
        input.nowMs,
        this.dependencies.createId,
      )
      await this.dependencies.workspace.saveUserMarkdown(
        input.workspaceRootRef,
        relativePath,
        serializeStagingEntries(stagingFileTitle(relativePath), patched),
      )
    }
  }

  private async appendReadmeEntry(
    workspaceRootRef: string,
    entry: string,
    proposalId: string,
    causingChapterSequence?: number,
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
      sourceKind: "staging_promote",
      sourceRef: proposalId,
      summary: "更新设定集索引",
      ...(causingChapterSequence === undefined ? {} : { causingChapterSequence }),
    })
  }
}
