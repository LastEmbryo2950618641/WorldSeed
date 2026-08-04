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
  projectCreatePayloadSchema,
  graphNeighborhoodPayloadSchema,
  projectWorkspacePayloadSchema,
  taskPayloadSchema,
  turnStartPayloadSchema,
  workspaceReadPayloadSchema,
  workspaceSavePayloadSchema,
} from "@worldseed/contracts"
import { digest } from "../core/index.js"
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
    try {
      const data = await this.dispatch(request)
      return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, data }
    } catch (error) {
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
      case "graph.neighborhood": {
        const payload = graphNeighborhoodPayloadSchema.parse(request.payload)
        const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
        return runtime.readGraphNeighborhood({
          anchorIds: payload.anchorIds,
          direction: payload.direction,
          maxDepth: payload.maxDepth,
          maxNodes: payload.maxNodes,
          maxLinks: payload.maxLinks,
        })
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
    maxModelCalls?: number | undefined
  }): Promise<TaskHandle> {
    const runtime = await this.container.getRuntime(payload.projectId, payload.workspaceRootRef)
    const taskId = this.container.createId()
    const handle: TaskHandle = {
      taskId,
      projectId: payload.projectId,
      kind: "turn",
      status: "created",
    }
    this.tasks.set(taskId, { handle, status: "created" })
    const orchestrator = runtime.createTurnOrchestrator(this.container.model, this.container.createId, this.container.now)
    const turnInput = {
      projectId: payload.projectId,
      workspaceRootRef: payload.workspaceRootRef,
      internalStore: runtime.internalStore,
      userInput: payload.userInput,
      chapterSequence: payload.chapterSequence,
      taskId,
      ...(payload.maxModelCalls === undefined ? {} : { maxModelCalls: payload.maxModelCalls }),
    }
    void orchestrator.execute(turnInput).then(
      (result) => {
        this.tasks.set(taskId, { handle: { ...handle, status: "completed" }, status: "completed", result })
      },
      (error: unknown) => {
        const backendError = this.errorFrom(error)
        this.tasks.set(taskId, { handle: { ...handle, status: "failed" }, status: "failed", error: backendError })
      },
    )
    return handle
  }

  private async readTask(taskId: string): Promise<unknown> {
    const inMemory = this.tasks.get(taskId)
    if (inMemory?.status === "completed" || inMemory?.status === "failed") {
      return inMemory
    }
    const stored = await this.container.getCurrentRuntime()?.taskScopes.findTask(taskId)
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
      }
    }
    if (inMemory !== undefined) return inMemory
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
