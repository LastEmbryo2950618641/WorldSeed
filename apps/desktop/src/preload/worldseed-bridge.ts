import { ipcRenderer } from "electron"
import {
  clientRequestSchema,
  clientResponseSchema,
  type ClientRequest,
  type ClientResponse,
} from "@worldseed/contracts"

export type WorldseedCommand = "project.new" | "project.open" | "turn.start"

export type WorldseedBridge = Readonly<{
  invoke(request: ClientRequest): Promise<ClientResponse>
  selectDirectory(): Promise<string | undefined>
  onCommand(listener: (command: WorldseedCommand) => void): () => void
}>

export const worldseedBridge: WorldseedBridge = {
  invoke: async (request) => {
    const response = await ipcRenderer.invoke("worldseed:request", clientRequestSchema.parse(request)) as unknown
    return clientResponseSchema.parse(response)
  },
  selectDirectory: async () => ipcRenderer.invoke("worldseed:select-directory") as Promise<string | undefined>,
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: WorldseedCommand): void => { listener(command); }
    ipcRenderer.on("worldseed:command", handler)
    return () => ipcRenderer.removeListener("worldseed:command", handler)
  },
}
