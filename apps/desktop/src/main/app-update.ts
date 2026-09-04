import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { app, shell } from "electron"

export type UpdateCheckIntervalHours = 1 | 2 | 4 | 8 | 24

/** Development: any version/build change counts. Production: semantic version greater-than. */
export type UpdateCompareMode = "any_change" | "semver"

export type AppUpdatePrefs = Readonly<{
  updateUrl: string
  checkIntervalHours?: UpdateCheckIntervalHours
  lastCheckedAtMs?: number
  compareMode?: UpdateCompareMode
}>

export type LocalAppIdentity = Readonly<{
  productName: string
  version: string
  buildNumber: string
}>

export type UpdateManifest = Readonly<{
  version: string
  buildNumber: string
  downloadUrl: string
  productName?: string
  releaseNotes?: string
}>

export type UpdateCheckResult = Readonly<{
  checkedAtMs: number
  updateAvailable: boolean
  local: LocalAppIdentity
  remote?: UpdateManifest
  reason?: string
}>

export const DEFAULT_UPDATE_URL =
  "https://github.com/LastEmbryo2950618641/WorldSeed/releases/latest/download/latest.json"

export const UPDATE_INTERVAL_OPTIONS: readonly UpdateCheckIntervalHours[] = [1, 2, 4, 8, 24]

export function defaultUpdatePrefs(): AppUpdatePrefs {
  return {
    updateUrl: DEFAULT_UPDATE_URL,
    checkIntervalHours: 24,
    compareMode: "any_change",
  }
}

export async function readLocalAppIdentity(): Promise<LocalAppIdentity> {
  const version = app.getVersion()
  const productName = app.isPackaged ? "WorldSeed" : "WorldSeed"
  const buildNumber = await readBuildNumber()
  return { productName, version, buildNumber }
}

async function readBuildNumber(): Promise<string> {
  const candidates = [
    join(app.getAppPath(), "build-info.json"),
    join(process.resourcesPath, "build-info.json"),
    join(import.meta.dirname, "../../build-info.json"),
  ]
  for (const path of candidates) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { buildNumber?: unknown }
      if (typeof raw.buildNumber === "string" && raw.buildNumber.trim().length > 0) {
        return raw.buildNumber.trim()
      }
      if (typeof raw.buildNumber === "number" && Number.isFinite(raw.buildNumber)) {
        return String(raw.buildNumber)
      }
    } catch {
      // try next
    }
  }
  return "0"
}

export function isUpdateAvailable(
  local: LocalAppIdentity,
  remote: UpdateManifest,
  mode: UpdateCompareMode = "any_change",
): boolean {
  if (mode === "semver") {
    return compareSemver(remote.version, local.version) > 0
  }
  return remote.version !== local.version || remote.buildNumber !== local.buildNumber
}

/** Returns negative if a < b, 0 if equal, positive if a > b. Non-semver falls back to string compare. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === undefined || pb === undefined) {
    return a === b ? 0 : a > b ? 1 : -1
  }
  for (let i = 0; i < 3; i += 1) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = value.trim().replace(/^v/iu, "").match(/^(\d+)\.(\d+)\.(\d+)/u)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function shouldAutoCheck(
  prefs: AppUpdatePrefs,
  nowMs: number,
): boolean {
  const hours = prefs.checkIntervalHours
  if (hours === undefined) return false
  const last = prefs.lastCheckedAtMs
  if (last === undefined) return true
  return nowMs - last >= hours * 60 * 60 * 1000
}

export async function fetchUpdateManifest(updateUrl: string): Promise<UpdateManifest> {
  const url = updateUrl.trim()
  if (url.length === 0) throw new Error("更新地址不能为空")
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "WorldSeed-Updater" },
    redirect: "follow",
  })
  if (!response.ok) {
    const hint = response.status === 404
      ? "。若仓库为私有，公开 Release 下载链接会返回 404，需将仓库设为公开，或改用可匿名访问的清单地址"
      : ""
    throw new Error(`更新清单请求失败（HTTP ${String(response.status)}）${hint}`)
  }
  const raw = await response.json() as unknown
  return parseUpdateManifest(raw)
}

export function parseUpdateManifest(raw: unknown): UpdateManifest {
  if (raw === null || typeof raw !== "object") {
    throw new Error("更新清单格式无效")
  }
  const record = raw as Record<string, unknown>
  const version = typeof record.version === "string" ? record.version.trim() : ""
  const buildNumber = typeof record.buildNumber === "string"
    ? record.buildNumber.trim()
    : typeof record.buildNumber === "number"
      ? String(record.buildNumber)
      : ""
  const downloadUrl = typeof record.downloadUrl === "string" ? record.downloadUrl.trim() : ""
  if (version.length === 0 || buildNumber.length === 0 || downloadUrl.length === 0) {
    throw new Error("更新清单缺少 version / buildNumber / downloadUrl")
  }
  return {
    version,
    buildNumber,
    downloadUrl,
    ...(typeof record.productName === "string" && record.productName.trim().length > 0
      ? { productName: record.productName.trim() }
      : {}),
    ...(typeof record.releaseNotes === "string" && record.releaseNotes.trim().length > 0
      ? { releaseNotes: record.releaseNotes.trim() }
      : {}),
  }
}

export async function checkForUpdate(prefs: AppUpdatePrefs): Promise<UpdateCheckResult> {
  const local = await readLocalAppIdentity()
  const checkedAtMs = Date.now()
  try {
    const remote = await fetchUpdateManifest(prefs.updateUrl || DEFAULT_UPDATE_URL)
    const mode = prefs.compareMode ?? "any_change"
    const updateAvailable = isUpdateAvailable(local, remote, mode)
    return {
      checkedAtMs,
      updateAvailable,
      local,
      remote,
      reason: updateAvailable
        ? mode === "semver"
          ? "远端版本号更高"
          : "版本号或构建号已变化"
        : "已是最新",
    }
  } catch (error) {
    return {
      checkedAtMs,
      updateAvailable: false,
      local,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function openUpdateDownload(downloadUrl: string): Promise<void> {
  const url = downloadUrl.trim()
  if (url.length === 0) throw new Error("下载地址为空")
  await shell.openExternal(url)
}
