import type { Kysely } from "kysely"

import {
  chapterRevisionSchema,
  chapterRevisionFinalizationStatusSchema,
  type ChapterRevision,
  type ChapterRevisionFinalization,
  type ChapterRevisionDecision,
  type ChapterRevisionReview,
  type ProjectId,
} from "@worldseed/contracts"

import type { ChapterRevisionRepository, StoredChapterRevision } from "../../../application/index.js"
import type {
  ChapterRevisionReviewRow,
  ChapterRevisionTaskRow,
  ChapterRevisionFinalizationRow,
  ProjectDatabase,
} from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteChapterRevisionRepository implements ChapterRevisionRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async create(input: StoredChapterRevision): Promise<void> {
    await this.database.insertInto("chapter_revision_tasks").values({
      id: input.revisionTaskId,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      base_source_id: input.baseSourceId,
      proposed_source_id: input.proposedSourceId,
      predecessor_source_id: input.predecessorSourceId ?? null,
      heading: input.heading,
      content_ref: input.contentRef,
      content_digest: input.contentDigest,
      base_content_digest: input.baseContentDigest,
      submission_mode: input.submissionMode ?? null,
      decision: input.decision,
      review_id: input.review?.reviewId ?? null,
      graph_sync_status: input.graphSyncStatus,
      status: input.status,
      content_scope_id: input.contentScopeId,
      graph_sync_scope_id: null,
      graph_sync_task_id: input.graphSyncTaskId ?? null,
      decision_id: null,
      created_at: input.createdAtMs,
      updated_at: input.updatedAtMs,
    }).executeTakeFirstOrThrow()
  }

  public async find(revisionTaskId: string): Promise<StoredChapterRevision | undefined> {
    const row = await this.database.selectFrom("chapter_revision_tasks").selectAll()
      .where("id", "=", revisionTaskId).executeTakeFirst()
    return row === undefined ? undefined : this.map(row)
  }

  public async findByGraphSyncTaskId(graphSyncTaskId: string): Promise<StoredChapterRevision | undefined> {
    const row = await this.database.selectFrom("chapter_revision_tasks").selectAll()
      .where("graph_sync_task_id", "=", graphSyncTaskId).executeTakeFirst()
    return row === undefined ? undefined : this.map(row)
  }

  public async findActive(projectId: ProjectId, chapterId: string, baseSourceId: string): Promise<StoredChapterRevision | undefined> {
    const row = await this.database.selectFrom("chapter_revision_tasks").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_id", "=", chapterId)
      .where("base_source_id", "=", baseSourceId)
      .where("status", "not in", ["retired", "completed", "failed"])
      .orderBy("updated_at", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : this.map(row)
  }

  public async findActiveForChapter(projectId: ProjectId, chapterId: string): Promise<StoredChapterRevision | undefined> {
    const row = await this.database.selectFrom("chapter_revision_tasks").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_id", "=", chapterId)
      .where("status", "not in", ["retired", "completed", "failed"])
      .orderBy("updated_at", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : this.map(row)
  }

  public async createFinalization(input: Readonly<{
    finalizationId: string
    revisionTaskId: string
    projectId: ProjectId
    proposedSourceId: string
    contentScopeId: string
    contentDigest: string
    createdAtMs: number
  }>): Promise<ChapterRevisionFinalization> {
    await this.database.insertInto("chapter_revision_finalizations").values({
      id: input.finalizationId,
      project_id: input.projectId,
      revision_task_id: input.revisionTaskId,
      proposed_source_id: input.proposedSourceId,
      content_scope_id: input.contentScopeId,
      graph_sync_task_id: null,
      content_digest: input.contentDigest,
      status: "prepared",
      created_at: input.createdAtMs,
      updated_at: input.createdAtMs,
    }).onConflict((conflict) => conflict.column("revision_task_id").doNothing()).execute()
    return this.requireFinalization(input.revisionTaskId)
  }

  public async updateFinalization(input: Readonly<{
    revisionTaskId: string
    status: ChapterRevisionFinalization["status"]
    graphSyncTaskId?: string
    updatedAtMs: number
  }>): Promise<ChapterRevisionFinalization> {
    await this.database.updateTable("chapter_revision_finalizations").set({
      status: input.status,
      updated_at: input.updatedAtMs,
      ...(input.graphSyncTaskId === undefined ? {} : { graph_sync_task_id: input.graphSyncTaskId }),
    }).where("revision_task_id", "=", input.revisionTaskId).executeTakeFirstOrThrow()
    return this.requireFinalization(input.revisionTaskId)
  }

  public async updateProposed(input: Readonly<{
    revisionTaskId: string
    proposedSourceId: string
    heading: string
    contentRef: string
    contentDigest: string
    predecessorSourceId: string
    updatedAtMs: number
  }>): Promise<StoredChapterRevision> {
    await this.database.updateTable("chapter_revision_tasks").set({
      proposed_source_id: input.proposedSourceId,
      predecessor_source_id: input.predecessorSourceId,
      heading: input.heading,
      content_ref: input.contentRef,
      content_digest: input.contentDigest,
      review_id: null,
      decision: "pending",
      decision_id: null,
      submission_mode: null,
      graph_sync_status: "not_started",
      status: "editing",
      updated_at: input.updatedAtMs,
    }).where("id", "=", input.revisionTaskId).executeTakeFirstOrThrow()
    const revision = await this.find(input.revisionTaskId)
    if (revision === undefined) throw new Error(`Chapter revision disappeared: ${input.revisionTaskId}`)
    return revision
  }

  public async saveReview(review: ChapterRevisionReview): Promise<StoredChapterRevision> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("chapter_revision_reviews").values({
        id: review.reviewId,
        revision_task_id: review.revisionTaskId,
        proposed_source_id: review.proposedSourceId,
        content_digest: review.contentDigest,
        issues_json: encodeJson(review.issues),
        recommendation: review.recommendation,
        created_at: review.createdAtMs,
      }).executeTakeFirstOrThrow()
      await transaction.updateTable("chapter_revision_tasks").set({
        review_id: review.reviewId,
        status: "ready_to_submit",
        updated_at: review.createdAtMs,
      }).where("id", "=", review.revisionTaskId).executeTakeFirstOrThrow()
    })
    const revision = await this.find(review.revisionTaskId)
    if (revision === undefined) throw new Error(`Chapter revision disappeared: ${review.revisionTaskId}`)
    return revision
  }

  public async saveDecision(decision: ChapterRevisionDecision): Promise<StoredChapterRevision> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("chapter_revision_decisions").values({
        id: decision.decisionId,
        revision_task_id: decision.revisionTaskId,
        proposed_source_id: decision.proposedSourceId,
        content_digest: decision.contentDigest,
        mode: decision.mode,
        action: decision.action,
        forced: decision.forced ? 1 : 0,
        reason: decision.reason,
        review_id: decision.reviewId ?? null,
        note: decision.note ?? null,
        created_at: decision.createdAtMs,
      }).executeTakeFirstOrThrow()
      await transaction.updateTable("chapter_revision_tasks").set({
        decision_id: decision.decisionId,
        decision: decision.action,
        submission_mode: decision.mode,
        updated_at: decision.createdAtMs,
      }).where("id", "=", decision.revisionTaskId).executeTakeFirstOrThrow()
    })
    const revision = await this.find(decision.revisionTaskId)
    if (revision === undefined) throw new Error(`Chapter revision disappeared: ${decision.revisionTaskId}`)
    return revision
  }

  public async updateState(input: Readonly<{
    revisionTaskId: string
    status: ChapterRevision["status"]
    decision?: ChapterRevision["decision"]
    submissionMode?: ChapterRevision["submissionMode"]
    graphSyncStatus?: ChapterRevision["graphSyncStatus"]
    graphSyncTaskId?: string
    contentScopeId?: string
    updatedAtMs: number
  }>): Promise<StoredChapterRevision> {
    const values: Partial<ChapterRevisionTaskRow> = {
      status: input.status,
      updated_at: input.updatedAtMs,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.submissionMode === undefined ? {} : { submission_mode: input.submissionMode }),
      ...(input.graphSyncStatus === undefined ? {} : { graph_sync_status: input.graphSyncStatus }),
      ...(input.graphSyncTaskId === undefined ? {} : { graph_sync_task_id: input.graphSyncTaskId }),
      ...(input.contentScopeId === undefined ? {} : { content_scope_id: input.contentScopeId }),
    }
    await this.database.updateTable("chapter_revision_tasks").set(values).where("id", "=", input.revisionTaskId).executeTakeFirstOrThrow()
    const revision = await this.find(input.revisionTaskId)
    if (revision === undefined) throw new Error(`Chapter revision disappeared: ${input.revisionTaskId}`)
    return revision
  }

  private async map(row: ChapterRevisionTaskRow): Promise<StoredChapterRevision> {
    const review = row.review_id === null
      ? undefined
      : await this.database.selectFrom("chapter_revision_reviews").selectAll()
        .where("id", "=", row.review_id).executeTakeFirst()
    const finalization = await this.database.selectFrom("chapter_revision_finalizations").selectAll()
      .where("revision_task_id", "=", row.id).executeTakeFirst()
    return {
      revisionTaskId: row.id,
      projectId: row.project_id,
      chapterId: row.chapter_id,
      baseSourceId: row.base_source_id,
      proposedSourceId: row.proposed_source_id,
      ...(row.predecessor_source_id === null ? {} : { predecessorSourceId: row.predecessor_source_id }),
      heading: row.heading,
      contentDigest: row.content_digest,
      ...(row.submission_mode === null ? {} : { submissionMode: row.submission_mode }),
      decision: row.decision,
      ...(review === undefined ? {} : { review: mapReview(review) }),
      graphSyncStatus: row.graph_sync_status,
      ...(row.graph_sync_task_id === null ? {} : { graphSyncTaskId: row.graph_sync_task_id }),
      status: chapterRevisionSchema.shape.status.parse(row.status),
      createdAtMs: row.created_at,
      updatedAtMs: row.updated_at,
      contentRef: row.content_ref,
      contentScopeId: row.content_scope_id ?? "",
      baseContentDigest: row.base_content_digest,
      ...(finalization === undefined ? {} : { finalization: mapFinalization(finalization) }),
    }
  }

  private async requireFinalization(revisionTaskId: string): Promise<ChapterRevisionFinalization> {
    const row = await this.database.selectFrom("chapter_revision_finalizations").selectAll()
      .where("revision_task_id", "=", revisionTaskId).executeTakeFirst()
    if (row === undefined) throw new Error(`Chapter revision finalization disappeared: ${revisionTaskId}`)
    return mapFinalization(row)
  }
}

function mapReview(row: ChapterRevisionReviewRow): ChapterRevisionReview {
  return {
    reviewId: row.id,
    revisionTaskId: row.revision_task_id,
    proposedSourceId: row.proposed_source_id,
    contentDigest: row.content_digest,
    issues: decodeJson(row.issues_json) as ChapterRevisionReview["issues"],
    recommendation: row.recommendation,
    createdAtMs: row.created_at,
  }
}

function mapFinalization(row: ChapterRevisionFinalizationRow): ChapterRevisionFinalization {
  return {
    finalizationId: row.id,
    revisionTaskId: row.revision_task_id,
    status: chapterRevisionFinalizationStatusSchema.parse(row.status),
    ...(row.graph_sync_task_id === null ? {} : { graphSyncTaskId: row.graph_sync_task_id }),
    updatedAtMs: row.updated_at,
  }
}
