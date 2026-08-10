import { dialog, ipcMain, type BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import {
  clientRequestSchema,
  modelCatalogRequestSchema,
  modelProfilesDraftSavePayloadSchema,
  modelProfilesReadPayloadSchema,
  PROTOCOL_VERSION,
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
import { errorDetails, runtimeLog } from "@worldseed/backend"

export function registerIpcRouter(backend: BackendProcess, window: BrowserWindow, vault: FileCredentialVault): void {
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
  ipcMain.handle("worldseed:select-directory", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择 Worldseed 项目目录",
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
}

export function unregisterIpcRouter(): void {
  ipcMain.removeHandler("worldseed:request")
  ipcMain.removeHandler("worldseed:model-profiles:read")
  ipcMain.removeHandler("worldseed:model-profiles:save")
  ipcMain.removeHandler("worldseed:model-list")
  ipcMain.removeHandler("worldseed:select-directory")
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
      thinkingModeEnabled: profile.thinkingModeEnabled,
      reasoningEffort: profile.reasoningEffort,
      jsonModeEnabled: profile.jsonModeEnabled,
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
  if (request.method === "turn.start") {
    const payload = turnStartPayloadSchema.parse(request.payload)
    if (payload.model === undefined || payload.model.apiKey !== undefined) return request
    const apiKey = await vault.get(payload.model.credentialRef)
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("DeepSeek API Key is not configured")
    return { ...request, payload: { ...payload, model: { ...payload.model, apiKey } } }
  }
  if (request.method === "turn.resume") {
    const payload = turnResumePayloadSchema.parse(request.payload)
    if (payload.model === undefined || payload.model.apiKey !== undefined) return request
    const apiKey = await vault.get(payload.model.credentialRef)
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("DeepSeek API Key is not configured")
    return { ...request, payload: { ...payload, model: { ...payload.model, apiKey } } }
  }
  if (request.method === "world.query") {
    const payload = worldQueryPayloadSchema.parse(request.payload)
    if (payload.model === undefined || payload.model.apiKey !== undefined) return request
    const apiKey = await vault.get(payload.model.credentialRef)
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("DeepSeek API Key is not configured")
    return { ...request, payload: { ...payload, model: { ...payload.model, apiKey } } }
  }
  if (request.method === "world.evolve") {
    const payload = worldEvolvePayloadSchema.parse(request.payload)
    if (payload.model === undefined || payload.model.apiKey !== undefined) return request
    const apiKey = await vault.get(payload.model.credentialRef)
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("DeepSeek API Key is not configured")
    return { ...request, payload: { ...payload, model: { ...payload.model, apiKey } } }
  }
  return request
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
