import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import { join, resolve } from "node:path"

import { app, BrowserWindow, screen, session } from "electron"

import { BackendProcess } from "./backend-process.js"
import { registerIpcRouter, unregisterIpcRouter } from "./ipc-router.js"
import { installApplicationMenu } from "./menu.js"
import { secureWindow } from "./security.js"

const backend = new BackendProcess()

async function createWindow(): Promise<BrowserWindow> {
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const scaleFactor = display.scaleFactor
  const width = Math.min(1540, Math.floor(workArea.width / scaleFactor))
  const height = Math.min(960, Math.floor(workArea.height / scaleFactor))
  const window = new BrowserWindow({
    x: Math.floor(workArea.x / scaleFactor),
    y: Math.floor(workArea.y / scaleFactor),
    width,
    height,
    minWidth: Math.min(1180, width),
    minHeight: Math.min(720, height),
    show: false,
    backgroundColor: "#f3f4f6",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  secureWindow(window)
  installApplicationMenu(window)
  registerIpcRouter(backend, window)
  window.once("ready-to-show", () => { window.show(); })
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
  }
  return window
}

void app.whenReady().then(async () => {
  loadDevelopmentEnvironment()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false); })
  const applicationDataRoot = resolve(process.env.WORLDSEED_APP_DATA_ROOT ?? join(app.getPath("userData"), "runtime"))
  const promptPackageRoot = resolve(
    process.env.WORLDSEED_PROMPT_ROOT ?? join(app.getAppPath(), "..", "..", "packages", "prompt-contracts"),
  )
  backend.start({ applicationDataRoot, promptPackageRoot })
  await createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  unregisterIpcRouter()
  backend.close()
})

function loadDevelopmentEnvironment(): void {
  if (app.isPackaged) return
  const envPath = resolve(app.getAppPath(), "..", "..", ".env")
  if (existsSync(envPath)) loadEnvFile(envPath)
}
