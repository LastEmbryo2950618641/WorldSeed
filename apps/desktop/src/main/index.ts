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
import { registerWindowControls, unregisterWindowControls } from "./window-controls.js"
import { registerNativeMenuActions, unregisterNativeMenuActions } from "./native-menu-actions.js"

const backend = new BackendProcess()

if (!app.isPackaged && process.env.WORLDSEED_CDP_PORT !== undefined) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.WORLDSEED_CDP_PORT)
}

async function createWindow(credentials: FileCredentialVault, applicationDataRoot: string): Promise<BrowserWindow> {
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
    frame: false,
    backgroundColor: "#1e1f22",
    icon: join(import.meta.dirname, "../../resources/icon.png"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  secureWindow(window)
  installApplicationMenu(window)
  registerWindowControls(window)
  registerNativeMenuActions(window)
  registerIpcRouter(backend, window, credentials, applicationDataRoot)
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
  await createWindow(credentials, applicationDataRoot)
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(credentials, applicationDataRoot)
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  unregisterNativeMenuActions()
  unregisterWindowControls()
  unregisterIpcRouter()
  backend.close()
})

function loadDevelopmentEnvironment(): void {
  if (app.isPackaged) return
  const envPath = resolve(app.getAppPath(), "..", "..", ".env")
  if (existsSync(envPath)) loadEnvFile(envPath)
}
