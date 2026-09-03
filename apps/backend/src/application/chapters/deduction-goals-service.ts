import type {
  DeductionGoal,
  DeductionGoalNarrativeKind,
  DeductionGoalProgress,
  DeductionGoalProposal,
  DeductionGoalReconcileIssue,
  DeductionGoalReconcileResult,
  DeductionGoalScale,
  DeductionGoalsLegacyImportItem,
  DeductionGoalsSnapshot,
  GoalProposalPayload,
  ProjectId,
  TurnDeductionGoalBundle,
} from "@worldseed/contracts"
import { goalProposalPayloadSchema, selectGoalsForChapterContext } from "@worldseed/contracts"

import type { SqliteDeductionGoalsRepository } from "../../infrastructure/sqlite/repositories/sqlite-deduction-goals-repository.js"

export type DeductionGoalsServiceDependencies = Readonly<{
  goals: SqliteDeductionGoalsRepository
  createId: () => string
  now: () => number
}>

export class DeductionGoalsService {
  public constructor(private readonly dependencies: DeductionGoalsServiceDependencies) {}

  public async list(projectId: ProjectId): Promise<DeductionGoalsSnapshot> {
    const [goals, progress, pendingProposals] = await Promise.all([
      this.dependencies.goals.listGoals(projectId),
      this.dependencies.goals.listProgress(projectId),
      this.dependencies.goals.listPendingProposals(projectId),
    ])
    const updatedAtMs = Math.max(
      0,
      ...goals.map((goal) => goal.updatedAtMs),
      ...progress.map((item) => item.recordedAtMs),
      ...pendingProposals.map((proposal) => proposal.createdAtMs),
    )
    return {
      projectId,
      goals: [...goals],
      progress: [...progress],
      pendingProposals: [...pendingProposals],
      updatedAtMs,
    }
  }

  public async create(input: Readonly<{
    projectId: ProjectId
    content: string
    narrativeKind?: DeductionGoalNarrativeKind
    scale?: DeductionGoalScale
    plantChapterSequence?: number
    payoffChapterSequence?: number
  }>): Promise<DeductionGoalsSnapshot> {
    assertPlantPayoffWindow(input.plantChapterSequence, input.payoffChapterSequence)
    const now = this.dependencies.now()
    const goal: DeductionGoal = {
      goalId: this.dependencies.createId(),
      projectId: input.projectId,
      content: input.content.trim(),
      source: "user",
      lifecycle: "active",
      narrativeKind: input.narrativeKind ?? "general",
      scale: input.scale ?? "short",
      createdAtMs: now,
      updatedAtMs: now,
      ...(input.plantChapterSequence === undefined
        ? {}
        : { plantChapterSequence: input.plantChapterSequence }),
      ...(input.payoffChapterSequence === undefined
        ? {}
        : { payoffChapterSequence: input.payoffChapterSequence }),
    }
    await this.dependencies.goals.insertGoal(goal)
    return this.list(input.projectId)
  }

  public async update(input: Readonly<{
    projectId: ProjectId
    goalId: string
    content?: string
    action?: "update_content" | "complete" | "remove"
    narrativeKind?: DeductionGoalNarrativeKind
    scale?: DeductionGoalScale
    plantChapterSequence?: number
    payoffChapterSequence?: number
  }>): Promise<DeductionGoalsSnapshot> {
    const goal = await this.requireGoal(input.projectId, input.goalId)
    const hasTaxonomy = input.narrativeKind !== undefined
      || input.scale !== undefined
      || input.plantChapterSequence !== undefined
      || input.payoffChapterSequence !== undefined
    const action = input.action
      ?? (input.content !== undefined || hasTaxonomy ? "update_content" : undefined)
    const now = this.dependencies.now()

    if (action === undefined) {
      throw new Error("content, taxonomy fields, or action is required")
    }

    if (action === "update_content") {
      const content = input.content?.trim()
      if ((content === undefined || content.length === 0) && !hasTaxonomy) {
        throw new Error("content is required for update_content")
      }
      if (goal.lifecycle !== "active") {
        throw new Error("only active goals can be edited")
      }
      const nextPlant = input.plantChapterSequence ?? goal.plantChapterSequence
      const nextPayoff = input.payoffChapterSequence ?? goal.payoffChapterSequence
      if (
        nextPlant !== undefined
        && nextPayoff !== undefined
        && nextPlant > nextPayoff
      ) {
        throw new Error("plantChapterSequence must be ≤ payoffChapterSequence")
      }
      await this.dependencies.goals.updateGoal({
        ...goal,
        content: content !== undefined && content.length > 0 ? content : goal.content,
        narrativeKind: input.narrativeKind ?? goal.narrativeKind,
        scale: input.scale ?? goal.scale,
        updatedAtMs: now,
        ...(input.plantChapterSequence === undefined
          ? (goal.plantChapterSequence === undefined ? {} : { plantChapterSequence: goal.plantChapterSequence })
          : { plantChapterSequence: input.plantChapterSequence }),
        ...(input.payoffChapterSequence === undefined
          ? (goal.payoffChapterSequence === undefined ? {} : { payoffChapterSequence: goal.payoffChapterSequence })
          : { payoffChapterSequence: input.payoffChapterSequence }),
      })
      return this.list(input.projectId)
    }

    if (action === "complete") {
      if (goal.lifecycle !== "active") {
        throw new Error("only active goals can be completed")
      }
      await this.dependencies.goals.updateGoal({
        ...goal,
        lifecycle: "completed",
        updatedAtMs: now,
        completedAtMs: now,
      })
      return this.list(input.projectId)
    }

    if (goal.lifecycle === "removed") {
      return this.list(input.projectId)
    }
    await this.dependencies.goals.updateGoal({
      ...goal,
      lifecycle: "removed",
      updatedAtMs: now,
      removedAtMs: now,
      removedBy: "user",
    })
    return this.list(input.projectId)
  }

  public async setProgress(input: Readonly<{
    projectId: ProjectId
    goalId: string
    chapterSequence: number
    summary: string
    status: "planned" | "achieved" | "partial" | "missed"
  }>): Promise<DeductionGoalsSnapshot> {
    const goal = await this.requireGoal(input.projectId, input.goalId)
    if (goal.lifecycle !== "active") {
      throw new Error("only active goals accept chapter progress")
    }
    const summary = input.summary.trim()
    if (summary.length === 0) {
      throw new Error("summary is required")
    }
    const now = this.dependencies.now()
    const existing = await this.dependencies.goals.findCurrentProgress(
      input.projectId,
      input.goalId,
      input.chapterSequence,
    )

    if (existing !== undefined && existing.lockedAtMs !== undefined && existing.status === "planned") {
      // Locked planned rows are immutable; supersede with a new current row.
      // Mark superseded first (no FK) so the partial unique index frees the slot,
      // then insert the replacement and link the FK.
      const next: DeductionGoalProgress = {
        progressId: this.dependencies.createId(),
        projectId: input.projectId,
        goalId: input.goalId,
        chapterSequence: input.chapterSequence,
        summary,
        status: input.status,
        source: input.status === "planned" ? "user" : "turn_review",
        recordedAtMs: now,
      }
      await this.dependencies.goals.markProgressSuperseded(existing.progressId, now)
      await this.dependencies.goals.insertProgress(next)
      await this.dependencies.goals.linkSupersededProgress(existing.progressId, next.progressId)
      return this.list(input.projectId)
    }

    if (existing !== undefined) {
      await this.dependencies.goals.updateProgress({
        ...existing,
        summary,
        status: input.status,
        source: "user",
        recordedAtMs: now,
        lockedAtMs: undefined,
      })
      return this.list(input.projectId)
    }

    await this.dependencies.goals.insertProgress({
      progressId: this.dependencies.createId(),
      projectId: input.projectId,
      goalId: input.goalId,
      chapterSequence: input.chapterSequence,
      summary,
      status: input.status,
      source: "user",
      recordedAtMs: now,
    })
    return this.list(input.projectId)
  }

  public async approveProposals(input: Readonly<{
    projectId: ProjectId
    proposalIds: readonly string[]
  }>): Promise<DeductionGoalsSnapshot> {
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.goals.findProposal(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      await this.applyProposal(proposal)
      await this.dependencies.goals.resolveProposal(proposalId, "approved", this.dependencies.now())
    }
    return this.list(input.projectId)
  }

  public async rejectProposals(input: Readonly<{
    projectId: ProjectId
    proposalIds: readonly string[]
  }>): Promise<DeductionGoalsSnapshot> {
    const now = this.dependencies.now()
    for (const proposalId of input.proposalIds) {
      const proposal = await this.dependencies.goals.findProposal(proposalId)
      if (proposal === undefined || proposal.projectId !== input.projectId) {
        throw new Error(`proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "pending") continue
      await this.dependencies.goals.resolveProposal(proposalId, "rejected", now)
    }
    return this.list(input.projectId)
  }

  public async importLegacy(input: Readonly<{
    projectId: ProjectId
    goals: readonly DeductionGoalsLegacyImportItem[]
  }>): Promise<DeductionGoalsSnapshot> {
    const existingCount = await this.dependencies.goals.countGoals(input.projectId)
    if (existingCount > 0) {
      return this.list(input.projectId)
    }
    const now = this.dependencies.now()
    for (const item of input.goals) {
      if (item.status === "pending") {
        const payload: GoalProposalPayload = {
          kind: "create",
          content: item.content,
        }
        const proposal: DeductionGoalProposal = {
          proposalId: this.dependencies.createId(),
          projectId: input.projectId,
          kind: "create",
          payload,
          status: "pending",
          createdAtMs: item.createdAtMs,
        }
        await this.dependencies.goals.insertProposal(proposal)
        continue
      }
      const goal: DeductionGoal = {
        goalId: this.dependencies.createId(),
        projectId: input.projectId,
        content: item.content,
        source: item.source,
        lifecycle: item.status === "completed" ? "completed" : "active",
        narrativeKind: "general",
        scale: "short",
        createdAtMs: item.createdAtMs,
        updatedAtMs: item.completedAtMs ?? item.createdAtMs,
        ...(item.status === "completed"
          ? { completedAtMs: item.completedAtMs ?? now }
          : {}),
      }
      await this.dependencies.goals.insertGoal(goal)
    }
    return this.list(input.projectId)
  }

  public async createProposalsFromArtifact(input: Readonly<{
    projectId: ProjectId
    proposals: readonly Readonly<{ payload: GoalProposalPayload; reason?: string }>[]
    sourceMessageId?: string
  }>): Promise<readonly DeductionGoalProposal[]> {
    const now = this.dependencies.now()
    const created: DeductionGoalProposal[] = []
    for (const item of input.proposals) {
      const parsed = goalProposalPayloadSchema.safeParse(item.payload)
      if (!parsed.success) continue
      const payload = parsed.data
      if (!(await this.isValidProposalPayload(input.projectId, payload))) {
        continue
      }
      const proposal: DeductionGoalProposal = {
        proposalId: this.dependencies.createId(),
        projectId: input.projectId,
        kind: payload.kind,
        ...(payload.kind === "create"
          ? {}
          : { goalId: "goalId" in payload ? payload.goalId : undefined }),
        payload,
        status: "pending",
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
        createdAtMs: now,
      }
      await this.dependencies.goals.insertProposal(proposal)
      created.push(proposal)
    }
    return created
  }

  /** Internal: lock planned progress for a chapter (P3 beginTurn). */
  public async lockForTurn(input: Readonly<{
    projectId: ProjectId
    chapterSequence: number
  }>): Promise<void> {
    const progress = await this.dependencies.goals.listProgress(input.projectId)
    const now = this.dependencies.now()
    for (const item of progress) {
      if (item.chapterSequence !== input.chapterSequence) continue
      if (item.status !== "planned") continue
      if (item.lockedAtMs !== undefined) continue
      await this.dependencies.goals.updateProgress({
        ...item,
        lockedAtMs: now,
        recordedAtMs: now,
      })
    }
  }

  public async buildTurnBundle(input: Readonly<{
    projectId: ProjectId
    chapterSequence: number
  }>): Promise<TurnDeductionGoalBundle> {
    const [goals, progress] = await Promise.all([
      this.dependencies.goals.listGoals(input.projectId),
      this.dependencies.goals.listProgress(input.projectId),
    ])
    const activeGoals = [...selectGoalsForChapterContext(goals, input.chapterSequence)]
    const activeIds = new Set(activeGoals.map((goal) => goal.goalId))
    return {
      chapterSequence: input.chapterSequence,
      activeGoals,
      chapterProgress: progress.filter(
        (item) => item.chapterSequence === input.chapterSequence
          && item.status !== "superseded"
          && activeIds.has(item.goalId),
      ),
    }
  }

  public async reconcileForTurn(input: Readonly<{
    projectId: ProjectId
    chapterSequence: number
    synopsisMarkdown: string
  }>): Promise<DeductionGoalReconcileResult> {
    const snapshot = await this.list(input.projectId)
    const warnings: DeductionGoalReconcileIssue[] = []
    const blocking: DeductionGoalReconcileIssue[] = []
    const activeGoals = selectGoalsForChapterContext(snapshot.goals, input.chapterSequence)
    const chapterProgress = snapshot.progress.filter(
      (item) => item.chapterSequence === input.chapterSequence && item.status !== "superseded",
    )
    const progressByGoal = new Map(chapterProgress.map((item) => [item.goalId, item]))

    if (snapshot.pendingProposals.length > 0) {
      warnings.push({
        code: "pending_proposals",
        severity: "warning",
        message: `仍有 ${String(snapshot.pendingProposals.length)} 条 Agent 目标提案未处理，开始推演后仍可稍后采纳，但本轮不会自动生效`,
      })
    }

    for (const goal of activeGoals) {
      const progress = progressByGoal.get(goal.goalId)
      if (progress === undefined || progress.summary.trim().length === 0) {
        warnings.push({
          code: "missing_chapter_progress",
          severity: "warning",
          message: `活跃目标「${goal.content}」尚未填写第 ${String(input.chapterSequence)} 章 planned 进展`,
          goalId: goal.goalId,
        })
        continue
      }
      if (isSynopsisGoalMismatch(input.synopsisMarkdown, goal.content, progress.summary)) {
        blocking.push({
          code: "synopsis_goal_mismatch",
          severity: "blocking",
          message: `梗概与目标「${goal.content}」的本章预期存在明显冲突：梗概未覆盖关键约束词，且预期摘要与梗概语义对立`,
          goalId: goal.goalId,
        })
      }
    }

    return { warnings, blocking }
  }

  private async applyProposal(proposal: DeductionGoalProposal): Promise<void> {
    const now = this.dependencies.now()
    const payload = proposal.payload

    if (payload.kind === "create") {
      assertPlantPayoffWindow(payload.plantChapterSequence, payload.payoffChapterSequence)
      await this.dependencies.goals.insertGoal({
        goalId: this.dependencies.createId(),
        projectId: proposal.projectId,
        content: payload.content,
        source: "agent",
        lifecycle: "active",
        narrativeKind: payload.narrativeKind ?? "general",
        scale: payload.scale ?? "short",
        createdAtMs: now,
        updatedAtMs: now,
        ...(payload.plantChapterSequence === undefined
          ? {}
          : { plantChapterSequence: payload.plantChapterSequence }),
        ...(payload.payoffChapterSequence === undefined
          ? {}
          : { payoffChapterSequence: payload.payoffChapterSequence }),
      })
      return
    }

    if (payload.kind === "update_content") {
      const goal = await this.requireGoal(proposal.projectId, payload.goalId)
      const nextContent = payload.content?.trim()
      const nextPlant = payload.plantChapterSequence ?? goal.plantChapterSequence
      const nextPayoff = payload.payoffChapterSequence ?? goal.payoffChapterSequence
      assertPlantPayoffWindow(nextPlant, nextPayoff)
      await this.dependencies.goals.updateGoal({
        ...goal,
        content: nextContent !== undefined && nextContent.length > 0 ? nextContent : goal.content,
        narrativeKind: payload.narrativeKind ?? goal.narrativeKind,
        scale: payload.scale ?? goal.scale,
        updatedAtMs: now,
        ...(payload.plantChapterSequence === undefined
          ? (goal.plantChapterSequence === undefined ? {} : { plantChapterSequence: goal.plantChapterSequence })
          : { plantChapterSequence: payload.plantChapterSequence }),
        ...(payload.payoffChapterSequence === undefined
          ? (goal.payoffChapterSequence === undefined ? {} : { payoffChapterSequence: goal.payoffChapterSequence })
          : { payoffChapterSequence: payload.payoffChapterSequence }),
      })
      return
    }

    if (payload.kind === "complete") {
      const goal = await this.requireGoal(proposal.projectId, payload.goalId)
      await this.dependencies.goals.updateGoal({
        ...goal,
        lifecycle: "completed",
        updatedAtMs: now,
        completedAtMs: now,
      })
      return
    }

    if (payload.kind === "remove") {
      const goal = await this.requireGoal(proposal.projectId, payload.goalId)
      await this.dependencies.goals.updateGoal({
        ...goal,
        lifecycle: "removed",
        updatedAtMs: now,
        removedAtMs: now,
        removedBy: "agent",
      })
      return
    }

    await this.setProgress({
      projectId: proposal.projectId,
      goalId: payload.goalId,
      chapterSequence: payload.chapterSequence,
      summary: payload.summary,
      status: "planned",
    })
  }

  private async requireGoal(projectId: ProjectId, goalId: string): Promise<DeductionGoal> {
    const goal = await this.dependencies.goals.findGoal(goalId)
    if (goal === undefined || goal.projectId !== projectId) {
      throw new Error(`goal not found: ${goalId}`)
    }
    return goal
  }

  private async isValidProposalPayload(
    projectId: ProjectId,
    payload: GoalProposalPayload,
  ): Promise<boolean> {
    if (payload.kind === "create") {
      return payload.content.trim().length > 0
    }
    const goal = await this.dependencies.goals.findGoal(payload.goalId)
    return goal !== undefined
      && goal.projectId === projectId
      && goal.lifecycle === "active"
  }
}

function assertPlantPayoffWindow(
  plantChapterSequence: number | undefined,
  payoffChapterSequence: number | undefined,
): void {
  if (
    plantChapterSequence !== undefined
    && payoffChapterSequence !== undefined
    && plantChapterSequence > payoffChapterSequence
  ) {
    throw new Error("plantChapterSequence must be ≤ payoffChapterSequence")
  }
}

/** Lightweight heuristic: only block when progress asserts a clear negation absent from synopsis. */
function isSynopsisGoalMismatch(
  synopsisMarkdown: string,
  goalContent: string,
  progressSummary: string,
): boolean {
  const synopsis = normalizeForMatch(synopsisMarkdown)
  const summary = normalizeForMatch(progressSummary)
  if (synopsis.length === 0 || summary.length === 0) return false
  const negationMarkers = ["不得", "禁止", "不能", "不要", "避免", "严禁"]
  const hasNegation = negationMarkers.some((marker) => summary.includes(marker))
  if (!hasNegation) return false
  const goalTokens = tokenizeSignificant(goalContent)
  const summaryTokens = tokenizeSignificant(progressSummary)
  const shared = [...goalTokens, ...summaryTokens].filter((token) => synopsis.includes(token))
  return shared.length === 0
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "")
}

function tokenizeSignificant(value: string): readonly string[] {
  return value
    .split(/[\s,，。；;：:、/|（）()【】\[\]「」『』]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2)
}
