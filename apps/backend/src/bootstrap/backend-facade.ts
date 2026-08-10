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
  GRAPH_NEIGHBORHOOD_MAX_ANCHORS,
  phaseRequestEnvelopeSchema,
  projectCreatePayloadSchema,
  graphNeighborhoodPayloadSchema,
  modelListPayloadSchema,
  modelProfilesReadPayloadSchema,
  modelProfilesSavePayloadSchema,
  projectSettingsReadPayloadSchema,
  projectSettingsSavePayloadSchema,
  projectWorkspacePayloadSchema,
  taskPayloadSchema,
  turnRecoverableTasksPayloadSchema,
  turnResumePayloadSchema,
  turnStartPayloadSchema,
  workspaceReadPayloadSchema,
  workspaceSavePayloadSchema,
  worldEvolvePayloadSchema,
  worldQueryPayloadSchema,
} from "@worldseed/contracts"
import { digest } from "../core/index.js"
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
}>

export class BackendFacade {
  private readonly tasks = new Map<string, TaskRecord>()

  public constructor(private readonly container: BackendContainer) {}

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
        await runtime.saveMarkdown(payload.relativePath, payload.content)
        return { relativePath: payload.relativePath, saved: true }
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
    model?: ModelSelection | undefined
    maxModelCalls?: number | undefined
  }): Promise<TaskHandle> {
    return this.startWorkflow({
      workflow: "turn",
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      userInput: payload.userInput,
      chapterSequence: payload.chapterSequence,
      allowWorkspaceChapterReads: true,
      ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
    })
  }

  private async startWorkflow(input: Readonly<{
    workflow: "turn" | "query" | "evolution"
    projectId: ProjectId
    workspaceRootRef: string
    userInput: string
    chapterSequence: number
    allowWorkspaceChapterReads: boolean
    presentation?: TurnOrchestratorInput["presentation"]
    model?: ModelSelection
    maxModelCalls?: number
    deadlineMs?: number
    maxRetrievalRounds?: number
  }>): Promise<TaskHandle> {
    const model = this.resolveModel(input.model)
    const modelInfo = model.info
    if (modelInfo?.available === false) {
      throw new Error(modelInfo.detail ?? `AI model is unavailable: ${modelInfo.provider}/${modelInfo.model}`)
    }
    const runtime = await this.container.getRuntime(input.projectId, input.workspaceRootRef)
    const projectSettings = await runtime.readSettings()
    const taskId = this.container.createId()
    const abortController = new AbortController()
    const handle: TaskHandle = {
      taskId,
      projectId: input.projectId,
      kind: input.workflow as TaskKind,
      status: "created",
    }
    this.tasks.set(taskId, { handle, status: "created", abortController })
    runtimeLog("debug", "backend-facade", `${input.workflow}.accepted`, {
      taskId,
      projectId: input.projectId,
      chapterSequence: input.chapterSequence,
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
      chapterSequence: input.chapterSequence,
      allowWorkspaceChapterReads: input.allowWorkspaceChapterReads,
      ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
      taskId,
      maxModelCalls: input.maxModelCalls ?? projectSettings.execution.maxModelCalls,
      maxContextTokens: Math.floor(
        projectSettings.execution.contextWindowTokens
          * projectSettings.execution.contextCompactionThresholdRatio,
      ),
      deadlineMs: input.deadlineMs ?? projectSettings.execution.maxWallTimeMs,
      maxRetrievalRounds: input.maxRetrievalRounds ?? projectSettings.execution.maxRetrievalRounds,
      projectSettings,
    }
    const storedTurnInput = turnInput as TurnOrchestratorInput
    this.tasks.set(taskId, { handle, status: "created", turnInput: storedTurnInput, orchestrator, abortController })
    let markPrepared: (() => void) | undefined
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve })
    const execution = orchestrator.execute(turnInput, {
      onPrepared: () => { markPrepared?.() },
      signal: abortController.signal,
    })
    void execution.then(
      (result) => {
        const current = this.tasks.get(taskId)
        if (current?.abortController !== abortController || current.status === "cancelled") return
        this.tasks.set(taskId, { handle: { ...handle, status: "completed" }, status: "completed", result, turnInput: storedTurnInput, orchestrator, abortController })
        runtimeLog("info", "backend-facade", `${input.workflow}.completed`, {
          taskId,
          ...(result.kind === "turn" ? { chapterPath: result.chapterPath } : {}),
          resultKind: result.kind,
          modelCalls: result.modelCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        })
      },
      (error: unknown) => {
        const current = this.tasks.get(taskId)
        if (current?.abortController !== abortController || current.status === "cancelled") return
        const backendError = this.errorFrom(error)
        this.tasks.set(taskId, { handle: { ...handle, status: "awaiting_user_decision" }, status: "awaiting_user_decision", error: backendError, turnInput: storedTurnInput, orchestrator, abortController })
        runtimeLog("warn", "backend-facade", `${input.workflow}.interrupted`, {
          taskId,
          error: errorDetails(error),
        })
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
      thinkingModeEnabled: selection.thinkingModeEnabled,
      reasoningEffort: selection.reasoningEffort,
      jsonModeEnabled: selection.jsonModeEnabled,
    })
  }

  private async readTask(taskId: string): Promise<unknown> {
    const inMemory = this.tasks.get(taskId)
    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    const phaseRuns = await this.readPhaseRuns(runtime, taskId)
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
        phaseRuns,
      }
    }
    if (inMemory?.status === "completed" || inMemory?.status === "failed" || inMemory?.status === "awaiting_user_decision" || inMemory?.status === "paused" || inMemory?.status === "cancelled") {
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

  private async resumeTurn(payload: { taskId: string; mode: "continue" | "retry_phase"; model?: { baseUrl: string; model: string; credentialRef: string; apiKey?: string | undefined; thinkingModeEnabled?: boolean; reasoningEffort?: "low" | "high" | "max"; jsonModeEnabled?: boolean } | undefined; maxModelCalls?: number | undefined; deadlineMs?: number | undefined; maxRetrievalRounds?: number | undefined }): Promise<TaskHandle> {
    const selectedModel = payload.model === undefined
      ? undefined
      : this.container.createModelFromSelection({
        baseUrl: payload.model.baseUrl,
        model: payload.model.model,
        apiKey: requireResolvedApiKey(payload.model.apiKey),
        ...(payload.model.thinkingModeEnabled === undefined ? {} : { thinkingModeEnabled: payload.model.thinkingModeEnabled }),
        ...(payload.model.reasoningEffort === undefined ? {} : { reasoningEffort: payload.model.reasoningEffort }),
        ...(payload.model.jsonModeEnabled === undefined ? {} : { jsonModeEnabled: payload.model.jsonModeEnabled }),
      })
    const record = await this.loadResumableTask(payload.taskId, selectedModel)
    const input: TurnOrchestratorInput = {
      ...record.turnInput,
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
      ...(payload.deadlineMs === undefined ? {} : { deadlineMs: payload.deadlineMs }),
      ...(payload.maxRetrievalRounds === undefined ? {} : { maxRetrievalRounds: payload.maxRetrievalRounds }),
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
        if (current?.abortController !== abortController || current.status === "cancelled") return
        this.tasks.set(payload.taskId, { ...record, handle: { ...handle, status: "completed" }, status: "completed", result, abortController })
      },
      async (error: unknown) => {
        const current = this.tasks.get(payload.taskId)
        if (current?.abortController !== abortController || current.status === "cancelled") return
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
      },
    )
    return handle
  }

  private async loadResumableTask(taskId: string, model?: import("../application/index.js").AIModelPort): Promise<TaskRecord & { orchestrator: import("../application/index.js").TurnOrchestrator; turnInput: TurnOrchestratorInput }> {
    const existing = this.tasks.get(taskId)
    if (model === undefined && existing?.orchestrator !== undefined && existing.turnInput !== undefined) return existing as TaskRecord & { orchestrator: import("../application/index.js").TurnOrchestrator; turnInput: TurnOrchestratorInput }

    const runtime = this.container.getCurrentRuntime()
    const stored = await runtime?.taskScopes.findTask(taskId)
    if (runtime === undefined || stored === undefined) {
      throw new Error("The task is not loaded in the current project runtime")
    }
    if (stored.status !== "awaiting_user_decision" && stored.status !== "paused") {
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
      taskId: stored.taskId,
      turnId: latestRequest.turnId,
      scopeId: stored.scopeId,
      maxModelCalls: config.maxModelCalls,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      deadlineMs: Math.max(1, config.deadlineAtMs - stored.createdAtMs),
      maxRetrievalRounds: projectSettings.execution.maxRetrievalRounds,
      maxContextTokens: Math.floor(
        projectSettings.execution.contextWindowTokens * projectSettings.execution.contextCompactionThresholdRatio,
      ),
      projectSettings,
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
    if (stored?.status !== "awaiting_user_decision" && record?.status !== "awaiting_user_decision") {
      throw new Error("Only a task waiting for a decision can be paused")
    }
    await runtime?.taskScopes.findTask(taskId)
    const next = { ...(record?.handle ?? { taskId, projectId: stored?.projectId ?? "", kind: stored?.kind ?? "turn", status: "paused" as const }), status: "paused" as const }
    if (record !== undefined) this.tasks.set(taskId, { ...record, handle: next, status: "paused" })
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

  private errorFrom(error: unknown): BackendError {
    const message = error instanceof Error ? error.message : String(error)
    let code: BackendError["code"] = "storage_failure"
    let recoverable = true
    if (isZodError(error)) {
      code = "validation_error"
    } else if (message.includes("model") || message.includes("DeepSeek")) {
      code = "model_failure"
    } else if (message.includes("budget") || message.includes("deadline")) {
      code = "budget_exhausted"
    } else if (message.includes("workspace") || message.includes("Markdown")) {
      code = "workspace_failure"
    } else if (message.includes("different project") || message.includes("scope")) {
      code = "scope_violation"
    } else if (message.includes("not implemented")) {
      code = "validation_error"
      recoverable = false
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
  if (apiKey === undefined) throw new Error("DeepSeek credential was not resolved by the desktop credential vault")
  return apiKey
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

function readRecoverablePhaseInput(value: unknown): {
  userInput: string
  chapterSequence: number
  allowWorkspaceChapterReads: boolean
  presentation?: TurnOrchestratorInput["presentation"]
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
  }
}

function readRecoverableTaskConfig(value: unknown): {
  maxModelCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  deadlineAtMs: number
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
  }
}

function readPositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`The task checkpoint has invalid ${name}`)
  return value
}
