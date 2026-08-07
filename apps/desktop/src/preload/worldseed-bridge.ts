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

export type WorldseedCommand = "project.new" | "project.open" | "turn.start"
export type DesktopModelProfile = ModelProfileDraft
export type DesktopModelProfiles = Readonly<{
  profiles: readonly DesktopModelProfile[]
  activeProfileId: string
}>

export type WorldseedBridge = Readonly<{
  invoke(request: ClientRequest): Promise<ClientResponse>
  readModelProfiles(): Promise<DesktopModelProfiles>
  saveModelProfiles(input: { profiles: readonly DesktopModelProfile[]; activeProfileId: string }): Promise<DesktopModelProfiles>
  listModels(input: { baseUrl: string; apiKey?: string; credentialRef: string }): Promise<ModelListResult>
  selectDirectory(): Promise<string | undefined>
  onCommand(listener: (command: WorldseedCommand) => void): () => void
}>

export const worldseedBridge: WorldseedBridge = {
  invoke: async (request) => {
    const response = await ipcRenderer.invoke("worldseed:request", clientRequestSchema.parse(request)) as unknown
    return clientResponseSchema.parse(response)
  },
  readModelProfiles: async () => ipcRenderer.invoke("worldseed:model-profiles:read") as Promise<DesktopModelProfiles>,
  saveModelProfiles: async (input) => ipcRenderer.invoke("worldseed:model-profiles:save", input) as Promise<DesktopModelProfiles>,
  listModels: async (input) => ipcRenderer.invoke("worldseed:model-list", input) as Promise<ModelListResult>,
  selectDirectory: async () => ipcRenderer.invoke("worldseed:select-directory") as Promise<string | undefined>,
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: WorldseedCommand): void => { listener(command); }
    ipcRenderer.on("worldseed:command", handler)
    return () => ipcRenderer.removeListener("worldseed:command", handler)
  },
}
