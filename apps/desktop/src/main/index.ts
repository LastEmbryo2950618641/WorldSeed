import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"
import { join, resolve } from "node:path"

import { app, BrowserWindow, safeStorage, screen, session } from "electron"
import { configureRuntimeDiagnostics, runtimeLog } from "@worldseed/backend"
import { runtimeDiagnosticsConfigFromEnvironment } from "@worldseed/config"

import { BackendProcess } from "./backend-process.js"
import { registerIpcRouter, unregisterIpcRouter } from "./ipc-router.js"
import { installApplicationMenu } from "./menu.js"
import { secureWindow } from "./security.js"
import { FileCredentialVault } from "./credential-vault.js"

const backend = new BackendProcess()

async function createWindow(credentials: FileCredentialVault): Promise<BrowserWindow> {
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
  registerIpcRouter(backend, window, credentials)
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
  const diagnostics = runtimeDiagnosticsConfigFromEnvironment(
    process.env,
    join(applicationDataRoot, "logs", "worldseed.log"),
    !app.isPackaged,
  )
  configureRuntimeDiagnostics(diagnostics)
  const promptPackageRoot = resolve(
    process.env.WORLDSEED_PROMPT_ROOT ?? join(app.getAppPath(), "..", "..", "packages", "prompt-contracts"),
  )
  const credentials = new FileCredentialVault(join(applicationDataRoot, "credentials.json"), {
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法保存 API Key")
      return safeStorage.encryptString(value).toString("base64")
    },
    decrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取 API Key")
      return safeStorage.decryptString(Buffer.from(value, "base64"))
    },
  })
  runtimeLog("info", "electron-main", "application.ready", {
    applicationDataRoot,
    diagnostics,
    packaged: app.isPackaged,
  })
  backend.start({ applicationDataRoot, promptPackageRoot, diagnostics })
  await createWindow(credentials)
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(credentials)
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
