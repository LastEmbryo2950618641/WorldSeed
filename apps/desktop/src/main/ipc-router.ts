import { dialog, ipcMain, type BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import {
  chapterReviewRevisionPayloadSchema,
  chapterRevisionConversationSendPayloadSchema,
  chapterSubmitRevisionPayloadSchema,
  clientRequestSchema,
  modelCatalogRequestSchema,
  modelProfilesDraftSavePayloadSchema,
  modelProfilesReadPayloadSchema,
  PROTOCOL_VERSION,
  synopsisBeginTurnPayloadSchema,
  synopsisConversationSendPayloadSchema,
  synopsisConversationRefreshChoicesPayloadSchema,
  turnResumePayloadSchema,
  turnStartPayloadSchema,
  worldEvolvePayloadSchema,
  worldQueryPayloadSchema,
  type ClientRequest,
  type ModelProfilesReadResult,
} from "@worldseed/contracts"

import type { BackendProcess } from "./backend-process.js"
import type { DesktopModelProfiles } from "../preload/worldseed-bridge.js"
import type { FileCredentialVault } from "./credential-vault.js"
import { resolveModelCredential } from "./model-credential-resolution.js"
import { errorDetails, runtimeLog } from "@worldseed/backend"
import {
  addWorkDirectory,
  readAppSettings,
  removeWorkDirectory,
  setActiveWorkDirectory,
  toAppSettingsReadResult,
} from "./app-settings.js"
import { allocateUniqueBookPath } from "./book-path.js"

const MODEL_CREDENTIAL_PAYLOAD_SCHEMAS = {
  "turn.start": turnStartPayloadSchema,
  "turn.resume": turnResumePayloadSchema,
  "world.query": worldQueryPayloadSchema,
  "world.evolve": worldEvolvePayloadSchema,
  "chapter.reviewRevision": chapterReviewRevisionPayloadSchema,
  "chapter.submitRevision": chapterSubmitRevisionPayloadSchema,
  "chapter.revision.conversation.send": chapterRevisionConversationSendPayloadSchema,
  "synopsis.conversation.send": synopsisConversationSendPayloadSchema,
  "synopsis.conversation.refreshChoices": synopsisConversationRefreshChoicesPayloadSchema,
  "synopsis.conversation.beginTurn": synopsisBeginTurnPayloadSchema,
} as const

type ModelCredentialMethod = keyof typeof MODEL_CREDENTIAL_PAYLOAD_SCHEMAS

export function registerIpcRouter(
  backend: BackendProcess,
  window: BrowserWindow,
  vault: FileCredentialVault,
  applicationDataRoot: string,
): void {
  ipcMain.handle("worldseed:request", async (_event, request: unknown) => {
    const parsed = clientRequestSchema.parse(request)
    const startedAtMs = Date.now()
    const logLevel = parsed.method === "turn.status" ? "debug" : "info"
    runtimeLog(logLevel, "ipc-router", "request.received", {
      requestId: parsed.requestId,
      method: parsed.method,
    })
    try {
      const response = await backend.invoke(await resolveRequest(parsed, vault))
      runtimeLog(response.ok ? logLevel : "error", "ipc-router", "request.completed", {
        requestId: parsed.requestId,
        method: parsed.method,
        ok: response.ok,
        elapsedMs: Date.now() - startedAtMs,
        ...(response.ok ? {} : { error: response.error }),
      })
      return response
    } catch (error) {
      runtimeLog("error", "ipc-router", "request.failed", {
        requestId: parsed.requestId,
        method: parsed.method,
        elapsedMs: Date.now() - startedAtMs,
        error: errorDetails(error),
      })
      throw error
    }
  })
  ipcMain.handle("worldseed:model-profiles:read", () => readModelProfiles(backend, vault))
  ipcMain.handle("worldseed:model-profiles:save", (_event, input: unknown) => saveModelProfiles(backend, vault, input))
  ipcMain.handle("worldseed:model-list", (_event, input: unknown) => listModels(backend, vault, input))
  ipcMain.handle("worldseed:app-settings:read", async () => {
    const stored = await readAppSettings(applicationDataRoot)
    return toAppSettingsReadResult(stored)
  })
  ipcMain.handle("worldseed:app-settings:save", async (_event, input: unknown) => {
    const directoryPath = parseDirectoryPathPayload(input, "workDirectory")
    const saved = await addWorkDirectory(applicationDataRoot, directoryPath)
    return toAppSettingsReadResult(saved)
  })
  ipcMain.handle("worldseed:app-settings:work-directory:add", async (_event, input: unknown) => {
    const directoryPath = parseDirectoryPathPayload(input, "directoryPath")
    const saved = await addWorkDirectory(applicationDataRoot, directoryPath)
    return toAppSettingsReadResult(saved)
  })
  ipcMain.handle("worldseed:app-settings:work-directory:set-active", async (_event, input: unknown) => {
    const directoryPath = parseDirectoryPathPayload(input, "directoryPath")
    const saved = await setActiveWorkDirectory(applicationDataRoot, directoryPath)
    return toAppSettingsReadResult(saved)
  })
  ipcMain.handle("worldseed:app-settings:work-directory:remove", async (_event, input: unknown) => {
    const payload = parseRemoveWorkDirectoryPayload(input)
    const saved = await removeWorkDirectory(applicationDataRoot, payload)
    return toAppSettingsReadResult(saved)
  })
  ipcMain.handle("worldseed:book-path:allocate", async (_event, input: unknown) => {
    const workDirectory = parseWorkDirectoryPayload(input)
    return allocateUniqueBookPath(workDirectory)
  })
  ipcMain.handle("worldseed:select-directory", async (_event, input: unknown) => {
    const options = parseSelectDirectoryPayload(input)
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: options.title ?? "选择目录",
      ...(options.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
}

export function unregisterIpcRouter(): void {
  ipcMain.removeHandler("worldseed:request")
  ipcMain.removeHandler("worldseed:model-profiles:read")
  ipcMain.removeHandler("worldseed:model-profiles:save")
  ipcMain.removeHandler("worldseed:model-list")
  ipcMain.removeHandler("worldseed:app-settings:read")
  ipcMain.removeHandler("worldseed:app-settings:save")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:add")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:set-active")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:remove")
  ipcMain.removeHandler("worldseed:book-path:allocate")
  ipcMain.removeHandler("worldseed:select-directory")
}

function parseDirectoryPathPayload(input: unknown, key: "directoryPath" | "workDirectory"): string {
  if (input === null || typeof input !== "object" || !(key in input)) {
    throw new Error("无效的目录参数")
  }
  const directoryPath = (input as Record<string, unknown>)[key]
  if (typeof directoryPath !== "string" || directoryPath.trim().length === 0) {
    throw new Error("目录路径不能为空")
  }
  return directoryPath.trim()
}

function parseWorkDirectoryPayload(input: unknown): string {
  return parseDirectoryPathPayload(input, "workDirectory")
}

function parseRemoveWorkDirectoryPayload(input: unknown): Readonly<{
  directoryPath: string
  mode: "keep_data" | "include_data"
}> {
  if (input === null || typeof input !== "object") throw new Error("无效的移除参数")
  const payload = input as { directoryPath?: unknown; mode?: unknown }
  const directoryPath = typeof payload.directoryPath === "string" ? payload.directoryPath.trim() : ""
  if (directoryPath.length === 0) throw new Error("目录路径不能为空")
  if (payload.mode !== "keep_data" && payload.mode !== "include_data") {
    throw new Error("无效的移除模式")
  }
  return { directoryPath, mode: payload.mode }
}

function parseSelectDirectoryPayload(input: unknown): { title?: string; defaultPath?: string } {
  if (input === undefined || input === null) return {}
  if (typeof input !== "object") throw new Error("无效的目录选择参数")
  const payload = input as { title?: unknown; defaultPath?: unknown }
  return {
    ...(typeof payload.title === "string" && payload.title.length > 0 ? { title: payload.title } : {}),
    ...(typeof payload.defaultPath === "string" && payload.defaultPath.length > 0
      ? { defaultPath: payload.defaultPath }
      : {}),
  }
}

async function readModelProfiles(backend: BackendProcess, vault: FileCredentialVault): Promise<DesktopModelProfiles> {
  modelProfilesReadPayloadSchema.parse({})
  const stored = await invokeData<ModelProfilesReadResult>(backend, "model.profiles.read", {})
  return {
    profiles: await Promise.all(stored.profiles.map(async (profile) => ({
      ...profile,
      apiKey: "",
      hasApiKey: await vault.has(profile.credentialRef),
    }))),
    activeProfileId: stored.activeProfileId,
  }
}

async function saveModelProfiles(backend: BackendProcess, vault: FileCredentialVault, rawInput: unknown): Promise<DesktopModelProfiles> {
  const input = modelProfilesDraftSavePayloadSchema.parse(rawInput)
  await Promise.all(input.profiles.map(async (profile) => {
    if (profile.apiKey.trim().length > 0) await vault.set(profile.credentialRef, profile.apiKey.trim())
    else if (!profile.hasApiKey) await vault.remove(profile.credentialRef)
  }))
  await invokeData(backend, "model.profiles.save", {
    profiles: input.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      credentialRef: profile.credentialRef,
      apiProtocol: profile.apiProtocol,
      contextWindowTokens: profile.contextWindowTokens,
      thinkingModeEnabled: profile.thinkingModeEnabled,
      reasoningEffort: profile.reasoningEffort,
      jsonModeEnabled: profile.jsonModeEnabled,
      disableResponseStorage: profile.disableResponseStorage,
      serviceTier: profile.serviceTier,
    })),
    activeProfileId: input.activeProfileId,
  })
  return readModelProfiles(backend, vault)
}

async function listModels(backend: BackendProcess, vault: FileCredentialVault, rawInput: unknown): Promise<unknown> {
  const input = modelCatalogRequestSchema.parse(rawInput)
  const apiKey = input.apiKey?.trim().length === 0 || input.apiKey === undefined ? await vault.get(input.credentialRef) : input.apiKey
  if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("DeepSeek API Key is not configured")
  return invokeData(backend, "model.list", { baseUrl: input.baseUrl, apiKey })
}

async function resolveRequest(request: ClientRequest, vault: FileCredentialVault): Promise<ClientRequest> {
  if (process.env.WORLDSEED_FAKE_MODEL?.trim() === "1") {
    return stripModelSelection(request)
  }
  if (!isModelCredentialMethod(request.method)) return request
  const schema = MODEL_CREDENTIAL_PAYLOAD_SCHEMAS[request.method]
  const payload = schema.parse(request.payload)
  return { ...request, payload: await resolveModelCredential(payload, vault) }
}

function isModelCredentialMethod(method: ClientRequest["method"]): method is ModelCredentialMethod {
  return Object.hasOwn(MODEL_CREDENTIAL_PAYLOAD_SCHEMAS, method)
}

function stripModelSelection(request: ClientRequest): ClientRequest {
  if (request.payload === undefined || typeof request.payload !== "object" || request.payload === null) return request
  if (!("model" in request.payload)) return request
  const { model: _model, ...payload } = request.payload as Record<string, unknown> & { model?: unknown }
  return { ...request, payload }
}

async function invokeData<T>(backend: BackendProcess, method: ClientRequest["method"], payload: unknown): Promise<T> {
  const response = await backend.invoke({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) throw new Error(response.error.message)
  return response.data as T
}
