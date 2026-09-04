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
  saveUpdatePrefs,
  setActiveWorkDirectory,
  toAppSettingsReadResult,
} from "./app-settings.js"
import {
  checkForUpdate,
  defaultUpdatePrefs,
  readLocalAppIdentity,
  shouldAutoCheck,
  type AppUpdatePrefs,
  type UpdateCheckIntervalHours,
} from "./app-update.js"
import {
  cancelActiveUpdateDownload,
  launchInstallerAndQuit,
  resolveUpdateDownloadPath,
  startUpdateInstallerDownload,
} from "./app-update-download.js"
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
  ipcMain.handle("worldseed:request", async (event, request: unknown, options: unknown) => {
    const parsed = clientRequestSchema.parse(request)
    const waitTimeoutMs = parseWaitTimeoutMs(options)
    const startedAtMs = Date.now()
    const logLevel = parsed.method === "turn.status" ? "debug" : "info"
    runtimeLog(logLevel, "ipc-router", "request.received", {
      requestId: parsed.requestId,
      method: parsed.method,
      waitTimeoutMs,
    })
    try {
      const response = await backend.invoke(await resolveRequest(parsed, vault), {
        waitTimeoutMs,
        onWaitTimeout: (info) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("worldseed:backend-wait-timeout", info)
          }
        },
      })
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
  ipcMain.handle("worldseed:backend-continue-wait", (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.trim().length === 0) return false
    return backend.continueWait(requestId)
  })
  ipcMain.handle("worldseed:backend-abandon", (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.trim().length === 0) return false
    return backend.abandon(requestId)
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
  ipcMain.handle("worldseed:app-update:info", async () => {
    const stored = await readAppSettings(applicationDataRoot)
    const local = await readLocalAppIdentity()
    const update = stored?.update ?? defaultUpdatePrefs()
    return { local, update }
  })
  ipcMain.handle("worldseed:app-update:save-prefs", async (_event, input: unknown) => {
    const prefs = parseUpdatePrefsPayload(input)
    const saved = await saveUpdatePrefs(applicationDataRoot, prefs)
    return toAppSettingsReadResult(saved)
  })
  ipcMain.handle("worldseed:app-update:check", async (_event, input: unknown) => {
    const force = input !== null && typeof input === "object" && (input as { force?: unknown }).force === true
    const stored = await readAppSettings(applicationDataRoot)
    const prefs = stored?.update ?? defaultUpdatePrefs()
    if (!force && !shouldAutoCheck(prefs, Date.now())) {
      const local = await readLocalAppIdentity()
      return {
        checkedAtMs: prefs.lastCheckedAtMs ?? Date.now(),
        updateAvailable: false,
        local,
        skipped: true,
        reason: "未到检测间隔",
      }
    }
    const result = await checkForUpdate(prefs)
    await saveUpdatePrefs(applicationDataRoot, {
      ...prefs,
      lastCheckedAtMs: result.checkedAtMs,
    })
    return { ...result, skipped: false }
  })
  ipcMain.handle("worldseed:app-update:download-start", async (event, input: unknown) => {
    const payload = parseUpdateDownloadStartPayload(input)
    const destinationPath = resolveUpdateDownloadPath(
      payload.downloadUrl,
      payload.version,
      payload.buildNumber,
    )
    const handle = await startUpdateInstallerDownload({
      downloadUrl: payload.downloadUrl,
      destinationPath,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("worldseed:app-update:download-progress", progress)
        }
      },
    })
    try {
      const installerPath = await handle.done
      return { ok: true as const, installerPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("已取消下载")
      }
      if (/aborted|取消|AbortError/iu.test(message)) {
        throw new Error("已取消下载")
      }
      throw error instanceof Error ? error : new Error(message)
    }
  })
  ipcMain.handle("worldseed:app-update:download-cancel", async () => {
    cancelActiveUpdateDownload()
    return { ok: true as const }
  })
  ipcMain.handle("worldseed:app-update:install-and-quit", async (_event, input: unknown) => {
    const installerPath = parseInstallerPathPayload(input)
    launchInstallerAndQuit(installerPath)
    return { ok: true as const }
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
  ipcMain.handle("worldseed:select-markdown-files", async (_event, input: unknown) => {
    const options = parseSelectDirectoryPayload(input)
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile", "multiSelections"],
      title: options.title ?? "选择 Markdown 文件",
      filters: [{ name: "Markdown", extensions: ["md"] }],
      ...(options.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
    })
    return result.canceled ? [] : result.filePaths
  })
}

export function unregisterIpcRouter(): void {
  ipcMain.removeHandler("worldseed:request")
  ipcMain.removeHandler("worldseed:backend-continue-wait")
  ipcMain.removeHandler("worldseed:backend-abandon")
  ipcMain.removeHandler("worldseed:model-profiles:read")
  ipcMain.removeHandler("worldseed:model-profiles:save")
  ipcMain.removeHandler("worldseed:model-list")
  ipcMain.removeHandler("worldseed:app-settings:read")
  ipcMain.removeHandler("worldseed:app-settings:save")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:add")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:set-active")
  ipcMain.removeHandler("worldseed:app-settings:work-directory:remove")
  ipcMain.removeHandler("worldseed:app-update:info")
  ipcMain.removeHandler("worldseed:app-update:save-prefs")
  ipcMain.removeHandler("worldseed:app-update:check")
  ipcMain.removeHandler("worldseed:app-update:download-start")
  ipcMain.removeHandler("worldseed:app-update:download-cancel")
  ipcMain.removeHandler("worldseed:app-update:install-and-quit")
  ipcMain.removeHandler("worldseed:book-path:allocate")
  ipcMain.removeHandler("worldseed:select-directory")
  ipcMain.removeHandler("worldseed:select-markdown-files")
}

function parseUpdatePrefsPayload(input: unknown): AppUpdatePrefs {
  if (input === null || typeof input !== "object") throw new Error("无效的更新设置")
  const record = input as Record<string, unknown>
  const updateUrl = typeof record.updateUrl === "string" ? record.updateUrl.trim() : ""
  if (updateUrl.length === 0) throw new Error("更新地址不能为空")
  const interval = record.checkIntervalHours
  const checkIntervalHours = interval === undefined || interval === null || interval === ""
    ? undefined
    : interval === 1 || interval === 2 || interval === 4 || interval === 8 || interval === 24
      ? interval as UpdateCheckIntervalHours
      : undefined
  if (interval !== undefined && interval !== null && interval !== "" && checkIntervalHours === undefined) {
    throw new Error("检测间隔仅支持 1/2/4/8/24 小时")
  }
  const base = defaultUpdatePrefs()
  return {
    updateUrl,
    ...(checkIntervalHours === undefined ? {} : { checkIntervalHours }),
    ...(typeof record.lastCheckedAtMs === "number" ? { lastCheckedAtMs: record.lastCheckedAtMs } : {}),
    compareMode: record.compareMode === "semver" ? "semver" : (base.compareMode ?? "any_change"),
  }
}

function parseUpdateDownloadStartPayload(input: unknown): Readonly<{
  downloadUrl: string
  version: string
  buildNumber: string
}> {
  if (input === null || typeof input !== "object") throw new Error("无效的下载参数")
  const record = input as Record<string, unknown>
  const downloadUrl = typeof record.downloadUrl === "string" ? record.downloadUrl.trim() : ""
  const version = typeof record.version === "string" ? record.version.trim() : ""
  const buildNumber = typeof record.buildNumber === "string"
    ? record.buildNumber.trim()
    : typeof record.buildNumber === "number"
      ? String(record.buildNumber)
      : ""
  if (downloadUrl.length === 0) throw new Error("下载地址不能为空")
  if (version.length === 0) throw new Error("版本号不能为空")
  if (buildNumber.length === 0) throw new Error("构建号不能为空")
  return { downloadUrl, version, buildNumber }
}

function parseInstallerPathPayload(input: unknown): string {
  if (input === null || typeof input !== "object") throw new Error("无效的安装参数")
  const installerPath = (input as { installerPath?: unknown }).installerPath
  if (typeof installerPath !== "string" || installerPath.trim().length === 0) {
    throw new Error("安装包路径不能为空")
  }
  return installerPath.trim()
}

function parseWaitTimeoutMs(options: unknown): number {
  if (options === null || typeof options !== "object") return 600_000
  const raw = (options as { waitTimeoutMs?: unknown }).waitTimeoutMs
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 600_000
  return Math.min(7_200_000, Math.max(60_000, Math.floor(raw)))
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
