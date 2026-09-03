import {
  PROTOCOL_VERSION,
  backendErrorSchema,
  clientRequestSchema,
  idSchema,
} from "@worldseed/contracts"
import type {
  BackendError,
  ClientRequest,
  ClientResponse,
  ProjectId,
  ModelSelection,
  TaskHandle,
  TaskKind,
  TaskStatus,
} from "@worldseed/contracts"
import {
  calculateEffectiveWorldEvolutionLimits,
  defaultTurnExecutionProfile,
  defaultWorldEvolutionProfile,
} from "@worldseed/config"
import {
  GRAPH_NEIGHBORHOOD_MAX_ANCHORS,
  phaseRequestEnvelopeSchema,
  projectCreatePayloadSchema,
  projectListPayloadSchema,
  projectRenamePayloadSchema,
  graphNeighborhoodPayloadSchema,
  historyBranchesPayloadSchema,
  historyEntryOperationPayloadSchema,
  historyListPayloadSchema,
  historyReturnPreviousRoundPayloadSchema,
  historyRetentionPreviewPayloadSchema,
  historySaveManualPayloadSchema,
  chapterListPayloadSchema,
  chapterResolvePayloadSchema,
  chapterResolveByPathPayloadSchema,
  chapterReadPayloadSchema,
  chapterReadRevisionPayloadSchema,
  chapterFindActiveRevisionPayloadSchema,
  chapterStartRevisionPayloadSchema,
  chapterUpdateRevisionPayloadSchema,
  chapterReviewRevisionPayloadSchema,
  chapterSubmitRevisionPayloadSchema,
  chapterRetireRevisionPayloadSchema,
  chapterRevisionConversationApplyPayloadSchema,
  chapterRevisionConversationListPayloadSchema,
  chapterRevisionConversationSendPayloadSchema,
  synopsisConversationStartPayloadSchema,
  synopsisConversationListPayloadSchema,
  synopsisConversationSendPayloadSchema,
  synopsisConversationRefreshChoicesPayloadSchema,
  synopsisConversationDiscardLastUserTurnPayloadSchema,
  synopsisConversationAcknowledgeBudgetPayloadSchema,
  synopsisConversationStreamPeekPayloadSchema,
  synopsisResolveTurnInputPayloadSchema,
  synopsisBeginTurnPayloadSchema,
  chapterSynopsisGetPayloadSchema,
  deductionGoalsListPayloadSchema,
  deductionGoalsCreatePayloadSchema,
  deductionGoalsUpdatePayloadSchema,
  deductionGoalsProgressSetPayloadSchema,
  deductionGoalsProposalApprovePayloadSchema,
  deductionGoalsProposalRejectPayloadSchema,
  deductionGoalsImportLegacyPayloadSchema,
  settingsExtractionListPayloadSchema,
  settingsExtractionProposalApprovePayloadSchema,
  settingsExtractionProposalRejectPayloadSchema,
  settingsLineageListPayloadSchema,
  settingsLineageGetCommitPayloadSchema,
  settingsLineageHeadMetaPayloadSchema,
  settingsLineagePathsPayloadSchema,
  settingsLineageReadAsOfPayloadSchema,
  settingsLineageRestoreAsCurrentPayloadSchema,
  settingsLineageAnnotatePayloadSchema,
  synopsisStagingPromoteListPayloadSchema,
  synopsisStagingPromoteApprovePayloadSchema,
  synopsisStagingPromoteRejectPayloadSchema,
  modelListPayloadSchema,
  modelProfilesReadPayloadSchema,
  modelProfilesSavePayloadSchema,
  projectSettingsReadPayloadSchema,
  projectSettingsSavePayloadSchema,
  projectWorkspacePayloadSchema,
  taskPayloadSchema,
  turnRecoverableTasksPayloadSchema,
  turnMetricsResetPayloadSchema,
  turnResumePayloadSchema,
  turnStartPayloadSchema,
  workspaceReadPayloadSchema,
  workspaceSavePayloadSchema,
  workspaceDeletePayloadSchema,
  workspaceCreateDirectoryPayloadSchema,
  workspaceImportFilesPayloadSchema,
  workspaceImportFolderPayloadSchema,
  worldEvolvePayloadSchema,
  worldQueryPayloadSchema,
} from "@worldseed/contracts"
import { digest, isChapterVolumeContainerPath } from "../core/index.js"
import {
  ChapterNotFoundError,
  ProjectLifecycleError,
  RevisionConflictError,
  RevisionInvalidStateError,
  RevisionNotFoundError,
  SynopsisInvalidStateError,
  SettingsExtractionReviewPendingError,
  TurnBudgetExceededError,
  TurnPauseRequestedError,
} from "../application/index.js"
import { DeepSeekModelError } from "../infrastructure/index.js"
import { errorDetails, runtimeLog } from "../infrastructure/diagnostics/index.js"
import type { StoredPhaseRun, TurnOrchestratorInput, WorkflowExecutionResult } from "../application/index.js"
import type { BackendContainer } from "./container.js"
import type { ProjectRuntime } from "./project-runtime.js"

type TaskRecord = Readonly<{
  handle: TaskHandle
  status: TaskStatus
  result?: WorkflowExecutionResult
  error?: BackendError
  turnInput?: TurnOrchestratorInput
  orchestrator?: import("../application/index.js").TurnOrchestrator
  abortController?: AbortController
  modelSelection?: ModelSelection
}>

type AutomaticEvolutionTrigger = Readonly<{
  projectId: ProjectId
  workspaceRootRef: string
  triggerTaskId: string
  model?: ModelSelection
}>

export type BackendFacadeOptions = Readonly<{
  automaticEvolutionEnabled?: boolean
}>

export class BackendFacade {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly automaticEvolutionTasks = new Set<string>()
  private readonly activeAutomaticEvolutionByProject = new Map<string, string>()
  private readonly pausedAutomaticEvolutionByProject = new Map<string, string[]>()
  private readonly pendingAutomaticEvolutionByProject = new Map<string, AutomaticEvolutionTrigger[]>()
  private closed = false

  public constructor(
    private readonly container: BackendContainer,
    private readonly options: BackendFacadeOptions = {},
  ) {}

  public async handle(raw: unknown): Promise<ClientResponse> {
    const rawProtocolVersion = readStringProperty(raw, "protocolVersion")
    const rawRequestId = readStringProperty(raw, "requestId")
    const requestId = idSchema.safeParse(rawRequestId).success ? rawRequestId as string : this.container.createId()
    if (rawProtocolVersion !== undefined && rawProtocolVersion !== PROTOCOL_VERSION) {
      return this.failure(requestId, this.createError(
        "protocol_mismatch",
        `Unsupported protocol version: ${rawProtocolVersion}`,
        false,
      ))
    }
    const parsed = clientRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return this.failure(requestId, this.errorFrom(parsed.error))
    }
    const request = parsed.data
    const startedAtMs = this.container.now()
    runtimeLog("debug", "backend-facade", "request.started", {
      requestId: request.requestId,
      method: request.method,
    })
    try {
      const data = await this.dispatch(request)
      runtimeLog("debug", "backend-facade", "request.completed", {
        requestId: request.requestId,
        method: request.method,
        elapsedMs: this.container.now() - startedAtMs,
      })
      return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, data }
    } catch (error) {
      runtimeLog("error", "backend-facade", "request.failed", {
        requestId: request.requestId,
        method: request.method,
        elapsedMs: this.container.now() - startedAtMs,
        error: errorDetails(error),
      })
      return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: this.errorFrom(error) }
    }
  }

  public async close(): Promise<void> {
    this.closed = true
    for (const task of this.tasks.values()) task.abortController?.abort("Backend is closing")
    await this.container.close()
  }

  private async dispatch(request: ClientRequest): Promise<unknown> {
    switch (request.method) {
      case "project.create": {
        const payload = projectCreatePayloadSchema.parse(request.payload)
        const project = await this.container.createProject(payload)
        return {
          projectId: project.manifest.id,
          displayName: project.manifest.displayName,
          workspaceRootRef: project.manifest.workspaceRootRef,
        }
      }
      case "project.open": {
        const payload = projectWorkspacePayloadSchema.parse(request.payload)
        const project = await this.container.openProject(payload.workspaceRootRef)
        return {
          projectId: project.manifest.id,
          displayName: project.manifest.displayName,
          workspaceRootRef: project.manifest.workspaceRootRef,
        }
      }
      case "project.list": {
        projectListPayloadSchema.parse(request.payload ?? {})
        const registered = await this.container.listProjects()
        return {
          projects: await Promise.all(registered.map(async (project) => {
            let displayName = displayNameFromWorkspaceRoot(project.workspaceRootRef)
            try {
              const peeked = await this.container.peekProjectDisplayName(project)
              if (peeked !== undefined && peeked.trim().length > 0) displayName = peeked.trim()
            } catch {
              // Fall back to folder name when a registered workspace cannot be read.
            }
            return {
              projectId: project.projectId,
              displayName,
              workspaceRootRef: project.workspaceRootRef,
              lastOpenedAtMs: project.lastOpenedAtMs,
            }
          })),
        }
      }
      case "project.rename": {
        const payload = projectRenamePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        const displayName = await runtime.renameDisplayName(payload.displayName)
        return {
          projectId: payload.projectId,
          displayName,
          workspaceRootRef: payload.workspaceRootRef,
        }
      }
      case "project.validate": {
        const payload = projectWorkspacePayloadSchema.parse(request.payload)
        return this.container.validateProject(payload.workspaceRootRef)
      }
      case "project.settings.read": {
        const payload = projectSettingsReadPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.readSettings()
      }
      case "project.settings.save": {
        const payload = projectSettingsSavePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.saveSettings(payload.settings)
      }
      case "history.list": {
        const payload = historyListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.listHistoryEntries()
      }
      case "history.branches": {
        const payload = historyBranchesPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.listHistoryBranches()
      }
      case "history.saveManual": {
        const payload = historySaveManualPayloadSchema.parse(request.payload)
        await this.preemptAutomaticEvolution(payload.projectId)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        const activeTask = [...this.tasks.values()].find((task) => (
          task.handle.projectId === payload.projectId
          && !this.automaticEvolutionTasks.has(task.handle.taskId)
          && (task.status === "created" || task.status === "running" || task.status === "committing"
            || task.status === "paused" || task.status === "awaiting_user_decision"
            || task.status === "waiting_for_review")
        ))
        const stableCheckpoint = activeTask === undefined
          ? undefined
          : await runtime.findTaskCheckpoint(activeTask.handle.taskId)
        if (activeTask !== undefined && stableCheckpoint === undefined) {
          throw new Error("The running task has no stable checkpoint available for manual history save")
        }
        const saved = await runtime.saveManualHistory({
          operationId: payload.operationId,
          name: payload.name,
          ...(payload.note === undefined ? {} : { note: payload.note }),
          ...(activeTask === undefined ? {} : { taskId: activeTask.handle.taskId }),
          ...(stableCheckpoint === undefined ? {} : { checkpointId: stableCheckpoint.phaseRunId }),
          createdAtMs: this.container.now(),
        })
        void this.drainAutomaticEvolution(payload.projectId)
        return saved
      }
      case "history.restore": {
        const payload = historyEntryOperationPayloadSchema.parse(request.payload)
        await this.ensureHistoryCheckoutAvailable(payload.projectId)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.checkoutHistory({
          operationId: payload.operationId,
          entryId: payload.entryId,
          mode: "restore",
          startedAtMs: this.container.now(),
        })
      }
      case "history.continueFrom": {
        const payload = historyEntryOperationPayloadSchema.parse(request.payload)
        await this.ensureHistoryCheckoutAvailable(payload.projectId)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.checkoutHistory({
          operationId: payload.operationId,
          entryId: payload.entryId,
          mode: "continue_from",
          startedAtMs: this.container.now(),
        })
      }
      case "history.returnPreviousRound": {
        const payload = historyReturnPreviousRoundPayloadSchema.parse(request.payload)
        await this.ensureHistoryCheckoutAvailable(payload.projectId)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.returnPreviousRound({
          operationId: payload.operationId,
          startedAtMs: this.container.now(),
        })
      }
      case "history.retention.preview": {
        const payload = historyRetentionPreviewPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.previewHistoryRetention(payload.retentionLimit)
      }
      case "workspace.list": {
        const payload = projectWorkspacePayloadSchema.parse(request.payload)
        return this.container.validateProject(payload.workspaceRootRef)
      }
      case "workspace.read": {
        const payload = workspaceReadPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return { relativePath: payload.relativePath, content: await runtime.readMarkdown(payload.relativePath) }
      }
      case "workspace.save": {
        const payload = workspaceSavePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureWritableHistoryBranch(this.container.now())
        await runtime.saveMarkdown(payload.relativePath, payload.content)
        return { relativePath: payload.relativePath, saved: true }
      }
      case "workspace.delete": {
        const payload = workspaceDeletePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureWritableHistoryBranch(this.container.now())
        if (isChapterVolumeContainerPath(payload.relativePath)) {
          await runtime.deleteEmptyVolumeDirectory(payload.relativePath)
        } else {
          await runtime.deleteMarkdown(payload.relativePath)
        }
        return { relativePath: payload.relativePath, deleted: true }
      }
      case "workspace.createDirectory": {
        const payload = workspaceCreateDirectoryPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureWritableHistoryBranch(this.container.now())
        await runtime.createDirectory(payload.relativePath)
        return { relativePath: payload.relativePath, created: true }
      }
      case "workspace.importFiles": {
        const payload = workspaceImportFilesPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureWritableHistoryBranch(this.container.now())
        const imported = await runtime.importMarkdownFiles(payload.destination, payload.sourcePaths)
        return { destination: payload.destination, imported }
      }
      case "workspace.importFolder": {
        const payload = workspaceImportFolderPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureWritableHistoryBranch(this.container.now())
        const imported = await runtime.importMarkdownFolder(payload.destination, payload.sourceFolder)
        return { destination: payload.destination, imported }
      }
      case "chapter.list": {
        const payload = chapterListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().list(payload.projectId)
      }
      case "chapter.read": {
        const payload = chapterReadPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().read(payload.projectId, payload.chapterId)
      }
      case "chapter.resolve": {
        const payload = chapterResolvePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterResolveService().resolve(payload.projectId, payload.chapterId)
      }
      case "chapter.resolveByPath": {
        const payload = chapterResolveByPathPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterResolveService().resolveByPath(payload.projectId, payload.publishPath)
      }
      case "chapter.readRevision": {
        const payload = chapterReadRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().readRevision(payload.revisionTaskId)
      }
      case "chapter.findActiveRevision": {
        const payload = chapterFindActiveRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().findActiveRevision(payload.projectId, payload.chapterId)
      }
      case "chapter.startRevision": {
        const payload = chapterStartRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().start({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          chapterId: payload.chapterId,
          baseSourceId: payload.baseSourceId,
          heading: payload.heading,
          body: payload.body,
          ...(payload.inputMode === undefined ? {} : { inputMode: payload.inputMode }),
        })
      }
      case "chapter.updateRevision": {
        const payload = chapterUpdateRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().update(payload.revisionTaskId, payload.heading, payload.body)
      }
      case "chapter.reviewRevision": {
        const payload = chapterReviewRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().review({
          revisionTaskId: payload.revisionTaskId,
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
        }, this.resolveModel(payload.model))
      }
      case "chapter.submitRevision": {
        const payload = chapterSubmitRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        const service = runtime.createChapterRevisionService()
        const revision = await service.submit({
          revisionTaskId: payload.revisionTaskId,
          workspaceRootRef: payload.workspaceRootRef,
          mode: payload.mode,
          forced: payload.forced,
          ...(payload.reviewId === undefined ? {} : { reviewId: payload.reviewId }),
          ...(payload.note === undefined ? {} : { note: payload.note }),
        })
        if (revision.status === "graph_sync_pending") {
          runtimeLog("debug", "backend-facade", "chapter.revision.graph-sync.scheduled", {
            revisionTaskId: payload.revisionTaskId,
          })
          void service.submit({
            revisionTaskId: payload.revisionTaskId,
            workspaceRootRef: payload.workspaceRootRef,
            mode: payload.mode,
            forced: payload.forced,
            model: this.resolveModel(payload.model),
            ...(payload.reviewId === undefined ? {} : { reviewId: payload.reviewId }),
            ...(payload.note === undefined ? {} : { note: payload.note }),
          }).then(async (completedRevision) => {
            if (completedRevision.status !== "completed") return
            runtimeLog("info", "backend-facade", "chapter.revision.graph-sync.completed", {
              revisionTaskId: completedRevision.revisionTaskId,
            })
            try {
              await runtime.saveAutomaticHistory({
                operationId: completedRevision.revisionTaskId,
                name: `章节修订 ${completedRevision.chapterId}`,
                taskId: completedRevision.revisionTaskId,
                createdAtMs: this.container.now(),
              })
            } catch (error) {
              runtimeLog("error", "backend-facade", "chapter.revision.history.failed", {
                revisionTaskId: completedRevision.revisionTaskId,
                error: errorDetails(error),
              })
            }
          }).catch((error) => {
            runtimeLog("error", "backend-facade", "chapter.revision.graph-sync.failed", {
              revisionTaskId: payload.revisionTaskId,
              error: errorDetails(error),
            })
          })
        }
        if (revision.status === "completed") {
          try {
            await runtime.saveAutomaticHistory({
              operationId: revision.revisionTaskId,
              name: `章节修订 ${revision.chapterId}`,
              taskId: revision.revisionTaskId,
              createdAtMs: this.container.now(),
            })
          } catch (error) {
            runtimeLog("error", "backend-facade", "chapter.revision.history.failed", {
              revisionTaskId: revision.revisionTaskId,
              error: errorDetails(error),
            })
          }
        }
        return revision
      }
      case "chapter.retireRevision": {
        const payload = chapterRetireRevisionPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionService().retire(payload.revisionTaskId)
      }
      case "chapter.revision.conversation.list": {
        const payload = chapterRevisionConversationListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionConversationService().list(payload.projectId, payload.chapterId)
      }
      case "chapter.revision.conversation.send": {
        const payload = chapterRevisionConversationSendPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionConversationService().send({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          chapterId: payload.chapterId,
          message: payload.message,
          model: this.resolveModel(payload.model),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
        })
      }
      case "chapter.revision.conversation.apply": {
        const payload = chapterRevisionConversationApplyPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterRevisionConversationService().apply(payload)
      }
      case "synopsis.conversation.start": {
        const payload = synopsisConversationStartPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().start({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          ...(payload.title === undefined ? {} : { title: payload.title }),
        })
      }
      case "synopsis.conversation.list": {
        const payload = synopsisConversationListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().list({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
        })
      }
      case "synopsis.conversation.send": {
        const payload = synopsisConversationSendPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().send({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          message: payload.message,
          model: this.resolveModel(payload.model),
          ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
          ...(payload.chapterIntent === undefined ? {} : { chapterIntent: payload.chapterIntent }),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
        })
      }
      case "synopsis.conversation.refreshChoices": {
        const payload = synopsisConversationRefreshChoicesPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().refreshChoices({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          model: this.resolveModel(payload.model),
          ...(payload.messageId === undefined ? {} : { messageId: payload.messageId }),
          ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
          ...(payload.chapterIntent === undefined ? {} : { chapterIntent: payload.chapterIntent }),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
        })
      }
      case "synopsis.conversation.discardLastUserTurn": {
        const payload = synopsisConversationDiscardLastUserTurnPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().discardLastUserTurn({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        })
      }
      case "synopsis.conversation.acknowledgeBudget": {
        const payload = synopsisConversationAcknowledgeBudgetPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().acknowledgeBudget({
          projectId: payload.projectId,
        })
      }
      case "synopsis.conversation.streamPeek": {
        const payload = synopsisConversationStreamPeekPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().peekStream(
          payload.projectId,
          payload.sessionId,
        )
      }
      case "synopsis.conversation.resolveTurnInput": {
        const payload = synopsisResolveTurnInputPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSynopsisConversationService().resolveTurnInput({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        })
      }
      case "synopsis.conversation.beginTurn": {
        const payload = synopsisBeginTurnPayloadSchema.parse(request.payload)
        return this.beginSynopsisTurn({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          acknowledgeWarnings: payload.acknowledgeWarnings,
          forceOverride: payload.forceOverride,
          allowWorkspaceChapterReads: payload.allowWorkspaceChapterReads,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
          ...(payload.chapterIntent === undefined ? {} : { chapterIntent: payload.chapterIntent }),
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
        })
      }
      case "chapter.synopsis.get": {
        const payload = chapterSynopsisGetPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createChapterSynopsisService().get({
          projectId: payload.projectId,
          ...(payload.chapterId === undefined ? {} : { chapterId: payload.chapterId }),
          ...(payload.publishPath === undefined ? {} : { publishPath: payload.publishPath }),
        })
      }
      case "deduction.goals.list": {
        const payload = deductionGoalsListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().list(payload.projectId)
      }
      case "deduction.goals.create": {
        const payload = deductionGoalsCreatePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().create({
          projectId: payload.projectId,
          content: payload.content,
          ...(payload.narrativeKind === undefined ? {} : { narrativeKind: payload.narrativeKind }),
          ...(payload.scale === undefined ? {} : { scale: payload.scale }),
          ...(payload.plantChapterSequence === undefined
            ? {}
            : { plantChapterSequence: payload.plantChapterSequence }),
          ...(payload.payoffChapterSequence === undefined
            ? {}
            : { payoffChapterSequence: payload.payoffChapterSequence }),
        })
      }
      case "deduction.goals.update": {
        const payload = deductionGoalsUpdatePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().update({
          projectId: payload.projectId,
          goalId: payload.goalId,
          ...(payload.content === undefined ? {} : { content: payload.content }),
          ...(payload.action === undefined ? {} : { action: payload.action }),
          ...(payload.narrativeKind === undefined ? {} : { narrativeKind: payload.narrativeKind }),
          ...(payload.scale === undefined ? {} : { scale: payload.scale }),
          ...(payload.plantChapterSequence === undefined
            ? {}
            : { plantChapterSequence: payload.plantChapterSequence }),
          ...(payload.payoffChapterSequence === undefined
            ? {}
            : { payoffChapterSequence: payload.payoffChapterSequence }),
        })
      }
      case "deduction.goals.progress.set": {
        const payload = deductionGoalsProgressSetPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().setProgress({
          projectId: payload.projectId,
          goalId: payload.goalId,
          chapterSequence: payload.chapterSequence,
          summary: payload.summary,
          status: payload.status,
        })
      }
      case "deduction.goals.proposal.approve": {
        const payload = deductionGoalsProposalApprovePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().approveProposals({
          projectId: payload.projectId,
          proposalIds: payload.proposalIds,
        })
      }
      case "deduction.goals.proposal.reject": {
        const payload = deductionGoalsProposalRejectPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().rejectProposals({
          projectId: payload.projectId,
          proposalIds: payload.proposalIds,
        })
      }
      case "deduction.goals.importLegacy": {
        const payload = deductionGoalsImportLegacyPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createDeductionGoalsService().importLegacy({
          projectId: payload.projectId,
          goals: payload.goals,
        })
      }
      case "settings.extraction.list": {
        const payload = settingsExtractionListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSettingsExtractionService().listByTask(payload.taskId)
      }
      case "settings.extraction.proposal.approve": {
        const payload = settingsExtractionProposalApprovePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSettingsExtractionService().approveProposals({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          proposalIds: payload.proposalIds,
          ...(payload.reasonOverride === undefined ? {} : { reasonOverride: payload.reasonOverride }),
        })
      }
      case "settings.extraction.proposal.reject": {
        const payload = settingsExtractionProposalRejectPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSettingsExtractionService().rejectProposals({
          projectId: payload.projectId,
          proposalIds: payload.proposalIds,
        })
      }
      case "settings.lineage.list": {
        const payload = settingsLineageListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        return runtime.createSettingsLineageService().list({
          relativePath: payload.relativePath,
          ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        })
      }
      case "settings.lineage.getCommit": {
        const payload = settingsLineageGetCommitPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createSettingsLineageService().getCommit(payload.commitId)
      }
      case "settings.lineage.headMeta": {
        const payload = settingsLineageHeadMetaPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        return runtime.createSettingsLineageService().headMeta(payload.relativePath)
      }
      case "settings.lineage.paths": {
        const payload = settingsLineagePathsPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        return runtime.createSettingsLineageService().listPaths()
      }
      case "settings.lineage.readAsOf": {
        const payload = settingsLineageReadAsOfPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        const resolved = await runtime.createSettingsLineageService().readAsOfChapter({
          relativePath: payload.relativePath,
          chapterSequence: payload.chapterSequence,
        })
        if (resolved === undefined) {
          throw new Error(`settings lineage as-of not found: ${payload.relativePath} @ chapter ${String(payload.chapterSequence)}`)
        }
        return {
          relativePath: payload.relativePath.replaceAll("\\", "/"),
          chapterSequence: payload.chapterSequence,
          commitId: resolved.commitId,
          commitSeq: resolved.commitSeq,
          markdown: resolved.markdown,
        }
      }
      case "settings.lineage.restoreAsCurrent": {
        const payload = settingsLineageRestoreAsCurrentPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        const entry = await runtime.createSettingsLineageService().restoreAsCurrent({
          commitId: payload.commitId,
          confirmPhrase: payload.confirmPhrase,
        })
        return { entry }
      }
      case "settings.lineage.annotate": {
        const payload = settingsLineageAnnotatePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        await runtime.ensureSettingsLineageSeeded()
        const entry = await runtime.createSettingsLineageService().annotate({
          commitId: payload.commitId,
          ...(payload.storyTime === undefined ? {} : { storyTime: payload.storyTime }),
          ...(payload.summary === undefined ? {} : { summary: payload.summary }),
        })
        return { entry }
      }
      case "synopsis.staging.promote.list": {
        const payload = synopsisStagingPromoteListPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createStagingPromoteService().list({
          projectId: payload.projectId,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        })
      }
      case "synopsis.staging.promote.approve": {
        const payload = synopsisStagingPromoteApprovePayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createStagingPromoteService().approve({
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          proposalIds: payload.proposalIds,
          ...(payload.reasonOverride === undefined ? {} : { reasonOverride: payload.reasonOverride }),
        })
      }
      case "synopsis.staging.promote.reject": {
        const payload = synopsisStagingPromoteRejectPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.createStagingPromoteService().reject({
          projectId: payload.projectId,
          proposalIds: payload.proposalIds,
        })
      }
      case "model.list": {
        const payload = modelListPayloadSchema.parse(request.payload)
        return this.container.modelCatalog.list(payload)
      }
      case "model.profiles.read": {
        modelProfilesReadPayloadSchema.parse(request.payload)
        return this.container.modelProfiles.read()
      }
      case "model.profiles.save": {
        const payload = modelProfilesSavePayloadSchema.parse(request.payload)
        return this.container.modelProfiles.save(payload)
      }
      case "graph.neighborhood": {
        const payload = graphNeighborhoodPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        const settings = await runtime.readSettings()
        const anchorLimit = Math.min(
          settings.graph.maxNeighborhoodAnchors ?? 32,
          GRAPH_NEIGHBORHOOD_MAX_ANCHORS,
        )
        const anchorOffset = Math.min(payload.anchorOffset, payload.anchorIds.length)
        const nextAnchorOffset = Math.min(anchorOffset + anchorLimit, payload.anchorIds.length)
        const selectedAnchorIds = payload.anchorIds.slice(anchorOffset, nextAnchorOffset)
        const slice = selectedAnchorIds.length === 0
          ? { nodes: [], links: [], truncated: false }
          : await runtime.readGraphNeighborhood({
            anchorIds: selectedAnchorIds,
            direction: payload.direction,
            maxDepth: payload.maxDepth,
            maxNodes: payload.maxNodes,
            maxLinks: payload.maxLinks,
          })
        const hasMoreAnchors = nextAnchorOffset < payload.anchorIds.length
        runtimeLog("debug", "backend-facade", "graph.neighborhood.windowed", {
          projectId: payload.projectId,
          requestedAnchorCount: payload.anchorIds.length,
          anchorOffset,
          processedAnchorCount: selectedAnchorIds.length,
          remainingAnchorCount: payload.anchorIds.length - nextAnchorOffset,
          anchorLimit,
        })
        return {
          ...slice,
          truncated: slice.truncated || hasMoreAnchors,
          anchorWindow: {
            requestedCount: payload.anchorIds.length,
            processedCount: selectedAnchorIds.length,
            offset: anchorOffset,
            limit: anchorLimit,
            remainingCount: payload.anchorIds.length - nextAnchorOffset,
            ...(hasMoreAnchors ? { nextOffset: nextAnchorOffset } : {}),
          },
        }
      }
      case "turn.start": {
        const payload = turnStartPayloadSchema.parse(request.payload)
        return this.startTurn(payload)
      }
      case "world.query": {
        const payload = worldQueryPayloadSchema.parse(request.payload)
        return this.startWorkflow({
          workflow: "query",
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          userInput: payload.question,
          chapterSequence: 1,
          allowWorkspaceChapterReads: payload.allowWorkspaceChapterReads,
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
          ...(payload.maxRetrievalRounds === undefined ? {} : { maxRetrievalRounds: payload.maxRetrievalRounds }),
        })
      }
      case "world.evolve": {
        const payload = worldEvolvePayloadSchema.parse(request.payload)
        return this.startWorkflow({
          workflow: "evolution",
          projectId: payload.projectId,
          workspaceRootRef: payload.workspaceRootRef,
          userInput: payload.instruction,
          chapterSequence: 1,
          allowWorkspaceChapterReads: false,
          ...(payload.model === undefined ? {} : { model: payload.model }),
          ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
          ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
          ...(payload.maxRetrievalRounds === undefined ? {} : { maxRetrievalRounds: payload.maxRetrievalRounds }),
        })
      }
      case "turn.status": {
        const payload = taskPayloadSchema.parse(request.payload)
        return this.readTask(payload.taskId)
      }
      case "turn.metrics.reset": {
        const payload = turnMetricsResetPayloadSchema.parse(request.payload)
        const runtime = this.container.getCurrentRuntime()
        if (runtime === undefined) throw new Error("No project is open")
        const result = await runtime.resetRuntimeMetrics(payload.taskId, payload.metricIds, this.container.now())
        runtimeLog("info", "backend-facade", "turn.metrics.reset", {
          taskId: payload.taskId,
          metricIds: payload.metricIds,
        })
        return result
      }
      case "turn.resume": {
        const payload = turnResumePayloadSchema.parse(request.payload)
        return this.resumeTurn(payload)
      }
      case "turn.recoverable.list": {
        const payload = turnRecoverableTasksPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        const recoveryCheckedAtMs = this.container.now()
        const staleTasks = await runtime.recoverStaleRunningTasks(
          [...this.tasks.keys()],
          recoveryCheckedAtMs,
          {
            kind: "execution_error",
            message: "应用重新启动时发现未完成的推演，已恢复到最近稳定检查点，请选择继续、重试本阶段或保持暂停。",
            recoverable: true,
            blockedMetrics: [],
            interruptedAtMs: recoveryCheckedAtMs,
          },
        )
        if (staleTasks.length > 0) {
          runtimeLog("warn", "backend-facade", "turn.stale_running.recovered", {
            projectId: payload.projectId,
            taskIds: staleTasks.map((task) => task.taskId),
          })
        }
        const tasks = await runtime.listRecoverableTasks()
        runtimeLog("debug", "backend-facade", "turn.recoverable.listed", {
          projectId: payload.projectId,
          taskCount: tasks.length,
          latestTaskId: tasks[0]?.taskId,
          latestStatus: tasks[0]?.status,
        })
        return Promise.all(tasks.map(async (task) => this.readTask(task.taskId)))
      }
      case "turn.pause": {
        const payload = taskPayloadSchema.parse(request.payload)
        return this.pauseTurn(payload.taskId)
      }
      case "turn.cancel": {
        const payload = taskPayloadSchema.parse(request.payload)
        return this.cancelTurn(payload.taskId)
      }
      default:
        throw new Error(`Backend method is not implemented in this runtime: ${request.method}`)
    }
  }

  private async startTurn(payload: {
    projectId: ProjectId
    workspaceRootRef: string
    userInput: string
    chapterSequence: number
    presentation?: {
      descriptionRulePath?: string | undefined
      proseStyleRulePath?: string | undefined
      minimumWordCount: number
      maximumWordCount: number
    } | undefined
    chapterIntent?: TurnOrchestratorInput["chapterIntent"]
    model?: ModelSelection | undefined
    maxModelCalls?: number | undefined
    allowWorkspaceChapterReads: boolean
    deductionGoalBundle?: TurnOrchestratorInput["deductionGoalBundle"]
  }): Promise<TaskHandle> {
    return this.startWorkflow({
      workflow: "turn",
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      userInput: payload.userInput,
      chapterSequence: payload.chapterSequence,
      allowWorkspaceChapterReads: payload.allowWorkspaceChapterReads,
      ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
      ...(payload.chapterIntent === undefined ? {} : { chapterIntent: payload.chapterIntent }),
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
      ...(payload.deductionGoalBundle === undefined
        ? {}
        : { deductionGoalBundle: payload.deductionGoalBundle }),
    })
  }

  private async beginSynopsisTurn(payload: {
    projectId: ProjectId
    workspaceRootRef: string
    sessionId?: string
    acknowledgeWarnings: boolean
    forceOverride: boolean
    presentation?: TurnOrchestratorInput["presentation"]
    chapterIntent?: TurnOrchestratorInput["chapterIntent"]
    model?: ModelSelection
    maxModelCalls?: number
    allowWorkspaceChapterReads: boolean
  }): Promise<TaskHandle> {
    const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
    const prepared = await runtime.createSynopsisConversationService().prepareBeginTurn({
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
      acknowledgeWarnings: payload.acknowledgeWarnings,
      forceOverride: payload.forceOverride,
    })
    return this.startWorkflow({
      workflow: "turn",
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      userInput: prepared.userInput,
      chapterSequence: prepared.chapterSequence,
      allowWorkspaceChapterReads: payload.allowWorkspaceChapterReads,
      lockDeductionGoals: true,
      ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
      ...(payload.chapterIntent === undefined ? {} : { chapterIntent: payload.chapterIntent }),
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
    })
  }

  private async startWorkflow(input: Readonly<{
    workflow: "turn" | "query" | "evolution" | "revision"
    projectId: ProjectId
    workspaceRootRef: string
    userInput: string
    chapterSequence: number
    allowWorkspaceChapterReads: boolean
    presentation?: TurnOrchestratorInput["presentation"]
    chapterIntent?: TurnOrchestratorInput["chapterIntent"]
    model?: ModelSelection
    maxModelCalls?: number
    deadlineMs?: number
    maxRetrievalRounds?: number
    executionOrigin?: TurnOrchestratorInput["executionOrigin"]
    deductionGoalBundle?: TurnOrchestratorInput["deductionGoalBundle"]
    lockDeductionGoals?: boolean
  }>): Promise<TaskHandle> {
    if (input.executionOrigin?.kind !== "automatic_evolution" && input.workflow !== "query") {
      await this.preemptAutomaticEvolution(input.projectId)
    }
    const model = this.resolveModel(input.model)
    const modelInfo = model.info
    if (modelInfo?.available === false) {
      throw new DeepSeekModelError("configuration", modelInfo.detail ?? `AI model is unavailable: ${modelInfo.provider}/${modelInfo.model}`)
    }
    const runtime = await this.container.getRuntime(input.projectId, input.workspaceRootRef)
    await runtime.ensureWritableHistoryBranch(this.container.now())
    const chapterResolve = runtime.createChapterResolveService()
    let chapterSequence = input.chapterSequence
    if (input.workflow === "turn") {
      if (await chapterResolve.isGraphSyncBlocking(input.projectId)) {
        runtimeLog("warn", "backend-facade", "turn.blocked.graph_sync", { projectId: input.projectId })
        throw new RevisionInvalidStateError("存在尚未完成图同步的章节修订，请先完成图同步后再开始新一轮推演")
      }
      chapterSequence = await chapterResolve.nextChapterSequence(input.projectId)
      runtimeLog("debug", "backend-facade", "turn.sequence.assigned", {
        projectId: input.projectId,
        chapterSequence,
        requestedSequence: input.chapterSequence,
      })
    }
    let deductionGoalBundle = input.deductionGoalBundle
    if (input.workflow === "turn" && (input.lockDeductionGoals === true || deductionGoalBundle !== undefined)) {
      const goals = runtime.createDeductionGoalsService()
      if (input.lockDeductionGoals === true) {
        await goals.lockForTurn({ projectId: input.projectId, chapterSequence })
        deductionGoalBundle = await goals.buildTurnBundle({
          projectId: input.projectId,
          chapterSequence,
        })
      }
    }
    const projectSettings = await runtime.readSettings()
    const taskId = this.container.createId()
    const abortController = new AbortController()
    const handle: TaskHandle = {
      taskId,
      projectId: input.projectId,
      kind: input.workflow as TaskKind,
      status: "created",
    }
    this.tasks.set(taskId, {
      handle,
      status: "created",
      abortController,
      ...(input.model === undefined ? {} : { modelSelection: input.model }),
    })
    if (input.executionOrigin?.kind === "automatic_evolution") {
      this.automaticEvolutionTasks.add(taskId)
      this.activeAutomaticEvolutionByProject.set(input.projectId, taskId)
    }
    runtimeLog("debug", "backend-facade", `${input.workflow}.accepted`, {
      taskId,
      projectId: input.projectId,
      chapterSequence,
      modelProvider: modelInfo?.provider ?? "unknown",
      modelName: modelInfo?.model ?? "unknown",
      maxModelCalls: input.maxModelCalls ?? projectSettings.execution.maxModelCalls,
    })
    const orchestrator = runtime.createTurnOrchestrator(model, this.container.createId, this.container.now)
    const turnInput = {
      workflow: input.workflow,
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      internalStore: runtime.internalStore,
      userInput: input.userInput,
      chapterSequence,
      allowWorkspaceChapterReads: input.allowWorkspaceChapterReads,
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
      ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
      ...(deductionGoalBundle === undefined ? {} : { deductionGoalBundle }),
      taskId,
      maxModelCalls: input.maxModelCalls ?? projectSettings.execution.maxModelCalls,
      deadlineMs: input.deadlineMs ?? projectSettings.execution.maxWallTimeMs,
      maxRetrievalRounds: input.maxRetrievalRounds ?? projectSettings.execution.maxRetrievalRounds,
      projectSettings,
      executionOrigin: input.executionOrigin ?? { kind: "user" },
    }
    const storedTurnInput = turnInput as TurnOrchestratorInput
    this.tasks.set(taskId, {
      handle,
      status: "created",
      turnInput: storedTurnInput,
      orchestrator,
      abortController,
      ...(input.model === undefined ? {} : { modelSelection: input.model }),
    })
    let markPrepared: (() => void) | undefined
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve })
    const execution = orchestrator.execute(turnInput, {
      onPrepared: () => { markPrepared?.() },
      signal: abortController.signal,
    })
    void execution.then(
      (result) => {
        const current = this.tasks.get(taskId)
        if (current?.abortController !== abortController || current.status === "cancelled" || current.status === "paused") return
        this.tasks.set(taskId, { ...current, handle: { ...handle, status: "completed" }, status: "completed", result, turnInput: storedTurnInput, orchestrator, abortController })
        runtimeLog("info", "backend-facade", `${input.workflow}.completed`, {
          taskId,
          ...(result.kind === "turn" ? { chapterPath: result.chapterPath } : {}),
          resultKind: result.kind,
          modelCalls: result.modelCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        })
        this.handleWorkflowCompleted(runtime, result, taskId, input)
      },
      (error: unknown) => {
        const current = this.tasks.get(taskId)
        if (current?.abortController !== abortController || current.status === "cancelled" || current.status === "paused") return
        if (error instanceof SettingsExtractionReviewPendingError) {
          void this.syncSettingsExtractionReview(taskId, current, handle, storedTurnInput, orchestrator, abortController)
          this.handleAutomaticEvolutionStopped(input.projectId, taskId, false)
          return
        }
        const backendError = this.errorFrom(error)
        this.tasks.set(taskId, { ...current, handle: { ...handle, status: "awaiting_user_decision" }, status: "awaiting_user_decision", error: backendError, turnInput: storedTurnInput, orchestrator, abortController })
        runtimeLog("warn", "backend-facade", `${input.workflow}.interrupted`, {
          taskId,
          error: errorDetails(error),
        })
        this.handleAutomaticEvolutionStopped(input.projectId, taskId, false)
      },
    )
    await Promise.race([
      prepared,
      execution.then(() => undefined),
    ])
    return handle
  }

  private resolveModel(selection: ModelSelection | undefined): import("../application/index.js").AIModelPort {
    if (selection === undefined) return this.container.model
    return this.container.createModelFromSelection({
      baseUrl: selection.baseUrl,
      model: selection.model,
      apiKey: requireResolvedApiKey(selection.apiKey),
      apiProtocol: selection.apiProtocol,
      contextWindowTokens: selection.contextWindowTokens,
      thinkingModeEnabled: selection.thinkingModeEnabled,
      reasoningEffort: selection.reasoningEffort,
      jsonModeEnabled: selection.jsonModeEnabled,
      disableResponseStorage: selection.disableResponseStorage,
      serviceTier: selection.serviceTier,
    })
  }

  private async readTask(taskId: string): Promise<unknown> {
    const inMemory = this.tasks.get(taskId)
    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    const phaseRuns = await this.readPhaseRuns(runtime, taskId)
    const finalization = await runtime?.findFinalizationByTask(taskId)
    const runtimeMetrics = await runtime?.readRuntimeMetrics(taskId, this.container.now())
    if (stored !== undefined) {
      const storedHandle = {
        taskId: stored.taskId,
        projectId: stored.projectId,
        kind: stored.kind,
        status: stored.status,
      }
      return {
        ...(inMemory === undefined ? {} : toPublicTaskSnapshot(inMemory)),
        handle: { ...(inMemory?.handle ?? storedHandle), status: stored.status },
        status: stored.status,
        ...(stored?.lastPhase === undefined ? {} : { lastPhase: stored.lastPhase }),
        ...(stored?.error === undefined ? {} : { interruption: stored.error }),
        ...(finalization === undefined ? {} : { finalization }),
        ...(runtimeMetrics === undefined ? {} : { runtimeMetrics }),
        phaseRuns,
      }
    }
    if (inMemory?.status === "completed" || inMemory?.status === "failed" || inMemory?.status === "awaiting_user_decision" || inMemory?.status === "waiting_for_review" || inMemory?.status === "paused" || inMemory?.status === "cancelled") {
      return {
        ...toPublicTaskSnapshot(inMemory),
        phaseRuns,
      }
    }
    if (inMemory !== undefined) return { ...toPublicTaskSnapshot(inMemory), phaseRuns }
    throw new Error(`Task is not loaded in the current backend runtime: ${taskId}`)
  }

  private async readPhaseRuns(runtime: ProjectRuntime | undefined, taskId: string): Promise<readonly unknown[]> {
    if (runtime === undefined) return []
    try {
      const runs = await Promise.race([
        runtime.listPhaseRuns(taskId),
        new Promise<readonly StoredPhaseRun[]>((resolve) => {
          const timeout = setTimeout(() => resolve([]), 2_000)
          timeout.unref?.()
        }),
      ])
      return runs.map(toTaskPhaseRunSnapshot)
    } catch (error) {
      runtimeLog("warn", "backend-facade", "turn.phase_runs_unavailable", {
        taskId,
        error: errorDetails(error),
      })
      return []
    }
  }

  private async resumeTurn(payload: { taskId: string; mode: "continue" | "retry_phase"; resetMetricIds: readonly ("model_calls" | "input_tokens" | "output_tokens" | "wall_time")[]; model?: ModelSelection | undefined; maxModelCalls?: number | undefined; deadlineMs?: number | undefined; maxRetrievalRounds?: number | undefined }): Promise<TaskHandle> {
    const selectedModel = payload.model === undefined
      ? undefined
      : this.container.createModelFromSelection({
        baseUrl: payload.model.baseUrl,
        model: payload.model.model,
        apiKey: requireResolvedApiKey(payload.model.apiKey),
        apiProtocol: payload.model.apiProtocol,
        contextWindowTokens: payload.model.contextWindowTokens,
        ...(payload.model.thinkingModeEnabled === undefined ? {} : { thinkingModeEnabled: payload.model.thinkingModeEnabled }),
        ...(payload.model.reasoningEffort === undefined ? {} : { reasoningEffort: payload.model.reasoningEffort }),
        ...(payload.model.jsonModeEnabled === undefined ? {} : { jsonModeEnabled: payload.model.jsonModeEnabled }),
        disableResponseStorage: payload.model.disableResponseStorage,
        serviceTier: payload.model.serviceTier,
      })
    const loadedRecord = await this.loadResumableTask(payload.taskId, selectedModel)
    const record = payload.model === undefined
      ? loadedRecord
      : { ...loadedRecord, modelSelection: payload.model as ModelSelection }
    const runtime = this.container.getCurrentRuntime()
    if (runtime === undefined) throw new Error("No project is open")
    if (record.turnInput.executionOrigin?.kind === "automatic_evolution") {
      this.automaticEvolutionTasks.add(payload.taskId)
      this.activeAutomaticEvolutionByProject.set(record.turnInput.projectId, payload.taskId)
    }
    if (payload.resetMetricIds.length > 0) {
      await runtime.resetRuntimeMetrics(payload.taskId, payload.resetMetricIds, this.container.now())
    }
    const storedTask = await runtime.taskScopes.findTask(payload.taskId)
    if (storedTask?.status !== "waiting_for_review") {
      const blockedMetrics = readFacadeBlockedMetrics(storedTask?.error)
      const interruptedAtMs = readFacadeInterruptionTimestamp(storedTask?.error)
      if (!await runtime.wereRuntimeMetricsResetAfter(payload.taskId, blockedMetrics, interruptedAtMs)) {
        throw new FacadeOperationError(
          "budget_exhausted",
          `Explicit budget reset required before resume: ${blockedMetrics.join(", ")}`,
          true,
        )
      }
    }
    const input: TurnOrchestratorInput = {
      ...record.turnInput,
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
      ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
      ...(payload.maxRetrievalRounds === undefined ? {} : { maxRetrievalRounds: payload.maxRetrievalRounds }),
      resetMetricIds: [],
    }
    const handle: TaskHandle = { ...record.handle, status: "running" }
    const abortController = new AbortController()
    this.tasks.set(payload.taskId, { ...record, handle, status: "running", abortController })
    runtimeLog("debug", "backend-facade", "turn.resume.started", {
      taskId: payload.taskId,
      mode: payload.mode,
      maxModelCalls: input.maxModelCalls,
      deadlineMs: input.deadlineMs,
      maxRetrievalRounds: input.maxRetrievalRounds,
    })
    void record.orchestrator.resume(input, payload.mode, { signal: abortController.signal }).then(
      (result) => {
        const current = this.tasks.get(payload.taskId)
        if (current?.abortController !== abortController || current.status === "cancelled" || current.status === "paused") return
        this.tasks.set(payload.taskId, { ...record, handle: { ...handle, status: "completed" }, status: "completed", result, abortController })
        this.handleWorkflowCompleted(runtime, result, payload.taskId, {
          workflow: record.turnInput.workflow ?? "turn",
          projectId: record.turnInput.projectId,
          workspaceRootRef: record.turnInput.workspaceRootRef,
          ...(record.modelSelection === undefined ? {} : { model: record.modelSelection }),
          executionOrigin: record.turnInput.executionOrigin,
        })
      },
      async (error: unknown) => {
        const current = this.tasks.get(payload.taskId)
        if (current?.abortController !== abortController || current.status === "cancelled" || current.status === "paused") return
        if (error instanceof SettingsExtractionReviewPendingError) {
          await this.syncSettingsExtractionReview(payload.taskId, { ...record, abortController }, handle, record.turnInput, record.orchestrator, abortController)
          this.handleAutomaticEvolutionStopped(record.turnInput.projectId, payload.taskId, false)
          return
        }
        const backendError = this.errorFrom(error)
        const runtime = this.container.getCurrentRuntime()
        const stored = await runtime?.taskScopes.findTask(payload.taskId)
        await runtime?.persistenceUpdateTask(payload.taskId, "awaiting_user_decision", stored?.lastPhase, backendError)
        this.tasks.set(payload.taskId, { ...record, handle: { ...handle, status: "awaiting_user_decision" }, status: "awaiting_user_decision", error: backendError, abortController })
        runtimeLog("warn", "backend-facade", "turn.resume.failed", {
          taskId: payload.taskId,
          error: errorDetails(error),
          backendError,
        })
        this.handleAutomaticEvolutionStopped(record.turnInput.projectId, payload.taskId, false)
      },
    )
    return handle
  }

  private handleWorkflowCompleted(
    runtime: ProjectRuntime,
    result: WorkflowExecutionResult,
    taskId: string,
    input: Readonly<{
      workflow: "turn" | "query" | "evolution" | "revision"
      projectId: ProjectId
      workspaceRootRef: string
      model?: ModelSelection
      executionOrigin?: TurnOrchestratorInput["executionOrigin"]
    }>,
  ): void {
    if (input.workflow === "revision") {
      void runtime.createChapterRevisionService().completeGraphSync(taskId).then(async (revision) => {
        if (revision === undefined) return
        try {
          await runtime.saveAutomaticHistory({
            operationId: taskId,
            name: `章节修订 ${revision.chapterId}`,
            taskId,
            createdAtMs: this.container.now(),
          })
          runtimeLog("info", "backend-facade", "chapter.revision.history.completed", {
            taskId,
            revisionTaskId: revision.revisionTaskId,
          })
        } catch (error) {
          runtimeLog("error", "backend-facade", "chapter.revision.history.failed", {
            taskId,
            error: errorDetails(error),
          })
        }
      })
      return
    }
    if (result.kind === "evolution" && input.executionOrigin?.kind === "automatic_evolution") {
      this.handleAutomaticEvolutionStopped(input.projectId, taskId, true)
      return
    }
    if (result.kind !== "turn") return
    void this.finalizeTurnAndScheduleEvolution(runtime, result, input)
  }

  private async finalizeTurnAndScheduleEvolution(
    runtime: ProjectRuntime,
    result: Extract<WorkflowExecutionResult, { kind: "turn" }>,
    input: Readonly<{
      projectId: ProjectId
      workspaceRootRef: string
      model?: ModelSelection
    }>,
  ): Promise<void> {
    try {
      const entry = await runtime.saveAutomaticHistory({
        operationId: result.taskId,
        name: result.chapterHeading,
        taskId: result.taskId,
        createdAtMs: this.container.now(),
      })
      runtimeLog("info", "backend-facade", "history.automatic.completed", {
        taskId: result.taskId,
        entryId: entry.entryId,
      })
    } catch (historyError) {
      runtimeLog("error", "backend-facade", "history.automatic.failed", {
        taskId: result.taskId,
        error: errorDetails(historyError),
        message: "The turn remains completed; automatic evolution is not started before history finalization succeeds",
      })
      return
    }
    if (this.closed || !defaultWorldEvolutionProfile.enabled || this.options.automaticEvolutionEnabled === false) return
    const queue = this.pendingAutomaticEvolutionByProject.get(input.projectId) ?? []
    queue.push({
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      triggerTaskId: result.taskId,
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    this.pendingAutomaticEvolutionByProject.set(input.projectId, queue)
    await this.drainAutomaticEvolution(input.projectId)
  }

  private async drainAutomaticEvolution(projectId: ProjectId): Promise<void> {
    if (this.closed || this.options.automaticEvolutionEnabled === false || this.hasActiveForegroundWriter(projectId)) return
    if (this.activeAutomaticEvolutionByProject.has(projectId)) return
    const paused = this.pausedAutomaticEvolutionByProject.get(projectId)
    const pausedTaskId = paused?.shift()
    if (paused !== undefined && paused.length === 0) this.pausedAutomaticEvolutionByProject.delete(projectId)
    if (pausedTaskId !== undefined) {
      this.activeAutomaticEvolutionByProject.set(projectId, pausedTaskId)
      try {
        await this.resumeTurn({ taskId: pausedTaskId, mode: "continue", resetMetricIds: [] })
      } catch (error) {
        this.activeAutomaticEvolutionByProject.delete(projectId)
        runtimeLog("error", "backend-facade", "world.evolve.automatic.resume_failed", {
          projectId,
          taskId: pausedTaskId,
          error: errorDetails(error),
        })
      }
      return
    }
    const queue = this.pendingAutomaticEvolutionByProject.get(projectId)
    const trigger = queue?.shift()
    if (queue !== undefined && queue.length === 0) this.pendingAutomaticEvolutionByProject.delete(projectId)
    if (trigger === undefined) return
    const limits = calculateEffectiveWorldEvolutionLimits(defaultWorldEvolutionProfile, defaultTurnExecutionProfile)
    try {
      const handle = await this.startWorkflow({
        workflow: "evolution",
        projectId: trigger.projectId,
        workspaceRootRef: trigger.workspaceRootRef,
        userInput: buildAutomaticEvolutionInstruction(trigger.triggerTaskId),
        chapterSequence: 1,
        allowWorkspaceChapterReads: false,
        ...(trigger.model === undefined ? {} : { model: trigger.model }),
        maxModelCalls: limits.backgroundModelCalls,
        deadlineMs: limits.backgroundWallTimeMs,
        executionOrigin: { kind: "automatic_evolution", triggerTaskId: trigger.triggerTaskId },
      })
      runtimeLog("info", "backend-facade", "world.evolve.automatic.started", {
        projectId,
        taskId: handle.taskId,
        triggerTaskId: trigger.triggerTaskId,
        maxModelCalls: limits.backgroundModelCalls,
        deadlineMs: limits.backgroundWallTimeMs,
      })
    } catch (error) {
      runtimeLog("error", "backend-facade", "world.evolve.automatic.start_failed", {
        projectId,
        triggerTaskId: trigger.triggerTaskId,
        error: errorDetails(error),
      })
    }
  }

  private async preemptAutomaticEvolution(projectId: ProjectId): Promise<void> {
    const taskId = this.activeAutomaticEvolutionByProject.get(projectId)
    if (taskId === undefined) return
    const task = this.tasks.get(taskId)
    if (task?.status !== "created" && task?.status !== "running" && task?.status !== "committing") return
    await this.pauseTurn(taskId)
    this.activeAutomaticEvolutionByProject.delete(projectId)
    const paused = this.pausedAutomaticEvolutionByProject.get(projectId) ?? []
    paused.unshift(taskId)
    this.pausedAutomaticEvolutionByProject.set(projectId, paused)
    runtimeLog("info", "backend-facade", "world.evolve.automatic.preempted", { projectId, taskId })
  }

  private handleAutomaticEvolutionStopped(projectId: ProjectId, taskId: string, completed: boolean): void {
    if (!this.automaticEvolutionTasks.has(taskId)) return
    if (this.activeAutomaticEvolutionByProject.get(projectId) === taskId) {
      this.activeAutomaticEvolutionByProject.delete(projectId)
    }
    if (completed) this.automaticEvolutionTasks.delete(taskId)
    if (completed) void this.drainAutomaticEvolution(projectId)
  }

  private hasActiveForegroundWriter(projectId: ProjectId): boolean {
    return [...this.tasks.values()].some((task) => (
      task.handle.projectId === projectId
      && task.handle.kind !== "query"
      && !this.automaticEvolutionTasks.has(task.handle.taskId)
      && (task.status === "created" || task.status === "running" || task.status === "committing")
    ))
  }

  private async loadResumableTask(taskId: string, model?: import("../application/index.js").AIModelPort): Promise<TaskRecord & { orchestrator: import("../application/index.js").TurnOrchestrator; turnInput: TurnOrchestratorInput }> {
    const existing = this.tasks.get(taskId)
    if (model === undefined && existing?.orchestrator !== undefined && existing.turnInput !== undefined) return existing as TaskRecord & { orchestrator: import("../application/index.js").TurnOrchestrator; turnInput: TurnOrchestratorInput }

    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    if (runtime === undefined || stored === undefined) {
      throw new Error("The task is not loaded in the current project runtime")
    }
    if (stored.status !== "awaiting_user_decision" && stored.status !== "paused" && stored.status !== "waiting_for_review") {
      throw new Error(`Task cannot resume from status: ${stored.status}`)
    }
    const storedRuns = await runtime.listPhaseRuns(taskId)
    const latestRun = storedRuns.at(-1)
    if (latestRun === undefined) throw new Error("The task has no recoverable phase checkpoint")
    if (typeof latestRun !== "object" || latestRun === null || !("request" in latestRun)) {
      throw new Error("The task checkpoint has no phase request")
    }
    const latestRequest = phaseRequestEnvelopeSchema.parse((latestRun as { request: unknown }).request)
    const phaseInput = readRecoverablePhaseInput(latestRequest.input)
    const config = readRecoverableTaskConfig(stored.configSnapshot)
    const projectSettings = await runtime.readSettings()
    const turnInput: TurnOrchestratorInput = {
      workflow: stored.kind === "query" || stored.kind === "evolution" ? stored.kind : "turn",
      projectId: stored.projectId,
      workspaceRootRef: runtime.workspaceRootRef,
      internalStore: runtime.internalStore,
      userInput: phaseInput.userInput,
      chapterSequence: phaseInput.chapterSequence,
      allowWorkspaceChapterReads: phaseInput.allowWorkspaceChapterReads,
      ...(phaseInput.presentation === undefined ? {} : { presentation: phaseInput.presentation }),
      ...(phaseInput.chapterIntent === undefined ? {} : { chapterIntent: phaseInput.chapterIntent }),
      taskId: stored.taskId,
      turnId: latestRequest.turnId,
      scopeId: stored.scopeId,
      maxModelCalls: config.maxModelCalls,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      deadlineMs: Math.max(1, config.deadlineAtMs - stored.createdAtMs),
      maxRetrievalRounds: projectSettings.execution.maxRetrievalRounds,
      projectSettings,
      ...(config.executionOrigin === undefined ? {} : { executionOrigin: config.executionOrigin }),
    }
    const orchestrator = runtime.createTurnOrchestrator(model ?? this.container.model, this.container.createId, this.container.now)
    const handle: TaskHandle = {
      taskId: stored.taskId,
      projectId: stored.projectId,
      kind: stored.kind,
      status: stored.status,
    }
    const recovered: TaskRecord = { handle, status: stored.status, turnInput, orchestrator }
    this.tasks.set(taskId, recovered)
    runtimeLog("info", "backend-facade", "turn.rehydrated", {
      taskId,
      phase: latestRequest.phase,
      modelCalls: config.maxModelCalls,
    })
    return recovered as TaskRecord & { orchestrator: import("../application/index.js").TurnOrchestrator; turnInput: TurnOrchestratorInput }
  }

  private async pauseTurn(taskId: string): Promise<TaskHandle> {
    const record = this.tasks.get(taskId)
    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    if (stored === undefined && record === undefined) throw new Error(`Task is not loaded: ${taskId}`)
    const pausableStatuses: readonly TaskStatus[] = ["created", "running", "committing", "awaiting_user_decision", "waiting_for_review"]
    if (!(stored !== undefined && pausableStatuses.includes(stored.status))
      && !(record !== undefined && pausableStatuses.includes(record.status))) {
      throw new FacadeOperationError("validation_error", "The task is not in a pausable state")
    }
    await runtime?.taskScopes.findTask(taskId)
    const next = { ...(record?.handle ?? { taskId, projectId: stored?.projectId ?? "", kind: stored?.kind ?? "turn", status: "paused" as const }), status: "paused" as const }
    if (record !== undefined) {
      this.tasks.set(taskId, { ...record, handle: next, status: "paused" })
      record.abortController?.abort(new TurnPauseRequestedError())
    }
    if (runtime !== undefined) await runtime.persistenceUpdateTask(taskId, "paused")
    return next
  }

  private async cancelTurn(taskId: string): Promise<TaskHandle> {
    const record = this.tasks.get(taskId)
    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    if (stored === undefined && record === undefined) throw new Error(`Task is not loaded: ${taskId}`)
    const next = { ...(record?.handle ?? { taskId, projectId: stored?.projectId ?? "", kind: stored?.kind ?? "turn", status: "cancelled" as const }), status: "cancelled" as const }
    if (record !== undefined) {
      this.tasks.set(taskId, { ...record, handle: next, status: "cancelled" })
      record.abortController?.abort("Cancelled by user")
    }
    if (runtime !== undefined) await runtime.persistenceUpdateTask(taskId, "cancelled")
    return next
  }

  private failure(requestId: string, error: BackendError): ClientResponse {
    return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false, error }
  }

  private async ensureHistoryCheckoutAvailable(projectId: string): Promise<void> {
    await this.preemptAutomaticEvolution(projectId)
    const activeTask = [...this.tasks.values()].find((task) => (
      task.handle.projectId === projectId
      && (task.status === "created" || task.status === "running" || task.status === "committing")
    ))
    if (activeTask !== undefined) {
      throw new FacadeOperationError("history_busy", "History checkout is busy while a task is running")
    }
  }

  private async syncSettingsExtractionReview(
    taskId: string,
    current: TaskRecord,
    handle: TaskHandle,
    turnInput: TurnOrchestratorInput,
    orchestrator: import("../application/index.js").TurnOrchestrator,
    abortController: AbortController,
  ): Promise<void> {
    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    const status: TaskStatus = "waiting_for_review"
    this.tasks.set(taskId, {
      ...current,
      handle: { ...handle, status },
      status,
      turnInput,
      orchestrator,
      abortController,
    })
    runtimeLog("info", "backend-facade", "turn.settings_extraction_review", {
      taskId,
      proposalCount: stored?.error !== undefined && typeof stored.error === "object" && stored.error !== null && "proposalCount" in stored.error
        ? stored.error.proposalCount
        : undefined,
      lastPhase: stored?.lastPhase,
    })
  }

  private errorFrom(error: unknown): BackendError {
    const message = error instanceof Error ? error.message : String(error)
    let code: BackendError["code"] = "storage_failure"
    let recoverable = true
    if (isZodError(error)) {
      code = "validation_error"
    } else if (error instanceof FacadeOperationError) {
      code = error.code
      recoverable = error.recoverable
    } else if (error instanceof TurnBudgetExceededError) {
      code = "budget_exhausted"
    } else if (error instanceof DeepSeekModelError) {
      code = "model_failure"
    } else if (error instanceof ProjectLifecycleError) {
      code = "workspace_failure"
    } else if (error instanceof ChapterNotFoundError) {
      code = "chapter_not_found"
    } else if (error instanceof RevisionNotFoundError) {
      code = "revision_not_found"
    } else if (error instanceof RevisionConflictError) {
      code = "revision_conflict"
    } else if (error instanceof RevisionInvalidStateError || error instanceof SynopsisInvalidStateError) {
      code = "revision_invalid_state"
    }
    return this.createError(code, message, recoverable)
  }

  private createError(code: BackendError["code"], message: string, recoverable: boolean): BackendError {
    return backendErrorSchema.parse({
      code,
      message,
      recoverable,
      diagnosticId: this.container.createId(),
      details: { errorDigest: digest(message) },
    })
  }
}

class FacadeOperationError extends Error {
  public constructor(
    public readonly code: BackendError["code"],
    message: string,
    public readonly recoverable = true,
  ) {
    super(message)
    this.name = "FacadeOperationError"
  }
}

function toTaskPhaseRunSnapshot(run: StoredPhaseRun): Readonly<Record<string, unknown>> {
  return {
    phaseRunId: run.phaseRunId,
    phase: run.phase,
    status: run.status,
    attempt: run.attempt,
    ...(run.result === undefined ? {} : { result: run.result }),
    usage: run.usage,
    startedAtMs: run.startedAtMs,
    ...(run.finishedAtMs === undefined ? {} : { finishedAtMs: run.finishedAtMs }),
  }
}

function toPublicTaskSnapshot(task: TaskRecord): Readonly<Record<string, unknown>> {
  return {
    handle: task.handle,
    status: task.status,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
  }
}

function requireResolvedApiKey(apiKey: string | undefined): string {
    if (apiKey === undefined) throw new Error("Model credential was not resolved by the desktop credential vault")
    return apiKey
  }

function buildAutomaticEvolutionInstruction(triggerTaskId: string): string {
  return [
    `正式章节任务 ${triggerTaskId} 已提交，执行一次由产品自动触发的无正文世界演化。`,
    "从已提交演化前沿中选择需要推进的局部，并先读取其规则、时空锚点、当前状态和可达影响。",
    "只依据当前单一上下文链、实际读取资料和本轮新形成内容推进；未知处可以保留未知或作最小一致补全。",
    "更新普通世界图、时空结算和演化前沿，但不得生成章节正文，也不得围绕固定领域类型机械扩展。",
  ].join("\n")
}

function isZodError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "issues" in error
    && Array.isArray(error.issues)
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined
  const propertyValue = (value as Record<string, unknown>)[property]
  return typeof propertyValue === "string" ? propertyValue : undefined
}

function readFacadeBlockedMetrics(error: unknown): readonly ("model_calls" | "input_tokens" | "output_tokens" | "wall_time")[] {
  if (typeof error !== "object" || error === null || !("blockedMetrics" in error) || !Array.isArray(error.blockedMetrics)) return []
  return error.blockedMetrics.filter((metric): metric is "model_calls" | "input_tokens" | "output_tokens" | "wall_time" => (
    metric === "model_calls" || metric === "input_tokens" || metric === "output_tokens" || metric === "wall_time"
  ))
}

function readFacadeInterruptionTimestamp(error: unknown): number {
  if (typeof error !== "object" || error === null || !("interruptedAtMs" in error)) return Number.MAX_SAFE_INTEGER
  const value = error.interruptedAtMs
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER
}

function readRecoverablePhaseInput(value: unknown): {
  userInput: string
  chapterSequence: number
  allowWorkspaceChapterReads: boolean
  presentation?: TurnOrchestratorInput["presentation"]
  chapterIntent?: TurnOrchestratorInput["chapterIntent"]
} {
  if (typeof value !== "object" || value === null) throw new Error("The task checkpoint has invalid phase input")
  const record = value as Record<string, unknown>
  if (typeof record.userInput !== "string" || typeof record.chapterSequence !== "number") {
    throw new Error("The task checkpoint is missing turn input")
  }
  return {
    userInput: record.userInput,
    chapterSequence: record.chapterSequence,
    allowWorkspaceChapterReads: record.allowWorkspaceChapterReads !== false,
    ...(record.presentation === undefined ? {} : { presentation: record.presentation as TurnOrchestratorInput["presentation"] }),
    ...(record.chapterIntent === undefined
      ? {}
      : { chapterIntent: record.chapterIntent as TurnOrchestratorInput["chapterIntent"] }),
  }
}

function readRecoverableTaskConfig(value: unknown): {
  maxModelCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  deadlineAtMs: number
  executionOrigin?: TurnOrchestratorInput["executionOrigin"]
} {
  if (typeof value !== "object" || value === null || !("budget" in value)) {
    throw new Error("The task checkpoint is missing execution budget")
  }
  const budget = (value as { budget?: unknown }).budget
  if (typeof budget !== "object" || budget === null) throw new Error("The task checkpoint has invalid execution budget")
  const record = budget as Record<string, unknown>
  const maxModelCalls = readPositiveNumber(record.maxCalls, "maxModelCalls")
  const maxInputTokens = readPositiveNumber(record.maxInputTokens, "maxInputTokens")
  const maxOutputTokens = readPositiveNumber(record.maxOutputTokens, "maxOutputTokens")
  const deadlineAtMs = readPositiveNumber(record.deadlineAtMs, "deadlineAtMs")
  return {
    maxModelCalls,
    maxInputTokens,
    maxOutputTokens,
    deadlineAtMs,
    ...readExecutionOrigin(value),
  }
}

function readExecutionOrigin(value: object): Readonly<{ executionOrigin?: TurnOrchestratorInput["executionOrigin"] }> {
  if (!("executionOrigin" in value)) return {}
  const origin = value.executionOrigin
  if (typeof origin !== "object" || origin === null || !("kind" in origin)) return {}
  if (origin.kind === "user") return { executionOrigin: { kind: "user" } }
  if (origin.kind !== "automatic_evolution") return {}
  const triggerTaskId = "triggerTaskId" in origin && typeof origin.triggerTaskId === "string"
    ? origin.triggerTaskId
    : undefined
  return {
    executionOrigin: {
      kind: "automatic_evolution",
      ...(triggerTaskId === undefined ? {} : { triggerTaskId }),
    },
  }
}

function readPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`The task checkpoint has invalid ${name}`)
  return value
}

function displayNameFromWorkspaceRoot(workspaceRootRef: string): string {
  const trimmed = workspaceRootRef.replace(/[\\/]+$/u, "")
  const segments = trimmed.split(/[\\/]/u).filter((part) => part.length > 0)
  return segments.at(-1) ?? "未命名世界"
}
