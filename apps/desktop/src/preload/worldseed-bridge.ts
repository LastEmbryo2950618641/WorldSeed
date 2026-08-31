import { ipcRenderer } from "electron"
import {
  clientRequestSchema,
  clientResponseSchema,
  type ClientRequest,
  type ClientResponse,
} from "@worldseed/contracts"
import type {
  ModelListResult,
  ModelProfileDraft,
} from "@worldseed/contracts"

/** Avoid node:os / node:path in sandboxed preload — use env only. */
export function resolveDefaultWorkDirectoryPath(): string {
  const home = (process.env.USERPROFILE ?? process.env.HOME ?? "").replace(/[\\/]+$/u, "")
  if (home.length === 0) return ""
  const separator = home.includes("\\") ? "\\" : "/"
  return `${home}${separator}.worldseed`
}

function normalizeAppSettingsReadResult(raw: unknown): AppSettingsReadResult {
  const fallback = resolveDefaultWorkDirectoryPath()
  if (raw === null || typeof raw !== "object") {
    return { defaultWorkDirectory: fallback, workDirectories: [] }
  }
  const record = raw as {
    defaultWorkDirectory?: unknown
    workDirectories?: unknown
    workDirectory?: unknown
    activeWorkDirectory?: unknown
  }
  const legacyDirectory = typeof record.workDirectory === "string" ? record.workDirectory.trim() : ""
  const workDirectories = Array.isArray(record.workDirectories)
    ? record.workDirectories.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : legacyDirectory.length > 0
      ? [legacyDirectory]
      : []
  const defaultWorkDirectory = typeof record.defaultWorkDirectory === "string" && record.defaultWorkDirectory.trim().length > 0
    ? record.defaultWorkDirectory.trim()
    : fallback
  const activeCandidate = typeof record.activeWorkDirectory === "string"
    ? record.activeWorkDirectory.trim()
    : legacyDirectory.length > 0
      ? legacyDirectory
      : undefined
  return {
    defaultWorkDirectory,
    workDirectories,
    ...(activeCandidate !== undefined && activeCandidate.length > 0 && workDirectories.includes(activeCandidate)
      ? { activeWorkDirectory: activeCandidate }
      : workDirectories.length > 0
        ? { activeWorkDirectory: workDirectories[0] }
        : {}),
  }
}

export type WorldseedCommand = "project.new" | "project.open" | "turn.start"
export type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized"
export type NativeMenuAction =
  | "app.quit"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.toggleFullscreen"
export type DesktopModelProfile = ModelProfileDraft
export type DesktopModelProfiles = Readonly<{
  profiles: readonly DesktopModelProfile[]
  activeProfileId: string
}>

export type RemoveWorkDirectoryMode = "keep_data" | "include_data"

export type AppSettingsReadResult = Readonly<{
  defaultWorkDirectory: string
  workDirectories: readonly string[]
  activeWorkDirectory?: string
}>

export type AppSettings = Readonly<{
  workDirectory: string
}>

export type WorldseedBridge = Readonly<{
  defaultWorkDirectoryPath: string
  invoke(request: ClientRequest): Promise<ClientResponse>
  readModelProfiles(): Promise<DesktopModelProfiles>
  saveModelProfiles(input: { profiles: readonly DesktopModelProfile[]; activeProfileId: string }): Promise<DesktopModelProfiles>
  listModels(input: { baseUrl: string; apiKey?: string; credentialRef: string }): Promise<ModelListResult>
  readAppSettings(): Promise<AppSettingsReadResult>
  saveAppSettings(input: AppSettings): Promise<AppSettingsReadResult>
  addWorkDirectory(directoryPath: string): Promise<AppSettingsReadResult>
  setActiveWorkDirectory(directoryPath: string): Promise<AppSettingsReadResult>
  removeWorkDirectory(input: Readonly<{ directoryPath: string; mode: RemoveWorkDirectoryMode }>): Promise<AppSettingsReadResult>
  allocateBookPath(workDirectory: string): Promise<string>
  selectDirectory(input?: { title?: string; defaultPath?: string }): Promise<string | undefined>
  onCommand(listener: (command: WorldseedCommand) => void): () => void
  windowControl(action: WindowControlAction): Promise<boolean | undefined>
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  nativeMenu(action: NativeMenuAction): Promise<void>
}>

export const worldseedBridge: WorldseedBridge = {
  defaultWorkDirectoryPath: resolveDefaultWorkDirectoryPath(),
  invoke: async (request) => {
    const response = await ipcRenderer.invoke("worldseed:request", clientRequestSchema.parse(request)) as unknown
    return clientResponseSchema.parse(response)
  },
  readModelProfiles: async () => ipcRenderer.invoke("worldseed:model-profiles:read") as Promise<DesktopModelProfiles>,
  saveModelProfiles: async (input) => ipcRenderer.invoke("worldseed:model-profiles:save", input) as Promise<DesktopModelProfiles>,
  listModels: async (input) => ipcRenderer.invoke("worldseed:model-list", input) as Promise<ModelListResult>,
  readAppSettings: async () => normalizeAppSettingsReadResult(await ipcRenderer.invoke("worldseed:app-settings:read")),
  saveAppSettings: async (input) => normalizeAppSettingsReadResult(await ipcRenderer.invoke("worldseed:app-settings:save", input)),
  addWorkDirectory: async (directoryPath) => normalizeAppSettingsReadResult(await ipcRenderer.invoke("worldseed:app-settings:work-directory:add", { directoryPath })),
  setActiveWorkDirectory: async (directoryPath) => normalizeAppSettingsReadResult(await ipcRenderer.invoke("worldseed:app-settings:work-directory:set-active", { directoryPath })),
  removeWorkDirectory: async (input) => normalizeAppSettingsReadResult(await ipcRenderer.invoke("worldseed:app-settings:work-directory:remove", input)),
  allocateBookPath: async (workDirectory) => ipcRenderer.invoke("worldseed:book-path:allocate", { workDirectory }) as Promise<string>,
  selectDirectory: async (input) => ipcRenderer.invoke("worldseed:select-directory", input) as Promise<string | undefined>,
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: WorldseedCommand): void => { listener(command); }
    ipcRenderer.on("worldseed:command", handler)
    return () => ipcRenderer.removeListener("worldseed:command", handler)
  },
  windowControl: async (action) => ipcRenderer.invoke("worldseed:window-control", action) as Promise<boolean | undefined>,
  onWindowMaximized: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => { listener(maximized); }
    ipcRenderer.on("worldseed:window-maximized", handler)
    return () => ipcRenderer.removeListener("worldseed:window-maximized", handler)
  },
  nativeMenu: async (action) => {
    await ipcRenderer.invoke("worldseed:native-menu", action)
  },
}
