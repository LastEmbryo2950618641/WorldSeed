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
  TaskHandle,
  TaskStatus,
} from "@worldseed/contracts"
import {
  GRAPH_NEIGHBORHOOD_MAX_ANCHORS,
  projectCreatePayloadSchema,
  graphNeighborhoodPayloadSchema,
  modelListPayloadSchema,
  modelProfilesReadPayloadSchema,
  modelProfilesSavePayloadSchema,
  projectSettingsReadPayloadSchema,
  projectSettingsSavePayloadSchema,
  projectWorkspacePayloadSchema,
  taskPayloadSchema,
  turnStartPayloadSchema,
  workspaceReadPayloadSchema,
  workspaceSavePayloadSchema,
} from "@worldseed/contracts"
import { digest } from "../core/index.js"
import { errorDetails, runtimeLog } from "../infrastructure/diagnostics/index.js"
import type { TurnExecutionResult } from "../application/index.js"
import type { BackendContainer } from "./container.js"

type TaskRecord = Readonly<{
  handle: TaskHandle
  status: TaskStatus
  result?: TurnExecutionResult
  error?: BackendError
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
      case "turn.status": {
        const payload = taskPayloadSchema.parse(request.payload)
        return this.readTask(payload.taskId)
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
    model?: { baseUrl: string; model: string; credentialRef: string; apiKey?: string | undefined; thinkingModeEnabled?: boolean; reasoningEffort?: "low" | "high" | "max"; jsonModeEnabled?: boolean } | undefined
    maxModelCalls?: number | undefined
  }): Promise<TaskHandle> {
    const model = payload.model === undefined
      ? this.container.model
      : this.container.createModelFromSelection({
        baseUrl: payload.model.baseUrl,
        model: payload.model.model,
        apiKey: requireResolvedApiKey(payload.model.apiKey),
        ...(payload.model.thinkingModeEnabled === undefined ? {} : { thinkingModeEnabled: payload.model.thinkingModeEnabled }),
        ...(payload.model.reasoningEffort === undefined ? {} : { reasoningEffort: payload.model.reasoningEffort }),
        ...(payload.model.jsonModeEnabled === undefined ? {} : { jsonModeEnabled: payload.model.jsonModeEnabled }),
      })
    const modelInfo = model.info
    if (modelInfo?.available === false) {
      throw new Error(modelInfo.detail ?? `AI model is unavailable: ${modelInfo.provider}/${modelInfo.model}`)
    }
    const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
    const projectSettings = await runtime.readSettings()
    const taskId = this.container.createId()
    const handle: TaskHandle = {
      taskId,
      projectId: payload.projectId,
      kind: "turn",
      status: "created",
    }
    this.tasks.set(taskId, { handle, status: "created" })
    runtimeLog("debug", "backend-facade", "turn.accepted", {
      taskId,
      projectId: payload.projectId,
      chapterSequence: payload.chapterSequence,
      modelProvider: modelInfo?.provider ?? "unknown",
      modelName: modelInfo?.model ?? "unknown",
      maxModelCalls: payload.maxModelCalls ?? projectSettings.execution.maxModelCalls,
    })
    const orchestrator = runtime.createTurnOrchestrator(model, this.container.createId, this.container.now)
    const turnInput = {
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      internalStore: runtime.internalStore,
      userInput: payload.userInput,
      chapterSequence: payload.chapterSequence,
      ...(payload.presentation === undefined ? {} : { presentation: payload.presentation }),
      taskId,
      maxModelCalls: payload.maxModelCalls ?? projectSettings.execution.maxModelCalls,
      maxContextTokens: Math.floor(
        projectSettings.execution.contextWindowTokens
          * projectSettings.execution.contextCompactionThresholdRatio,
      ),
      deadlineMs: projectSettings.execution.maxWallTimeMs,
      maxRetrievalRounds: projectSettings.execution.maxRetrievalRounds,
      projectSettings,
    }
    void orchestrator.execute(turnInput).then(
      (result) => {
        this.tasks.set(taskId, { handle: { ...handle, status: "completed" }, status: "completed", result })
        runtimeLog("info", "backend-facade", "turn.completed", {
          taskId,
          chapterPath: result.chapterPath,
          modelCalls: result.modelCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        })
      },
      (error: unknown) => {
        const backendError = this.errorFrom(error)
        this.tasks.set(taskId, { handle: { ...handle, status: "failed" }, status: "failed", error: backendError })
        runtimeLog("error", "backend-facade", "turn.failed", {
          taskId,
          error: errorDetails(error),
        })
      },
    )
    return handle
  }

  private async readTask(taskId: string): Promise<unknown> {
    const inMemory = this.tasks.get(taskId)
    const runtime = this.container.getCurrentRuntime()
    const phaseRuns = runtime === undefined ? [] : await runtime.listPhaseRuns(taskId)
    if (inMemory?.status === "completed" || inMemory?.status === "failed") {
      return { ...inMemory, phaseRuns }
    }
    const stored = await runtime?.taskScopes.findTask(taskId)
    if (stored !== undefined) {
      return {
        handle: {
          taskId: stored.taskId,
          projectId: stored.projectId,
          kind: stored.kind,
          status: stored.status,
        },
        status: stored.status,
        lastPhase: stored.lastPhase,
        phaseRuns,
      }
    }
    if (inMemory !== undefined) return { ...inMemory, phaseRuns }
    throw new Error(`Task is not loaded in the current backend runtime: ${taskId}`)
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
