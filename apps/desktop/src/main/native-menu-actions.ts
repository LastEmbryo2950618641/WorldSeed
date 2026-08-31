import { app, ipcMain, type BrowserWindow } from "electron"

export type NativeMenuAction =
  | "app.quit"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.toggleFullscreen"

export function registerNativeMenuActions(window: BrowserWindow): void {
  ipcMain.removeHandler("worldseed:native-menu")
  ipcMain.handle("worldseed:native-menu", (_event, action: NativeMenuAction) => {
    switch (action) {
      case "app.quit":
        app.quit()
        return
      case "view.reload":
        window.webContents.reload()
        return
      case "view.toggleDevTools":
        window.webContents.toggleDevTools()
        return
      case "view.toggleFullscreen":
        window.setFullScreen(!window.isFullScreen())
        return
      default:
        return
    }
  })
}

export function unregisterNativeMenuActions(): void {
  ipcMain.removeHandler("worldseed:native-menu")
}
