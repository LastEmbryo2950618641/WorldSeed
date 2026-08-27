import {
  chapterRevisionDecisionReasonSchema,
  chapterRevisionStatusSchema,
  phaseRequestEnvelopeSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type ChapterRevision,
  type ChapterRevisionDecision,
  type ChapterRevisionReview,
  type ChapterRevisionReadResult,
  type ChapterSummary,
  type ProjectId,
} from "@worldseed/contracts"

import {
  assembleChapterDocument,
  deriveChapterPublishPath,
  digest,
  normalizeChapterHeading,
  readChapterBody,
} from "../../core/index.js"
import { buildSourceUnitExactKeys } from "../retrieval/index.js"
import type { AIModelPort, PromptResourcePort } from "../turns/ports/ai-model-port.js"
import { revisionReviewArtifactSchema } from "@worldseed/prompt-contracts"
import type { ProjectIdAllocatorPort } from "../ids/index.js"
import type { InternalProjectStore, InternalStorePort, WorkspacePort } from "../workspace/index.js"
import type { DocumentRepository, RetrievalRepository, ScopeCommitRepository, TaskScopeRepository } from "../turns/index.js"
import type { ChapterRevisionRepository, StoredChapterRevision } from "./ports/index.js"
import type { ChapterIndexRecord } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"

export type ChapterRevisionServiceDependencies = Readonly<{
  taskScopes: TaskScopeRepository
  documents: DocumentRepository
  retrieval: RetrievalRepository
  commit: ScopeCommitRepository
  revisions: ChapterRevisionRepository
  chapterIndex: {
    list(projectId: ProjectId): Promise<readonly ChapterIndexRecord[]>
    find(projectId: ProjectId, chapterId: string): Promise<ChapterIndexRecord | undefined>
    nextSequence(projectId: ProjectId): Promise<number>
    assignOnFirstCommit(input: Readonly<{
      projectId: ProjectId
      chapterId: string
      sequence: number
      currentSourceId: string
      currentPublishPath: string
      assignedAtMs: number
    }>): Promise<ChapterIndexRecord>
    updateCurrent(input: Readonly<{
      projectId: ProjectId
      chapterId: string
      currentSourceId: string
      currentPublishPath: string
    }>): Promise<void>
  }
  recordLineageSnapshot(input: Readonly<{
    projectId: ProjectId
    chapterId: string
    sourceId: string
    priorChapterSourceIds: readonly string[]
  }>): Promise<void>
  workspace: WorkspacePort
  internalStore: InternalStorePort
  internalProjectStore: InternalProjectStore
  idAllocator: ProjectIdAllocatorPort
  createId: () => string
  now: () => number
  prompts: PromptResourcePort
  appendChapterRevisionContext(input: Readonly<{
    revision: StoredChapterRevision
    contentRef: string
    contentDigest: string
    contentTokenEstimate: number
    decisionId?: string
  }>): Promise<void>
  runGraphSync(input: Readonly<{
    revision: StoredChapterRevision
    workspaceRootRef: string
    sourceUnitIds: readonly string[]
    model: AIModelPort
    graphSyncTaskId: string
  }>): Promise<void>
}>

export class ChapterRevisionService {
  public constructor(private readonly dependencies: ChapterRevisionServiceDependencies) {}

  public async list(projectId: ProjectId): Promise<readonly ChapterSummary[]> {
    const chapters = await this.dependencies.documents.listCommittedChapters(projectId)
    const indices = new Map(
      (await this.dependencies.chapterIndex.list(projectId)).map((entry) => [entry.chapterId, entry.sequence]),
    )
    return chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      sourceId: chapter.sourceId,
      heading: chapter.heading,
      publishPath: chapter.publishPath,
      digest: chapter.digest,
      ...(indices.get(chapter.chapterId) === undefined ? {} : { sequence: indices.get(chapter.chapterId) }),
      createdAtMs: chapter.createdAtMs,
    }))
  }

  public async read(projectId: ProjectId, chapterId: string) {
    const chapter = await this.requireCurrentChapter(projectId, chapterId)
    const content = await this.dependencies.internalStore.readDocument(chapter.contentRef)
    return {
      chapterId: chapter.chapterId,
      sourceId: chapter.sourceId,
      heading: chapter.heading,
      publishPath: chapter.publishPath,
      digest: chapter.digest,
      createdAtMs: chapter.createdAtMs,
      content,
      body: readChapterBody(chapter.heading, content),
    }
  }

  public async readRevision(revisionTaskId: string): Promise<ChapterRevisionReadResult> {
    const revision = await this.requireRevision(revisionTaskId)
    const proposedContent = await this.dependencies.internalStore.readDocument(revision.contentRef)
    return {
      ...toPublicRevision(revision),
      proposedContent,
      proposedBody: readChapterBody(revision.heading, proposedContent),
    }
  }

  public async findActiveRevision(projectId: ProjectId, chapterId: string): Promise<ChapterRevisionReadResult | undefined> {
    await this.requireCurrentChapter(projectId, chapterId)
    const revision = await this.dependencies.revisions.findActiveForChapter(projectId, chapterId)
    if (revision === undefined) return undefined
    const proposedContent = await this.dependencies.internalStore.readDocument(revision.contentRef)
    return {
      ...toPublicRevision(revision),
      proposedContent,
      proposedBody: readChapterBody(revision.heading, proposedContent),
    }
  }

  public async start(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterId: string
    baseSourceId: string
    heading: string
    body: string
    inputMode?: "direct" | "agent"
  }>): Promise<ChapterRevision> {
    const current = await this.requireCurrentChapter(input.projectId, input.chapterId)
    if (current.sourceId !== input.baseSourceId) {
      throw new RevisionConflictError("The chapter changed while it was being edited")
    }
    const existing = await this.dependencies.revisions.findActive(input.projectId, input.chapterId, input.baseSourceId)
    if (existing !== undefined) return toPublicRevision(existing)

    const revisionTaskId = this.dependencies.createId()
    const scopeId = this.dependencies.createId()
    const turnId = this.dependencies.createId()
    const proposedSourceId = await this.dependencies.idAllocator.next(input.projectId, "source")
    const baseContent = await this.dependencies.internalStore.readDocument(current.contentRef)
    const heading = normalizeChapterHeading(input.heading)
    const content = assembleChapterDocument(heading, input.body)
    const contentRef = await this.dependencies.internalStore.writeImmutableDocument(
      this.dependencies.internalProjectStore,
      proposedSourceId,
      content,
    )
    const nowMs = this.dependencies.now()
    await this.dependencies.taskScopes.create({
      projectId: input.projectId,
      taskId: revisionTaskId,
      turnId,
      scopeId,
      kind: "revision",
      status: "created",
      reason: "chapter_revision_content",
      configSnapshot: { chapterId: input.chapterId, baseSourceId: input.baseSourceId },
      promptSnapshot: { workflow: "revision" },
      createdAtMs: nowMs,
    })
    const record: StoredChapterRevision = {
      revisionTaskId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      baseSourceId: input.baseSourceId,
      proposedSourceId,
      predecessorSourceId: current.sourceId,
      heading,
      contentDigest: digest(content),
      inputMode: input.inputMode ?? "direct",
      decision: "pending",
      graphSyncStatus: "not_started",
      status: "editing",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      contentRef,
      contentScopeId: scopeId,
      baseContentDigest: digest(baseContent),
    }
    await this.dependencies.revisions.create(record)
    return toPublicRevision(record)
  }

  public async update(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision> {
    const current = await this.requireRevision(revisionTaskId)
    assertEditable(current)
    const base = await this.dependencies.documents.findStoredVersion(current.projectId, current.baseSourceId)
    if (base === undefined) throw new ChapterNotFoundError(current.chapterId)
    const normalizedHeading = normalizeChapterHeading(heading)
    const normalizedContent = assembleChapterDocument(normalizedHeading, body)
    await this.dependencies.commit.resetPending(current.contentScopeId)
    const proposedSourceId = await this.dependencies.idAllocator.next(current.projectId, "source")
    const contentRef = await this.dependencies.internalStore.writeImmutableDocument(
      this.dependencies.internalProjectStore,
      proposedSourceId,
      normalizedContent,
    )
    return toPublicRevision(await this.dependencies.revisions.updateProposed({
      revisionTaskId,
      proposedSourceId,
      heading: normalizedHeading,
      contentRef,
      contentDigest: digest(normalizedContent),
      predecessorSourceId: current.proposedSourceId,
      updatedAtMs: this.dependencies.now(),
    }))
  }

  public async saveReview(review: ChapterRevisionReview): Promise<ChapterRevision> {
    const current = await this.requireRevision(review.revisionTaskId)
    if (current.proposedSourceId !== review.proposedSourceId || current.contentDigest !== review.contentDigest) {
      throw new RevisionConflictError("The review does not match the current proposed chapter")
    }
    return toPublicRevision(await this.dependencies.revisions.saveReview(review))
  }

  public async review(input: Readonly<{
    revisionTaskId: string
    maxModelCalls?: number
    deadlineMs?: number
  }>, model: AIModelPort): Promise<ChapterRevision> {
    const revision = await this.requireRevision(input.revisionTaskId)
    if (revision.status === "completed" || revision.status === "retired" || isContentCommitState(revision.status)) {
      throw new RevisionInvalidStateError(`Revision cannot be reviewed in state: ${revision.status}`)
    }
    const current = await this.requireCurrentChapter(revision.projectId, revision.chapterId)
    if (current.sourceId !== revision.baseSourceId) {
      throw new RevisionConflictError("The chapter has a newer committed version")
    }
    const currentContent = await this.dependencies.internalStore.readDocument(current.contentRef)
    const proposedContent = await this.dependencies.internalStore.readDocument(revision.contentRef)
    const nowMs = this.dependencies.now()
    const phasePrompt = await this.dependencies.prompts.loadPhase("revision_review")
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "reviewing",
      updatedAtMs: nowMs,
    })
    const deadlineAtMs = nowMs + (input.deadlineMs ?? 600_000)
    const request = phaseRequestEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      envelopeId: this.dependencies.createId(),
      projectId: revision.projectId,
      taskId: revision.revisionTaskId,
      turnId: this.dependencies.createId(),
      contextId: this.dependencies.createId(),
      scopeId: revision.contentScopeId,
      phase: "revision_review",
      protocolVersion: PROTOCOL_VERSION,
      promptRef: phasePrompt.ref,
      promptDigest: phasePrompt.digest,
      contextViewRef: `chapter-revision:${revision.revisionTaskId}`,
      committedReadIds: [],
      visiblePendingIds: [],
      remainingBudget: createReviewBudget(input.maxModelCalls ?? 1, deadlineAtMs),
      input: {
        workflow: "revision",
        userInput: "审核用户编辑后的章节正文，并给出连续性建议。",
        chapterSequence: 0,
        allowWorkspaceChapterReads: false,
        sourceUnitIds: [],
        phaseRunIds: [],
        readEvidence: [],
        retrievalGaps: [],
        artifacts: {},
        revision: {
          chapterId: revision.chapterId,
          baseSourceId: revision.baseSourceId,
          proposedSourceId: revision.proposedSourceId,
          baseContent: currentContent,
          proposedContent,
        },
      },
    })
    try {
      const execution = await model.execute(request)
      const artifact = revisionReviewArtifactSchema.parse(execution.result.artifact)
      const review: ChapterRevisionReview = {
        reviewId: this.dependencies.createId(),
        revisionTaskId: revision.revisionTaskId,
        proposedSourceId: revision.proposedSourceId,
        contentDigest: revision.contentDigest,
        issues: artifact.issues,
        recommendation: artifact.recommendation,
        createdAtMs: this.dependencies.now(),
      }
      return toPublicRevision(await this.dependencies.revisions.saveReview(review))
    } catch (error) {
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: "awaiting_user_decision",
        updatedAtMs: this.dependencies.now(),
      })
      throw error
    }
  }

  public async submit(input: Readonly<{
    revisionTaskId: string
    workspaceRootRef: string
    mode: "direct" | "reviewed"
    forced: boolean
    reviewId?: string
    note?: string
    model?: AIModelPort
  }>): Promise<ChapterRevision> {
    const revision = await this.requireRevision(input.revisionTaskId)
    if (isFinalized(revision)) return toPublicRevision(revision)
    const canResume = revision.decision === "submit"
      && (isContentCommitState(revision.status) || revision.graphSyncStatus === "failed")
    if (!canResume) assertEditable(revision)
    const current = await this.requireCurrentChapter(revision.projectId, revision.chapterId)
    const base = await this.dependencies.documents.findStoredVersion(revision.projectId, revision.baseSourceId)
    if (base === undefined) throw new ChapterNotFoundError(revision.chapterId)
    if (!canResume && !isContentCommitState(revision.status) && current.sourceId !== revision.baseSourceId) {
      throw new RevisionConflictError("The chapter has a newer committed version")
    }
    const review = revision.review
    if (input.mode === "reviewed" && (review === undefined || review.reviewId !== input.reviewId)) {
      throw new RevisionConflictError("Reviewed submission requires a review for the current proposed version")
    }
    if (input.mode === "direct" && !input.forced) {
      throw new RevisionConflictError("Direct submission must be recorded as a user-forced edit")
    }
    let withDecision = revision
    if (revision.decision !== "submit") {
      const reason = chapterRevisionDecisionReasonSchema.parse(input.forced ? "user_forced_edit" : "user_reviewed_edit")
      const decision: ChapterRevisionDecision = {
        decisionId: this.dependencies.createId(),
        revisionTaskId: revision.revisionTaskId,
        proposedSourceId: revision.proposedSourceId,
        contentDigest: revision.contentDigest,
        mode: input.mode,
        action: "submit",
        forced: input.forced,
        reason,
        ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
        ...(input.note === undefined ? {} : { note: input.note }),
        createdAtMs: this.dependencies.now(),
      }
      withDecision = await this.dependencies.revisions.saveDecision(decision)
    }
    await this.ensureFinalization(withDecision)
    const heading = revision.heading
    await this.commitContent(
      revision,
      input.workspaceRootRef,
      base.publishPath,
      deriveChapterPublishPath(heading),
      heading,
      base.digest,
    )
    const committedRevision = await this.requireRevision(input.revisionTaskId)
    if (committedRevision.status === "graph_sync_pending") {
      await this.dependencies.revisions.updateFinalization({
        revisionTaskId: committedRevision.revisionTaskId,
        status: "graph_sync_pending",
        updatedAtMs: this.dependencies.now(),
      })
    }
    await this.registerChapterRevisionContextIfNeeded(committedRevision)
    if (input.model !== undefined && this.shouldRunGraphSync(committedRevision)) {
      const graphSyncTaskId = committedRevision.graphSyncTaskId ?? this.dependencies.createId()
      const sourceUnits = await this.dependencies.documents.listSourceUnits(
        committedRevision.projectId,
        committedRevision.proposedSourceId,
      )
      await this.dependencies.revisions.updateState({
        revisionTaskId: committedRevision.revisionTaskId,
        status: "graph_sync_running",
        graphSyncStatus: "running",
        graphSyncTaskId,
        updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateFinalization({
        revisionTaskId: committedRevision.revisionTaskId,
        status: "graph_sync_running",
        graphSyncTaskId,
        updatedAtMs: this.dependencies.now(),
      })
      try {
        await this.dependencies.runGraphSync({
          revision: committedRevision,
          workspaceRootRef: input.workspaceRootRef,
          sourceUnitIds: sourceUnits.map((unit) => unit.id),
          model: input.model,
          graphSyncTaskId,
        })
        await this.dependencies.revisions.updateState({
          revisionTaskId: committedRevision.revisionTaskId,
          status: "completed",
          graphSyncStatus: "completed",
          updatedAtMs: this.dependencies.now(),
        })
        await this.dependencies.revisions.updateFinalization({
          revisionTaskId: committedRevision.revisionTaskId,
          status: "completed",
          updatedAtMs: this.dependencies.now(),
        })
      } catch (error) {
        await this.dependencies.revisions.updateState({
          revisionTaskId: committedRevision.revisionTaskId,
          status: "awaiting_user_decision",
          graphSyncStatus: "failed",
          updatedAtMs: this.dependencies.now(),
        })
        await this.dependencies.revisions.updateFinalization({
          revisionTaskId: committedRevision.revisionTaskId,
          status: "graph_sync_pending",
          updatedAtMs: this.dependencies.now(),
        })
        throw error
      }
    }
    const committed = await this.dependencies.revisions.find(input.revisionTaskId)
    return committed === undefined ? toPublicRevision(withDecision) : toPublicRevision(committed)
  }

  public async retire(revisionTaskId: string): Promise<ChapterRevision> {
    const revision = await this.requireRevision(revisionTaskId)
    if (revision.status === "completed" || revision.status === "retired") return toPublicRevision(revision)
    if (revision.status === "editing" || revision.status === "ready_to_submit") {
      await this.dependencies.commit.retire(revision.contentScopeId, this.dependencies.now())
    }
    return toPublicRevision(await this.dependencies.revisions.updateState({
      revisionTaskId,
      status: "retired",
      decision: "abandon",
      updatedAtMs: this.dependencies.now(),
    }))
  }

  public async completeGraphSync(graphSyncTaskId: string): Promise<ChapterRevision | undefined> {
    const revision = await this.dependencies.revisions.findByGraphSyncTaskId(graphSyncTaskId)
    if (revision === undefined) return undefined
    const completed = await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "completed",
      graphSyncStatus: "completed",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId,
      status: "completed",
      updatedAtMs: this.dependencies.now(),
    })
    return toPublicRevision(completed)
  }

  private async ensureFinalization(revision: StoredChapterRevision) {
    return revision.finalization ?? this.dependencies.revisions.createFinalization({
      finalizationId: this.dependencies.createId(),
      revisionTaskId: revision.revisionTaskId,
      projectId: revision.projectId,
      proposedSourceId: revision.proposedSourceId,
      contentScopeId: revision.contentScopeId,
      contentDigest: revision.contentDigest,
      createdAtMs: this.dependencies.now(),
    })
  }

  private async commitContent(
    revision: StoredChapterRevision,
    workspaceRootRef: string,
    currentPublishPath: string,
    nextPublishPath: string,
    heading: string,
    expectedBaseDigest: string,
  ): Promise<void> {
    const existing = await this.dependencies.revisions.find(revision.revisionTaskId)
    if (existing === undefined) throw new RevisionNotFoundError(revision.revisionTaskId)
    if (existing.status === "graph_sync_pending" || existing.status === "graph_sync_running") return
    if (existing.graphSyncStatus === "failed") {
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: "graph_sync_pending",
        graphSyncStatus: "pending",
        updatedAtMs: this.dependencies.now(),
      })
      return
    }
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "committing_content",
      updatedAtMs: this.dependencies.now(),
    })
    const content = await this.dependencies.internalStore.readDocument(revision.contentRef)
    if (isContentCommitState(existing.status)) {
      await this.dependencies.workspace.replacePublishedChapter(
        workspaceRootRef,
        currentPublishPath,
        nextPublishPath,
        revision.baseContentDigest || expectedBaseDigest,
        content,
      )
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: "chapter_published",
        graphSyncStatus: "pending",
        updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateFinalization({
        revisionTaskId: revision.revisionTaskId,
        status: "chapter_published",
        updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: "chapter_registered",
        graphSyncStatus: "pending",
        updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateFinalization({
        revisionTaskId: revision.revisionTaskId,
        status: "chapter_registered",
        updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: "graph_sync_pending",
        graphSyncStatus: "pending",
        updatedAtMs: this.dependencies.now(),
      })
      return
    }
    const units = splitSourceUnits(content)
    const sourceUnits = await Promise.all(units.map(async (unit, sequence) => {
      const unitId = this.dependencies.createId()
      const unitContentRef = await this.dependencies.internalStore.writeImmutableDocument(
        this.dependencies.internalProjectStore,
        unitId,
        unit,
      )
      return {
        id: unitId,
        projectId: revision.projectId,
        sourceId: revision.proposedSourceId,
        sequence,
        contentRef: unitContentRef,
        digest: digest(unit),
        createdAtMs: this.dependencies.now(),
      }
    }))
    await this.dependencies.documents.stageSourceUnits(sourceUnits)
    for (const [index, unit] of sourceUnits.entries()) {
      const unitContent = units[index]
      if (unitContent === undefined) continue
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId: revision.projectId,
        scopeId: revision.contentScopeId,
        ownerKind: "source",
        ownerId: unit.id,
        ownerRevisionId: unit.id,
        exactKeys: buildSourceUnitExactKeys(unitContent),
        semanticText: unitContent,
        sourceRefs: [{ sourceId: revision.proposedSourceId, sourceUnitId: unit.id, sequence: unit.sequence }],
        digest: unit.digest,
      })
    }
    await this.dependencies.documents.stageVersion({
      id: this.dependencies.createId(),
      projectId: revision.projectId,
      scopeId: revision.contentScopeId,
      sourceId: revision.proposedSourceId,
      chapterId: revision.chapterId,
      contentRef: revision.contentRef,
      heading,
      publishPath: nextPublishPath,
      digest: revision.contentDigest,
      predecessorSourceId: revision.baseSourceId,
      createdAtMs: this.dependencies.now(),
    })
    await this.dependencies.commit.commit(revision.contentScopeId)
    const priorChapterSourceIds = (await this.dependencies.chapterIndex.list(revision.projectId))
      .filter((entry) => entry.chapterId !== revision.chapterId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.currentSourceId)
    const existingIndex = await this.dependencies.chapterIndex.find(revision.projectId, revision.chapterId)
    if (existingIndex === undefined) {
      await this.dependencies.chapterIndex.assignOnFirstCommit({
        projectId: revision.projectId,
        chapterId: revision.chapterId,
        sequence: await this.dependencies.chapterIndex.nextSequence(revision.projectId),
        currentSourceId: revision.proposedSourceId,
        currentPublishPath: nextPublishPath,
        assignedAtMs: this.dependencies.now(),
      })
    } else {
      await this.dependencies.chapterIndex.updateCurrent({
        projectId: revision.projectId,
        chapterId: revision.chapterId,
        currentSourceId: revision.proposedSourceId,
        currentPublishPath: nextPublishPath,
      })
    }
    await this.dependencies.recordLineageSnapshot({
      projectId: revision.projectId,
      chapterId: revision.chapterId,
      sourceId: revision.proposedSourceId,
      priorChapterSourceIds,
    })
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "content_committed",
      graphSyncStatus: "pending",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId,
      status: "content_committed",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.workspace.replacePublishedChapter(
      workspaceRootRef,
      currentPublishPath,
      nextPublishPath,
      revision.baseContentDigest || expectedBaseDigest,
      content,
    )
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "chapter_published",
      graphSyncStatus: "pending",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId,
      status: "chapter_published",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "chapter_registered",
      graphSyncStatus: "pending",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId,
      status: "chapter_registered",
      updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId,
      status: "graph_sync_pending",
      graphSyncStatus: "pending",
      updatedAtMs: this.dependencies.now(),
    })
  }

  private async registerChapterRevisionContextIfNeeded(revision: StoredChapterRevision): Promise<void> {
    if (revision.decision !== "submit") return
    if (!shouldHaveChapterRevisionContext(revision.status)) return
    await this.dependencies.appendChapterRevisionContext({
      revision,
      contentRef: revision.contentRef,
      contentDigest: revision.contentDigest,
      contentTokenEstimate: estimateTokenCount(await this.dependencies.internalStore.readDocument(revision.contentRef)),
    })
  }

  private shouldRunGraphSync(revision: StoredChapterRevision): boolean {
    return revision.status === "graph_sync_pending"
      || (revision.status === "awaiting_user_decision" && revision.graphSyncStatus === "failed")
  }

  private async requireCurrentChapter(projectId: ProjectId, chapterId: string) {
    const chapter = await this.dependencies.documents.findCurrentChapter(projectId, chapterId)
    if (chapter === undefined) throw new ChapterNotFoundError(chapterId)
    return chapter
  }

  private async requireRevision(revisionTaskId: string): Promise<StoredChapterRevision> {
    const revision = await this.dependencies.revisions.find(revisionTaskId)
    if (revision === undefined) throw new RevisionNotFoundError(revisionTaskId)
    return revision
  }
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function toPublicRevision(record: StoredChapterRevision): ChapterRevision {
  return {
    revisionTaskId: record.revisionTaskId,
    projectId: record.projectId,
    chapterId: record.chapterId,
    baseSourceId: record.baseSourceId,
    proposedSourceId: record.proposedSourceId,
    ...(record.predecessorSourceId === undefined ? {} : { predecessorSourceId: record.predecessorSourceId }),
    heading: record.heading,
    contentDigest: record.contentDigest,
    ...(record.inputMode === undefined ? {} : { inputMode: record.inputMode }),
    ...(record.submissionMode === undefined ? {} : { submissionMode: record.submissionMode }),
    decision: record.decision,
    ...(record.review === undefined ? {} : { review: record.review }),
    graphSyncStatus: record.graphSyncStatus,
    ...(record.graphSyncTaskId === undefined ? {} : { graphSyncTaskId: record.graphSyncTaskId }),
    ...(record.finalization === undefined ? {} : { finalization: record.finalization }),
    status: record.status,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  }
}

function assertEditable(record: StoredChapterRevision): void {
  const parsed = chapterRevisionStatusSchema.parse(record.status)
  if (parsed !== "editing" && parsed !== "ready_to_submit" && parsed !== "awaiting_user_decision") {
    throw new RevisionInvalidStateError(`Revision cannot be changed in state: ${parsed}`)
  }
}

function shouldHaveChapterRevisionContext(status: ChapterRevision["status"]): boolean {
  return isContentCommitState(status)
    || status === "completed"
    || status === "awaiting_user_decision"
}

function isContentCommitState(status: ChapterRevision["status"]): boolean {
  return status === "content_committed"
    || status === "chapter_published"
    || status === "chapter_registered"
    || status === "graph_sync_pending"
    || status === "graph_sync_running"
}

function isFinalized(record: StoredChapterRevision): boolean {
  return record.status === "completed"
}

function createReviewBudget(maxCalls: number, deadlineAtMs: number) {
  const safeCalls = Math.max(1, maxCalls)
  return {
    maxCalls: safeCalls,
    remainingCalls: safeCalls,
    maxInputTokens: 1_000_000,
    remainingInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
    remainingOutputTokens: 64_000,
    deadlineAtMs,
    modelRequestDeadlineAtMs: deadlineAtMs,
  }
}

function splitSourceUnits(content: string): string[] {
  const normalized = content.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) return [content]
  return normalized.split(/\n{2,}/u).map((unit) => unit.trim()).filter((unit) => unit.length > 0)
}

export class ChapterNotFoundError extends Error {
  public readonly code = "chapter_not_found" as const
}

export class RevisionNotFoundError extends Error {
  public readonly code = "revision_not_found" as const
}

export class RevisionConflictError extends Error {
  public readonly code = "revision_conflict" as const
}

export class RevisionInvalidStateError extends Error {
  public readonly code = "revision_invalid_state" as const
}
