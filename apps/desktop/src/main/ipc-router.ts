import { dialog, ipcMain, type BrowserWindow } from "electron"
import { clientRequestSchema } from "@worldseed/contracts"

import type { BackendProcess } from "./backend-process.js"

export function registerIpcRouter(backend: BackendProcess, window: BrowserWindow): void {
  ipcMain.handle("worldseed:request", (_event, request: unknown) => backend.invoke(clientRequestSchema.parse(request)))
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
  ipcMain.removeHandler("worldseed:select-directory")
}
