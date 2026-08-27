import type { Kysely } from "kysely"

import type {
  DeductionGoal,
  DeductionGoalProgress,
  DeductionGoalProposal,
  ProjectId,
} from "@worldseed/contracts"
import { goalProposalPayloadSchema } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteDeductionGoalsRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async listGoals(projectId: ProjectId): Promise<readonly DeductionGoal[]> {
    const rows = await this.database.selectFrom("deduction_goals").selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapGoal)
  }

  public async findGoal(goalId: string): Promise<DeductionGoal | undefined> {
    const row = await this.database.selectFrom("deduction_goals").selectAll()
      .where("goal_id", "=", goalId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapGoal(row)
  }

  public async insertGoal(goal: DeductionGoal): Promise<void> {
    await this.database.insertInto("deduction_goals").values({
      goal_id: goal.goalId,
      project_id: goal.projectId,
      content: goal.content,
      source: goal.source,
      lifecycle: goal.lifecycle,
      created_at_ms: goal.createdAtMs,
      updated_at_ms: goal.updatedAtMs,
      completed_at_ms: goal.completedAtMs ?? null,
      removed_at_ms: goal.removedAtMs ?? null,
      removed_by: goal.removedBy ?? null,
    }).executeTakeFirstOrThrow()
  }

  public async updateGoal(goal: DeductionGoal): Promise<void> {
    await this.database.updateTable("deduction_goals").set({
      content: goal.content,
      lifecycle: goal.lifecycle,
      updated_at_ms: goal.updatedAtMs,
      completed_at_ms: goal.completedAtMs ?? null,
      removed_at_ms: goal.removedAtMs ?? null,
      removed_by: goal.removedBy ?? null,
    }).where("goal_id", "=", goal.goalId).executeTakeFirstOrThrow()
  }

  public async listProgress(projectId: ProjectId): Promise<readonly DeductionGoalProgress[]> {
    const rows = await this.database.selectFrom("deduction_goal_progress").selectAll()
      .where("project_id", "=", projectId)
      .where("status", "!=", "superseded")
      .orderBy("chapter_sequence", "asc")
      .orderBy("recorded_at_ms", "asc")
      .execute()
    return rows.map(mapProgress)
  }

  public async findCurrentProgress(
    projectId: ProjectId,
    goalId: string,
    chapterSequence: number,
  ): Promise<DeductionGoalProgress | undefined> {
    const row = await this.database.selectFrom("deduction_goal_progress").selectAll()
      .where("project_id", "=", projectId)
      .where("goal_id", "=", goalId)
      .where("chapter_sequence", "=", chapterSequence)
      .where("status", "!=", "superseded")
      .executeTakeFirst()
    return row === undefined ? undefined : mapProgress(row)
  }

  public async insertProgress(progress: DeductionGoalProgress): Promise<void> {
    await this.database.insertInto("deduction_goal_progress").values({
      progress_id: progress.progressId,
      project_id: progress.projectId,
      goal_id: progress.goalId,
      chapter_sequence: progress.chapterSequence,
      chapter_id: progress.chapterId ?? null,
      summary: progress.summary,
      status: progress.status,
      source: progress.source,
      locked_at_ms: progress.lockedAtMs ?? null,
      recorded_at_ms: progress.recordedAtMs,
      superseded_by_progress_id: null,
    }).executeTakeFirstOrThrow()
  }

  public async supersedeProgress(
    progressId: string,
    supersededByProgressId: string,
    recordedAtMs: number,
  ): Promise<void> {
    await this.database.updateTable("deduction_goal_progress").set({
      status: "superseded",
      recorded_at_ms: recordedAtMs,
    }).where("progress_id", "=", progressId).executeTakeFirstOrThrow()
    await this.database.updateTable("deduction_goal_progress").set({
      superseded_by_progress_id: supersededByProgressId,
    }).where("progress_id", "=", progressId).executeTakeFirstOrThrow()
  }

  public async markProgressSuperseded(progressId: string, recordedAtMs: number): Promise<void> {
    await this.database.updateTable("deduction_goal_progress").set({
      status: "superseded",
      recorded_at_ms: recordedAtMs,
    }).where("progress_id", "=", progressId).executeTakeFirstOrThrow()
  }

  public async linkSupersededProgress(
    progressId: string,
    supersededByProgressId: string,
  ): Promise<void> {
    await this.database.updateTable("deduction_goal_progress").set({
      superseded_by_progress_id: supersededByProgressId,
    }).where("progress_id", "=", progressId).executeTakeFirstOrThrow()
  }

  public async updateProgress(progress: DeductionGoalProgress): Promise<void> {
    await this.database.updateTable("deduction_goal_progress").set({
      summary: progress.summary,
      status: progress.status,
      source: progress.source,
      chapter_id: progress.chapterId ?? null,
      locked_at_ms: progress.lockedAtMs ?? null,
      recorded_at_ms: progress.recordedAtMs,
    }).where("progress_id", "=", progress.progressId).executeTakeFirstOrThrow()
  }

  public async listPendingProposals(projectId: ProjectId): Promise<readonly DeductionGoalProposal[]> {
    const rows = await this.database.selectFrom("deduction_goal_proposals").selectAll()
      .where("project_id", "=", projectId)
      .where("status", "=", "pending")
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapProposal)
  }

  public async findProposal(proposalId: string): Promise<DeductionGoalProposal | undefined> {
    const row = await this.database.selectFrom("deduction_goal_proposals").selectAll()
      .where("proposal_id", "=", proposalId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapProposal(row)
  }

  public async insertProposal(proposal: DeductionGoalProposal): Promise<void> {
    await this.database.insertInto("deduction_goal_proposals").values({
      proposal_id: proposal.proposalId,
      project_id: proposal.projectId,
      kind: proposal.kind,
      goal_id: proposal.goalId ?? null,
      payload_json: encodeJson(proposal.payload),
      status: proposal.status,
      source_message_id: proposal.sourceMessageId ?? null,
      created_at_ms: proposal.createdAtMs,
      resolved_at_ms: proposal.resolvedAtMs ?? null,
    }).executeTakeFirstOrThrow()
  }

  public async resolveProposal(
    proposalId: string,
    status: "approved" | "rejected",
    resolvedAtMs: number,
  ): Promise<void> {
    await this.database.updateTable("deduction_goal_proposals").set({
      status,
      resolved_at_ms: resolvedAtMs,
    }).where("proposal_id", "=", proposalId).executeTakeFirstOrThrow()
  }

  public async countGoals(projectId: ProjectId): Promise<number> {
    const row = await this.database.selectFrom("deduction_goals")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }
}

function mapGoal(row: ProjectDatabase["deduction_goals"]): DeductionGoal {
  return {
    goalId: row.goal_id,
    projectId: row.project_id as ProjectId,
    content: row.content,
    source: row.source,
    lifecycle: row.lifecycle,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.completed_at_ms === null ? {} : { completedAtMs: row.completed_at_ms }),
    ...(row.removed_at_ms === null ? {} : { removedAtMs: row.removed_at_ms }),
    ...(row.removed_by === null ? {} : { removedBy: row.removed_by }),
  }
}

function mapProgress(row: ProjectDatabase["deduction_goal_progress"]): DeductionGoalProgress {
  return {
    progressId: row.progress_id,
    projectId: row.project_id as ProjectId,
    goalId: row.goal_id,
    chapterSequence: row.chapter_sequence,
    summary: row.summary,
    status: row.status,
    source: row.source,
    recordedAtMs: row.recorded_at_ms,
    ...(row.chapter_id === null ? {} : { chapterId: row.chapter_id }),
    ...(row.locked_at_ms === null ? {} : { lockedAtMs: row.locked_at_ms }),
  }
}

function mapProposal(row: ProjectDatabase["deduction_goal_proposals"]): DeductionGoalProposal {
  const payload = goalProposalPayloadSchema.parse(decodeJson(row.payload_json))
  return {
    proposalId: row.proposal_id,
    projectId: row.project_id as ProjectId,
    kind: row.kind,
    payload,
    status: row.status,
    createdAtMs: row.created_at_ms,
    ...(row.goal_id === null ? {} : { goalId: row.goal_id }),
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    ...(row.resolved_at_ms === null ? {} : { resolvedAtMs: row.resolved_at_ms }),
  }
}
