import { ipcMain, type BrowserWindow } from "electron"

export type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized"

export function registerWindowControls(window: BrowserWindow): void {
  ipcMain.removeHandler("worldseed:window-control")
  ipcMain.handle("worldseed:window-control", (_event, action: WindowControlAction) => {
    switch (action) {
      case "minimize":
        window.minimize()
        return undefined
      case "maximize":
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return window.isMaximized()
      case "close":
        window.close()
        return undefined
      case "isMaximized":
        return window.isMaximized()
      default:
        return undefined
    }
  })

  const emitMaximized = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send("worldseed:window-maximized", window.isMaximized())
    }
  }
  window.on("maximize", emitMaximized)
  window.on("unmaximize", emitMaximized)
}

export function unregisterWindowControls(): void {
  ipcMain.removeHandler("worldseed:window-control")
}
