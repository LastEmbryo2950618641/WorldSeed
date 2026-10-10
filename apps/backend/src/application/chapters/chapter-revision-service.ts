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
  type RevisionDraftVersion,
  type RevisionDraftVersionListResult,
  type RevisionDraftVersionSource,
} from "@worldseed/contracts"

import {
  assembleChapterDocument,
  DEFAULT_VOLUME_FOLDER_NAME,
  deriveChapterPublishPath,
  digest,
  extractVolumeFolderNameFromPath,
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
import type { SqliteRevisionDraftVersionRepository } from "../../infrastructure/sqlite/repositories/sqlite-revision-draft-version-repository.js"

export type ChapterRevisionServiceDependencies = Readonly<{
  workspaceRootRef?: string
  taskScopes: TaskScopeRepository
  documents: DocumentRepository
  retrieval: RetrievalRepository
  commit: ScopeCommitRepository
  revisions: ChapterRevisionRepository
  draftVersions: SqliteRevisionDraftVersionRepository
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
    signal?: AbortSignal
  }>): Promise<void>
}>

export class ChapterRevisionService {
  private static readonly publications = new Map<string, Promise<ChapterRevision>>()

  public constructor(private readonly dependencies: ChapterRevisionServiceDependencies) {}

  public async listUnpublished(projectId: ProjectId): Promise<readonly ChapterRevisionReadResult[]> {
    const revisions = await this.dependencies.revisions.listUnpublished(projectId)
    const official = new Set((await this.dependencies.documents.listCommittedChapters(projectId)).map((chapter) => chapter.chapterId))
    return Promise.all(revisions.filter((revision) => !official.has(revision.chapterId)).map((revision) => this.toRevisionReadResult(revision)))
  }

  public async getDraftWorkspace(input: Readonly<{
    projectId: ProjectId
    chapterSequence?: number
    revisionTaskId?: string
  }>): Promise<ChapterRevisionReadResult | undefined> {
    if (input.revisionTaskId !== undefined) {
      const revision = await this.requireRevision(input.revisionTaskId)
      if (revision.projectId !== input.projectId) throw new RevisionNotFoundError(input.revisionTaskId)
      if (input.chapterSequence !== undefined && revision.chapterSequence !== input.chapterSequence) {
        throw new RevisionConflictError("Revision belongs to a different chapter sequence")
      }
      return this.toRevisionReadResult(revision)
    }
    if (input.chapterSequence === undefined) throw new RevisionInvalidStateError("A chapter sequence or revision task ID is required")
    const unpublished = (await this.listUnpublished(input.projectId)).find((revision) => revision.chapterSequence === input.chapterSequence)
    if (unpublished !== undefined) return unpublished
    const index = (await this.dependencies.chapterIndex.list(input.projectId)).find((chapter) => chapter.sequence === input.chapterSequence)
    return index === undefined ? undefined : this.findDisplayRevision(input.projectId, index.chapterId)
  }

  public async startForChapterSequence(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterSequence: number
    heading: string
    body: string
    volumeFolderName?: string
    source: "agent" | "manual" | "workflow"
    messageId?: string
  }>): Promise<RevisionDraftVersion> {
    if (!Number.isSafeInteger(input.chapterSequence) || input.chapterSequence < 1) {
      throw new RevisionInvalidStateError("Chapter sequence must be a positive integer")
    }
    if (input.chapterSequence > await this.dependencies.chapterIndex.nextSequence(input.projectId)) {
      throw new RevisionInvalidStateError("Publish the preceding chapter before drafting the next chapter")
    }
    const index = (await this.dependencies.chapterIndex.list(input.projectId)).find((chapter) => chapter.sequence === input.chapterSequence)
    let revision: ChapterRevision | undefined
    if (index !== undefined) {
      revision = await this.start({
        ...input, chapterId: index.chapterId, baseSourceId: index.currentSourceId,
        inputMode: input.source === "manual" ? "direct" : "agent",
      })
    } else {
      revision = (await this.dependencies.revisions.listUnpublished(input.projectId))
        .find((draft) => draft.chapterSequence === input.chapterSequence)
    }
    if (revision === undefined) {
      const revisionTaskId = this.dependencies.createId()
      const scopeId = this.dependencies.createId()
      const proposedSourceId = await this.dependencies.idAllocator.next(input.projectId, "source")
      const heading = normalizeChapterHeading(input.heading)
      const content = assembleChapterDocument(heading, input.body)
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(this.dependencies.internalProjectStore, proposedSourceId, content)
      const nowMs = this.dependencies.now()
      const chapterId = this.dependencies.createId()
      await this.dependencies.taskScopes.create({
        projectId: input.projectId, taskId: revisionTaskId, turnId: this.dependencies.createId(), scopeId,
        kind: "revision", status: "created", reason: "chapter_revision_content",
        configSnapshot: { chapterId, chapterSequence: input.chapterSequence, workspaceRootRef: input.workspaceRootRef },
        promptSnapshot: { workflow: "revision" }, createdAtMs: nowMs,
      })
      const record: StoredChapterRevision = {
        revisionTaskId, projectId: input.projectId, chapterId, chapterSequence: input.chapterSequence,
        publishPath: deriveChapterPublishPath(heading, input.volumeFolderName ?? DEFAULT_VOLUME_FOLDER_NAME), isInitialPublication: true,
        // This is a draft-chain anchor, never a fabricated official document.
        baseSourceId: proposedSourceId, proposedSourceId, heading, contentDigest: digest(content),
        inputMode: input.source === "manual" ? "direct" : "agent", decision: "pending",
        graphSyncStatus: "not_started", status: "editing", createdAtMs: nowMs, updatedAtMs: nowMs,
        contentRef, contentScopeId: scopeId, baseContentDigest: "",
      }
      await this.dependencies.revisions.create(record)
      return this.dependencies.draftVersions.append({
        versionId: this.dependencies.createId(), projectId: input.projectId, revisionTaskId,
        source: input.source, ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        heading, body: input.body, createdAtMs: nowMs,
      })
    }
    return this.appendDraftVersion({
      revisionTaskId: revision.revisionTaskId, source: input.source, heading: input.heading, body: input.body,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    })
  }

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
    return this.toRevisionReadResult(await this.requireRevision(revisionTaskId))
  }

  public async findActiveRevision(projectId: ProjectId, chapterId: string): Promise<ChapterRevisionReadResult | undefined> {
    await this.requireCurrentChapter(projectId, chapterId)
    const revision = await this.dependencies.revisions.findActiveForChapter(projectId, chapterId)
    if (revision === undefined) return undefined
    return this.toRevisionReadResult(revision)
  }

  public async findLatestRevision(projectId: ProjectId, chapterId: string): Promise<ChapterRevisionReadResult | undefined> {
    await this.requireCurrentChapter(projectId, chapterId)
    const revision = await this.dependencies.revisions.findLatestForChapter(projectId, chapterId)
    if (revision === undefined) return undefined
    return this.toRevisionReadResult(revision)
  }

  public async findDisplayRevision(projectId: ProjectId, chapterId: string): Promise<ChapterRevisionReadResult | undefined> {
    await this.requireCurrentChapter(projectId, chapterId)
    const inflight = await this.dependencies.revisions.findActiveForChapter(projectId, chapterId)
    if (inflight === undefined) {
      const latest = await this.dependencies.revisions.findLatestForChapter(projectId, chapterId)
      return latest === undefined ? undefined : this.toRevisionReadResult(latest)
    }
    const inflightDrafts = await this.dependencies.draftVersions.list(inflight.revisionTaskId)
    if (inflightDrafts.some((version) => version.source !== "baseline")) {
      return this.toRevisionReadResult(inflight)
    }
    const previous = await this.dependencies.revisions.findLatestForChapter(
      projectId,
      chapterId,
      inflight.revisionTaskId,
    )
    if (previous !== undefined) {
      const previousDrafts = await this.dependencies.draftVersions.list(previous.revisionTaskId)
      if (previousDrafts.some((version) => version.source !== "baseline")) {
        return this.toRevisionReadResult(previous)
      }
    }
    return this.toRevisionReadResult(inflight)
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
    const inflight = await this.dependencies.revisions.findActiveForChapter(input.projectId, input.chapterId)
    if (inflight !== undefined) {
      await this.ensureBaselineDraft(inflight.revisionTaskId)
      return toPublicRevision(inflight)
    }
    if (current.sourceId !== input.baseSourceId) {
      throw new RevisionConflictError("The chapter changed while it was being edited")
    }

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
      configSnapshot: { chapterId: input.chapterId, baseSourceId: input.baseSourceId, workspaceRootRef: input.workspaceRootRef },
      promptSnapshot: { workflow: "revision" },
      createdAtMs: nowMs,
    })
    const record: StoredChapterRevision = {
      revisionTaskId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterSequence: (await this.dependencies.chapterIndex.find(input.projectId, input.chapterId))?.sequence,
      publishPath: deriveChapterPublishPath(heading, extractVolumeFolderNameFromPath(current.publishPath) ?? DEFAULT_VOLUME_FOLDER_NAME),
      isInitialPublication: false,
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
    await this.ensureBaselineDraft(revisionTaskId)
    return toPublicRevision(record)
  }

  public async listDraftVersions(
    revisionTaskId: string,
    options?: Readonly<{ includeChapterHistory?: boolean }>,
  ): Promise<RevisionDraftVersionListResult> {
    const revision = await this.requireRevision(revisionTaskId)
    await this.ensureBaselineDraft(revisionTaskId)
    const current = await this.dependencies.documents.findCurrentChapter(revision.projectId, revision.chapterId)
    const currentBody = current === undefined ? undefined
      : readChapterBody(current.heading, await this.dependencies.internalStore.readDocument(current.contentRef))
    let versions: RevisionDraftVersion[]
    if (options?.includeChapterHistory === true) {
      const siblings = await this.dependencies.revisions.listForChapter(revision.projectId, revision.chapterId)
      const collected: RevisionDraftVersion[] = []
      for (const sibling of siblings) {
        collected.push(...await this.dependencies.draftVersions.list(sibling.revisionTaskId))
      }
      versions = collected
    } else {
      versions = [...await this.dependencies.draftVersions.list(revisionTaskId)]
    }
    return {
      revisionTaskId,
      versions: publishChapterDraftHistory(versions, currentBody),
    }
  }

  public async readDraftVersion(versionId: string): Promise<RevisionDraftVersion> {
    const version = await this.dependencies.draftVersions.find(versionId)
    if (version === undefined) throw new RevisionNotFoundError("Draft version not found")
    await this.requireRevision(version.revisionTaskId)
    return version
  }

  public async appendDraftVersion(input: Readonly<{
    revisionTaskId: string
    source: RevisionDraftVersionSource
    heading: string
    body: string
    parentVersionId?: string
    messageId?: string
  }>): Promise<RevisionDraftVersion> {
    if (input.source === "baseline") {
      throw new RevisionInvalidStateError("Baseline draft versions are created when the revision starts")
    }
    const revision = await this.requireRevision(input.revisionTaskId)
    assertEditable(revision)
    const listed = await this.ensureBaselineDraft(input.revisionTaskId)
    const parentVersionId = input.parentVersionId ?? listed.at(-1)?.versionId
    if (input.parentVersionId !== undefined) {
      const parent = listed.find((item) => item.versionId === input.parentVersionId)
      if (parent === undefined) throw new RevisionInvalidStateError("Parent draft version is not in this revision")
    }
    const stored = await this.dependencies.draftVersions.append({
      versionId: this.dependencies.createId(),
      projectId: revision.projectId,
      revisionTaskId: input.revisionTaskId,
      ...(parentVersionId === undefined ? {} : { parentVersionId }),
      source: input.source,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      heading: normalizeChapterHeading(input.heading),
      body: input.body,
      createdAtMs: this.dependencies.now(),
    })
    await this.update(input.revisionTaskId, stored.heading, stored.body)
    return (await this.dependencies.draftVersions.find(stored.versionId)) ?? stored
  }

  public async restoreDraftVersion(revisionTaskId: string, versionId: string): Promise<RevisionDraftVersion> {
    const version = await this.readDraftVersion(versionId)
    if (version.revisionTaskId !== revisionTaskId) {
      throw new RevisionInvalidStateError("Draft version does not belong to this revision")
    }
    return this.appendDraftVersion({
      revisionTaskId,
      source: "rollback",
      heading: version.heading,
      body: version.body,
    })
  }

  private async ensureBaselineDraft(revisionTaskId: string): Promise<readonly RevisionDraftVersion[]> {
    const listed = await this.dependencies.draftVersions.list(revisionTaskId)
    if (listed.length > 0) return listed
    const revision = await this.requireRevision(revisionTaskId)
    if (revision.isInitialPublication === true) return listed
    const detail = await this.readRevision(revisionTaskId)
    await this.dependencies.draftVersions.append({
      versionId: this.dependencies.createId(),
      projectId: revision.projectId,
      revisionTaskId,
      source: "baseline",
      heading: revision.heading,
      body: detail.proposedBody,
      createdAtMs: revision.createdAtMs,
    })
    return this.dependencies.draftVersions.list(revisionTaskId)
  }

  public async updateDraftVersion(revisionTaskId: string, versionId: string, heading: string, body: string): Promise<ChapterRevision> {
    const versions = await this.dependencies.draftVersions.list(revisionTaskId)
    const selected = versions.find((version) => version.versionId === versionId)
    if (selected === undefined || !selected.isLatest || selected.source === "baseline") {
      throw new RevisionConflictError("Only the current working draft can be edited; refresh the chapter first")
    }
    const revision = await this.update(revisionTaskId, heading, body)
    await this.dependencies.draftVersions.update(versionId, revision.heading, body)
    return revision
  }

  public async update(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision> {
    const current = await this.requireRevision(revisionTaskId)
    assertEditable(current)
    const graphTask = current.graphSyncTaskId === undefined ? undefined : await this.dependencies.taskScopes.findTask(current.graphSyncTaskId)
    if (graphTask?.status === "completed") throw new RevisionInvalidStateError("Finish publishing the synchronized revision before editing")
    const base = current.isInitialPublication === true ? undefined
      : await this.dependencies.documents.findStoredVersion(current.projectId, current.baseSourceId)
    if (base === undefined && current.isInitialPublication !== true) throw new ChapterNotFoundError(current.chapterId)
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
      publishPath: deriveChapterPublishPath(normalizedHeading,
        extractVolumeFolderNameFromPath(current.publishPath ?? base?.publishPath ?? "") ?? DEFAULT_VOLUME_FOLDER_NAME),
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
    const current = await this.dependencies.documents.findCurrentChapter(revision.projectId, revision.chapterId)
    if (revision.isInitialPublication === true ? current !== undefined : current?.sourceId !== revision.baseSourceId) {
      throw new RevisionConflictError("The chapter has a newer committed version")
    }
    const currentContent = current === undefined ? "" : await this.dependencies.internalStore.readDocument(current.contentRef)
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
        chapterSequence: revision.chapterSequence ?? 0,
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
    draftVersionId?: string
    workspaceRootRef: string
    mode: "direct" | "reviewed"
    forced: boolean
    reviewId?: string
    note?: string
    model?: AIModelPort
    signal?: AbortSignal
  }>): Promise<ChapterRevision> {
    let revision = await this.requireRevision(input.revisionTaskId)
    if (input.draftVersionId !== undefined) {
      const draft = await this.readDraftVersion(input.draftVersionId)
      if (draft.revisionTaskId !== revision.revisionTaskId) throw new RevisionConflictError("Draft version belongs to a different revision")
      const content = assembleChapterDocument(draft.heading, draft.body)
      if (digest(content) !== revision.contentDigest) {
        await this.update(revision.revisionTaskId, draft.heading, draft.body)
        revision = await this.requireRevision(revision.revisionTaskId)
      }
    }
    if (isFinalized(revision)) return toPublicRevision(revision)
    const canResume = revision.decision === "submit"
      && (
        isContentCommitState(revision.status)
        || revision.status === "committing_content"
        || revision.graphSyncStatus === "failed"
      )
    if (!canResume) assertEditable(revision)
    await this.assertPublicationBase(revision)
    const review = revision.review
    if (input.mode === "reviewed" && (review === undefined || review.reviewId !== input.reviewId
      || review.proposedSourceId !== revision.proposedSourceId || review.contentDigest !== revision.contentDigest)) {
      throw new RevisionConflictError("Reviewed submission requires a review for the current proposed version")
    }
    if (input.mode === "direct" && !input.forced) {
      throw new RevisionConflictError("Direct submission must be recorded as a user-forced edit")
    }
    input.signal?.throwIfAborted()
    if (revision.decision !== "submit") {
      await this.validatePublication(revision, input.workspaceRootRef)
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
    const oldTask = revision.graphSyncTaskId === undefined ? undefined : await this.dependencies.taskScopes.findTask(revision.graphSyncTaskId)
    if (oldTask?.status === "completed") {
      return (await this.completeGraphSync(oldTask.taskId, input.workspaceRootRef))!
    }
    if (oldTask?.status === "running" || oldTask?.status === "committing") {
      throw new RevisionInvalidStateError("Graph synchronization is already running")
    }
    await this.stageContent(withDecision)
    const graphSyncTaskId = oldTask === undefined
      ? revision.graphSyncTaskId ?? this.dependencies.createId() : this.dependencies.createId()
    if (oldTask !== undefined) {
      const scope = await this.dependencies.taskScopes.findScope(oldTask.scopeId)
      if (scope?.visibility === "pending") await this.dependencies.commit.retire(scope.scopeId, this.dependencies.now())
    }
    const prepared = await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId, status: "graph_sync_pending", graphSyncStatus: "pending",
      graphSyncTaskId, updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId, status: "graph_sync_pending", graphSyncTaskId, updatedAtMs: this.dependencies.now(),
    })
    // Without a model this only queues pending content; it must never publish.
    if (input.model === undefined) return toPublicRevision(prepared)
    await this.dependencies.revisions.updateState({
      revisionTaskId: revision.revisionTaskId, status: "graph_sync_running", graphSyncStatus: "running", updatedAtMs: this.dependencies.now(),
    })
    await this.dependencies.revisions.updateFinalization({
      revisionTaskId: revision.revisionTaskId, status: "graph_sync_running", graphSyncTaskId, updatedAtMs: this.dependencies.now(),
    })
    try {
      input.signal?.throwIfAborted()
      const sourceUnits = await this.dependencies.documents.listSourceUnits(revision.projectId, revision.proposedSourceId)
      await this.dependencies.runGraphSync({
        revision: prepared, workspaceRootRef: input.workspaceRootRef, sourceUnitIds: sourceUnits.map((unit) => unit.id),
        model: input.model, graphSyncTaskId, ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      input.signal?.throwIfAborted()
      const task = await this.dependencies.taskScopes.findTask(graphSyncTaskId)
      if (task?.status !== "completed") throw new RevisionInvalidStateError("图同步尚未完成，请在图修订任务中重试")
    } catch (error) {
      const task = await this.dependencies.taskScopes.findTask(graphSyncTaskId)
      await this.dependencies.revisions.updateState({
        revisionTaskId: revision.revisionTaskId,
        status: task?.status === "completed" ? "committing_content" : "awaiting_user_decision",
        graphSyncStatus: task?.status === "completed" ? "running" : "failed", updatedAtMs: this.dependencies.now(),
      })
      await this.dependencies.revisions.updateFinalization({
        revisionTaskId: revision.revisionTaskId, status: "graph_sync_pending", updatedAtMs: this.dependencies.now(),
      })
      throw error
    }
    return (await this.completeGraphSync(graphSyncTaskId, input.workspaceRootRef))!
  }

  public async retire(revisionTaskId: string): Promise<ChapterRevision> {
    const revision = await this.requireRevision(revisionTaskId)
    if (revision.status === "completed" || revision.status === "retired") return toPublicRevision(revision)
    const graphTask = revision.graphSyncTaskId === undefined ? undefined : await this.dependencies.taskScopes.findTask(revision.graphSyncTaskId)
    if (graphTask?.status === "completed" || graphTask?.status === "committing" || graphTask?.status === "running"
      || revision.status === "graph_sync_running" || revision.status === "committing_content") {
      throw new RevisionInvalidStateError("Cancel graph synchronization or finish publication before retiring this revision")
    }
    const scope = await this.dependencies.taskScopes.findScope(revision.contentScopeId)
    if (scope?.visibility === "pending") {
      await this.dependencies.commit.retire(revision.contentScopeId, this.dependencies.now())
    }
    return toPublicRevision(await this.dependencies.revisions.updateState({
      revisionTaskId,
      status: "retired",
      decision: "abandon",
      updatedAtMs: this.dependencies.now(),
    }))
  }

  public async completeGraphSync(graphSyncTaskId: string, workspaceRootRef?: string): Promise<ChapterRevision | undefined> {
    const revision = await this.dependencies.revisions.findByGraphSyncTaskId(graphSyncTaskId)
    if (revision === undefined) return undefined
    if (revision.status === "completed") return toPublicRevision(revision)
    if (revision.decision !== "submit" || revision.status === "retired") return undefined
    const graphTask = await this.dependencies.taskScopes.findTask(graphSyncTaskId)
    if (graphTask?.status !== "completed") throw new RevisionInvalidStateError("Graph synchronization has not completed")
    const contentTask = await this.dependencies.taskScopes.findTask(revision.revisionTaskId)
    const config = contentTask?.configSnapshot
    const persistedRoot = typeof config === "object" && config !== null && "workspaceRootRef" in config
      && typeof config.workspaceRootRef === "string" ? config.workspaceRootRef : undefined
    const root = workspaceRootRef ?? this.dependencies.workspaceRootRef ?? persistedRoot
    if (root === undefined) throw new RevisionInvalidStateError("Workspace is required to finish chapter publication")
    const key = `${revision.projectId}:${revision.revisionTaskId}`
    const existing = ChapterRevisionService.publications.get(key)
    if (existing !== undefined) return existing
    const publication = this.finishPublication(revision.revisionTaskId, root)
    ChapterRevisionService.publications.set(key, publication)
    try {
      return await publication
    } finally {
      ChapterRevisionService.publications.delete(key)
    }
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

  private async assertPublicationBase(revision: StoredChapterRevision): Promise<void> {
    const current = await this.dependencies.documents.findCurrentChapter(revision.projectId, revision.chapterId)
    const scope = await this.dependencies.taskScopes.findScope(revision.contentScopeId)
    if (current?.sourceId === revision.proposedSourceId && scope?.visibility === "committed") return
    if (revision.isInitialPublication === true) {
      const occupied = (await this.dependencies.chapterIndex.list(revision.projectId))
        .some((entry) => entry.sequence === revision.chapterSequence && entry.chapterId !== revision.chapterId)
      if (current !== undefined || occupied) throw new RevisionConflictError("The chapter sequence already has an official chapter")
    } else if (current?.sourceId !== revision.baseSourceId) {
      throw new RevisionConflictError("The chapter has a newer committed version")
    }
  }

  private async publicationTarget(revision: StoredChapterRevision) {
    const base = revision.isInitialPublication === true ? undefined
      : await this.dependencies.documents.findStoredVersion(revision.projectId, revision.baseSourceId)
    if (base === undefined && revision.isInitialPublication !== true) throw new ChapterNotFoundError(revision.chapterId)
    const publishPath = revision.publishPath ?? deriveChapterPublishPath(revision.heading,
      extractVolumeFolderNameFromPath(base?.publishPath ?? "") ?? DEFAULT_VOLUME_FOLDER_NAME)
    return { base, publishPath }
  }

  private async validatePublication(revision: StoredChapterRevision, workspaceRootRef: string): Promise<void> {
    const { base, publishPath } = await this.publicationTarget(revision)
    const content = await this.dependencies.internalStore.readDocument(revision.contentRef)
    if (base !== undefined) {
      await this.dependencies.workspace.validatePublishedChapterReplacement(
        workspaceRootRef, base.publishPath, publishPath, revision.baseContentDigest || base.digest, content,
      )
    } else {
      let existing: string
      try {
        existing = await this.dependencies.workspace.readMarkdown(workspaceRootRef, publishPath)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return
        throw error
      }
      if (existing !== content) throw new RevisionConflictError("Chapter title conflicts with an existing file")
    }
  }

  private async stageContent(revision: StoredChapterRevision): Promise<void> {
    const scope = await this.dependencies.taskScopes.findScope(revision.contentScopeId)
    if (scope?.visibility === "committed") return
    if (scope?.visibility !== "pending") throw new RevisionInvalidStateError("Revision content scope is not pending")
    const stored = await this.dependencies.documents.findStoredVersion(revision.projectId, revision.proposedSourceId)
    // A pending/running graph marker is written only after all source references are staged.
    if (stored?.scopeId === revision.contentScopeId && revision.graphSyncStatus !== "not_started") return
    await this.dependencies.commit.resetPending(revision.contentScopeId, { sourceIds: [revision.proposedSourceId] })
    const { publishPath } = await this.publicationTarget(revision)
    const content = await this.dependencies.internalStore.readDocument(revision.contentRef)
    await this.dependencies.documents.stageVersion({
      id: this.dependencies.createId(), projectId: revision.projectId, scopeId: revision.contentScopeId,
      sourceId: revision.proposedSourceId, chapterId: revision.chapterId, contentRef: revision.contentRef,
      heading: revision.heading, publishPath, digest: revision.contentDigest,
      ...(revision.isInitialPublication === true ? {} : { predecessorSourceId: revision.baseSourceId }),
      createdAtMs: this.dependencies.now(),
    })
    const units = splitSourceUnits(content)
    const sourceUnits = await Promise.all(units.map(async (unit, sequence) => {
      const unitId = this.dependencies.createId()
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(
        this.dependencies.internalProjectStore, unitId, unit,
      )
      return {
        id: unitId, projectId: revision.projectId, sourceId: revision.proposedSourceId,
        sequence, contentRef, digest: digest(unit), createdAtMs: this.dependencies.now(),
      }
    }))
    await this.dependencies.documents.stageSourceUnits(sourceUnits)
    for (const [index, unit] of sourceUnits.entries()) {
      const unitContent = units[index]
      if (unitContent === undefined) continue
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(), projectId: revision.projectId, scopeId: revision.contentScopeId,
        ownerKind: "source", ownerId: unit.id, ownerRevisionId: unit.id,
        exactKeys: buildSourceUnitExactKeys(unitContent), semanticText: unitContent,
        sourceRefs: [{ sourceId: revision.proposedSourceId, sourceUnitId: unit.id, sequence: unit.sequence }],
        digest: unit.digest,
      })
    }
  }

  private async finishPublication(revisionTaskId: string, workspaceRootRef: string): Promise<ChapterRevision> {
    const revision = await this.requireRevision(revisionTaskId)
    if (revision.status === "completed") return toPublicRevision(revision)
    await this.assertPublicationBase(revision)
    await this.ensureFinalization(revision)
    await this.dependencies.revisions.updateState({
      revisionTaskId, status: "committing_content", graphSyncStatus: "running", updatedAtMs: this.dependencies.now(),
    })
    await this.validatePublication(revision, workspaceRootRef)
    const { base, publishPath } = await this.publicationTarget(revision)
    const content = await this.dependencies.internalStore.readDocument(revision.contentRef)
    const scope = await this.dependencies.taskScopes.findScope(revision.contentScopeId)
    if (scope?.visibility !== "committed") {
      const stored = await this.dependencies.documents.findStoredVersion(revision.projectId, revision.proposedSourceId)
      if (stored?.scopeId !== revision.contentScopeId || stored.digest !== revision.contentDigest) {
        throw new RevisionInvalidStateError("Synchronized chapter content is missing from its pending scope")
      }
      await this.dependencies.commit.commit(revision.contentScopeId)
    }
    await this.dependencies.revisions.updateState({ revisionTaskId, status: "content_committed", updatedAtMs: this.dependencies.now() })
    await this.dependencies.revisions.updateFinalization({ revisionTaskId, status: "content_committed", updatedAtMs: this.dependencies.now() })
    if (base === undefined) {
      await this.dependencies.workspace.publishChapter(workspaceRootRef, publishPath, content)
    } else {
      await this.dependencies.workspace.replacePublishedChapter(
        workspaceRootRef, base.publishPath, publishPath, revision.baseContentDigest || base.digest, content,
      )
    }
    await this.dependencies.revisions.updateState({ revisionTaskId, status: "chapter_published", updatedAtMs: this.dependencies.now() })
    await this.dependencies.revisions.updateFinalization({ revisionTaskId, status: "chapter_published", updatedAtMs: this.dependencies.now() })
    const indices = await this.dependencies.chapterIndex.list(revision.projectId)
    const existingIndex = indices.find((entry) => entry.chapterId === revision.chapterId)
    const sequence = revision.chapterSequence ?? existingIndex?.sequence ?? await this.dependencies.chapterIndex.nextSequence(revision.projectId)
    if (existingIndex === undefined) {
      await this.dependencies.chapterIndex.assignOnFirstCommit({
        projectId: revision.projectId, chapterId: revision.chapterId, sequence,
        currentSourceId: revision.proposedSourceId, currentPublishPath: publishPath, assignedAtMs: this.dependencies.now(),
      })
    } else {
      await this.dependencies.chapterIndex.updateCurrent({
        projectId: revision.projectId, chapterId: revision.chapterId,
        currentSourceId: revision.proposedSourceId, currentPublishPath: publishPath,
      })
    }
    await this.dependencies.recordLineageSnapshot({
      projectId: revision.projectId, chapterId: revision.chapterId, sourceId: revision.proposedSourceId,
      priorChapterSourceIds: indices.filter((entry) => entry.sequence < sequence)
        .sort((left, right) => left.sequence - right.sequence).map((entry) => entry.currentSourceId),
    })
    await this.dependencies.appendChapterRevisionContext({
      revision, contentRef: revision.contentRef, contentDigest: revision.contentDigest,
      contentTokenEstimate: estimateTokenCount(content),
    })
    await this.dependencies.revisions.updateState({ revisionTaskId, status: "chapter_registered", updatedAtMs: this.dependencies.now() })
    await this.dependencies.revisions.updateFinalization({ revisionTaskId, status: "chapter_registered", updatedAtMs: this.dependencies.now() })
    await this.dependencies.revisions.updateFinalization({ revisionTaskId, status: "completed", updatedAtMs: this.dependencies.now() })
    return toPublicRevision(await this.dependencies.revisions.updateState({
      revisionTaskId, status: "completed", graphSyncStatus: "completed", updatedAtMs: this.dependencies.now(),
    }))
  }

  private async requireCurrentChapter(projectId: ProjectId, chapterId: string) {
    const chapter = await this.dependencies.documents.findCurrentChapter(projectId, chapterId)
    if (chapter === undefined) throw new ChapterNotFoundError(chapterId)
    return chapter
  }

  private async toRevisionReadResult(revision: StoredChapterRevision): Promise<ChapterRevisionReadResult> {
    const proposedContent = await this.dependencies.internalStore.readDocument(revision.contentRef)
    return {
      ...toPublicRevision(revision),
      proposedContent,
      proposedBody: readChapterBody(revision.heading, proposedContent),
    }
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

function publishChapterDraftHistory(
  versions: readonly RevisionDraftVersion[],
  currentBody: string | undefined,
): RevisionDraftVersion[] {
  const unique: RevisionDraftVersion[] = []
  const seen = new Set<string>()
  for (const version of versions) {
    if (version.source === "baseline" && seen.has(version.bodyDigest)) continue
    seen.add(version.bodyDigest)
    unique.push(version)
  }
  const latestId = unique.at(-1)?.versionId
  return unique.map((version) => ({
    ...version,
    isLatest: version.versionId === latestId,
    isCurrentOfficial: version.body === currentBody,
  }))
}

function toPublicRevision(record: StoredChapterRevision): ChapterRevision {
  return {
    revisionTaskId: record.revisionTaskId,
    projectId: record.projectId,
    chapterId: record.chapterId,
    ...(record.chapterSequence === undefined ? {} : { chapterSequence: record.chapterSequence }),
    ...(record.publishPath === undefined ? {} : { publishPath: record.publishPath }),
    ...(record.isInitialPublication === undefined ? {} : { isInitialPublication: record.isInitialPublication }),
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
