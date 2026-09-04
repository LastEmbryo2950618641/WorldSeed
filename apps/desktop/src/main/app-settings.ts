import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { app } from "electron"

import {
  defaultUpdatePrefs,
  type AppUpdatePrefs,
  type UpdateCheckIntervalHours,
  type UpdateCompareMode,
} from "./app-update.js"

export type AppSettings = Readonly<{
  workDirectories: readonly string[]
  activeWorkDirectory: string
  update?: AppUpdatePrefs
}>

export type RemoveWorkDirectoryMode = "keep_data" | "include_data"

export function defaultWorkDirectory(): string {
  return join(app.getPath("home"), ".worldseed")
}

function settingsPath(applicationDataRoot: string): string {
  return join(applicationDataRoot, "app-settings.json")
}

function normalizeDirectoryPath(path: string): string {
  return path.trim().replace(/[\\/]+$/u, "")
}

function parseUpdatePrefs(raw: unknown): AppUpdatePrefs | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const updateUrl = typeof record.updateUrl === "string" ? record.updateUrl.trim() : ""
  if (updateUrl.length === 0) return undefined
  const interval = record.checkIntervalHours
  const checkIntervalHours = interval === 1 || interval === 2 || interval === 4 || interval === 8 || interval === 24
    ? interval as UpdateCheckIntervalHours
    : undefined
  const lastCheckedAtMs = typeof record.lastCheckedAtMs === "number" && Number.isFinite(record.lastCheckedAtMs)
    ? record.lastCheckedAtMs
    : undefined
  const compareMode: UpdateCompareMode | undefined = record.compareMode === "semver" || record.compareMode === "any_change"
    ? record.compareMode
    : undefined
  return {
    updateUrl,
    ...(checkIntervalHours === undefined ? {} : { checkIntervalHours }),
    ...(lastCheckedAtMs === undefined ? {} : { lastCheckedAtMs }),
    ...(compareMode === undefined ? {} : { compareMode }),
  }
}

function parseStoredSettings(raw: unknown): AppSettings | undefined {
  if (raw === null || typeof raw !== "object") return undefined

  const record = raw as {
    workDirectory?: unknown
    workDirectories?: unknown
    activeWorkDirectory?: unknown
    update?: unknown
  }
  const update = parseUpdatePrefs(record.update)

  if (Array.isArray(record.workDirectories)) {
    const workDirectories = record.workDirectories
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeDirectoryPath)
      .filter((entry) => entry.length > 0)
    if (workDirectories.length === 0) {
      return update === undefined
        ? undefined
        : { workDirectories: [], activeWorkDirectory: "", update }
    }
    const activeCandidate = typeof record.activeWorkDirectory === "string"
      ? normalizeDirectoryPath(record.activeWorkDirectory)
      : workDirectories[0]!
    const activeWorkDirectory = workDirectories.includes(activeCandidate)
      ? activeCandidate
      : workDirectories[0]!
    return {
      workDirectories,
      activeWorkDirectory,
      ...(update === undefined ? {} : { update }),
    }
  }

  if (typeof record.workDirectory === "string" && record.workDirectory.trim().length > 0) {
    const legacy = normalizeDirectoryPath(record.workDirectory)
    return {
      workDirectories: [legacy],
      activeWorkDirectory: legacy,
      ...(update === undefined ? {} : { update }),
    }
  }

  return update === undefined ? undefined : { workDirectories: [], activeWorkDirectory: "", update }
}

export async function readAppSettings(applicationDataRoot: string): Promise<AppSettings | undefined> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(applicationDataRoot), "utf8")) as unknown
    return parseStoredSettings(raw)
  } catch {
    return undefined
  }
}

export async function saveAppSettings(applicationDataRoot: string, settings: AppSettings): Promise<AppSettings> {
  const workDirectories = [...new Set(
    settings.workDirectories.map(normalizeDirectoryPath).filter((entry) => entry.length > 0),
  )]
  const update = settings.update === undefined
    ? undefined
    : {
        updateUrl: settings.update.updateUrl.trim() || defaultUpdatePrefs().updateUrl,
        ...(settings.update.checkIntervalHours === undefined
          ? {}
          : { checkIntervalHours: settings.update.checkIntervalHours }),
        ...(settings.update.lastCheckedAtMs === undefined
          ? {}
          : { lastCheckedAtMs: settings.update.lastCheckedAtMs }),
        ...(settings.update.compareMode === undefined
          ? {}
          : { compareMode: settings.update.compareMode }),
      }
  if (workDirectories.length === 0) {
    await mkdir(applicationDataRoot, { recursive: true })
    const empty = {
      workDirectories: [] as string[],
      activeWorkDirectory: "",
      ...(update === undefined ? {} : { update }),
    }
    await writeFile(settingsPath(applicationDataRoot), `${JSON.stringify(empty, null, 2)}\n`, "utf8")
    return empty
  }
  const activeCandidate = normalizeDirectoryPath(settings.activeWorkDirectory)
  const activeWorkDirectory = workDirectories.includes(activeCandidate)
    ? activeCandidate
    : workDirectories[0]!
  const normalized = {
    workDirectories,
    activeWorkDirectory,
    ...(update === undefined ? {} : { update }),
  }
  await mkdir(applicationDataRoot, { recursive: true })
  await writeFile(settingsPath(applicationDataRoot), `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  return normalized
}

export async function saveUpdatePrefs(
  applicationDataRoot: string,
  update: AppUpdatePrefs,
): Promise<AppSettings> {
  const current = await readAppSettings(applicationDataRoot)
  return saveAppSettings(applicationDataRoot, {
    workDirectories: current?.workDirectories ?? [],
    activeWorkDirectory: current?.activeWorkDirectory ?? "",
    update,
  })
}

export async function ensureDirectoryExists(directoryPath: string): Promise<void> {
  await mkdir(normalizeDirectoryPath(directoryPath), { recursive: true })
}

export async function addWorkDirectory(applicationDataRoot: string, directoryPath: string): Promise<AppSettings> {
  const nextPath = normalizeDirectoryPath(directoryPath)
  if (nextPath.length === 0) throw new Error("工作目录不能为空")
  await ensureDirectoryExists(nextPath)
  const current = await readAppSettings(applicationDataRoot)
  const workDirectories = current === undefined
    ? [nextPath]
    : [...new Set([...current.workDirectories.map(normalizeDirectoryPath), nextPath])]
  const activeWorkDirectory = current === undefined || current.workDirectories.length === 0
    ? nextPath
    : current.activeWorkDirectory
  return saveAppSettings(applicationDataRoot, {
    workDirectories,
    activeWorkDirectory,
    ...(current?.update === undefined ? {} : { update: current.update }),
  })
}

export async function setActiveWorkDirectory(applicationDataRoot: string, directoryPath: string): Promise<AppSettings> {
  const nextPath = normalizeDirectoryPath(directoryPath)
  const current = await readAppSettings(applicationDataRoot)
  if (current === undefined) throw new Error("尚未配置工作目录")
  if (!current.workDirectories.map(normalizeDirectoryPath).includes(nextPath)) {
    throw new Error("所选工作目录不在列表中")
  }
  return saveAppSettings(applicationDataRoot, {
    workDirectories: current.workDirectories,
    activeWorkDirectory: nextPath,
    ...(current.update === undefined ? {} : { update: current.update }),
  })
}

export async function removeWorkDirectory(
  applicationDataRoot: string,
  input: Readonly<{ directoryPath: string; mode: RemoveWorkDirectoryMode }>,
): Promise<AppSettings> {
  const target = normalizeDirectoryPath(input.directoryPath)
  const current = await readAppSettings(applicationDataRoot)
  if (current === undefined) throw new Error("尚未配置工作目录")
  const remaining = current.workDirectories
    .map(normalizeDirectoryPath)
    .filter((entry) => entry !== target)
  if (remaining.length === current.workDirectories.length) {
    throw new Error("工作目录不在列表中")
  }
  if (input.mode === "include_data") {
    await rm(target, { recursive: true, force: true })
  }
  const activeWorkDirectory = normalizeDirectoryPath(current.activeWorkDirectory) === target
    ? (remaining[0] ?? "")
    : current.activeWorkDirectory
  return saveAppSettings(applicationDataRoot, {
    workDirectories: remaining,
    activeWorkDirectory,
    ...(current.update === undefined ? {} : { update: current.update }),
  })
}

export function toAppSettingsReadResult(stored: AppSettings | undefined): Readonly<{
  defaultWorkDirectory: string
  workDirectories: readonly string[]
  activeWorkDirectory?: string
  update: AppUpdatePrefs
}> {
  const defaultDirectory = defaultWorkDirectory()
  const update = stored?.update ?? defaultUpdatePrefs()
  if (stored === undefined || stored.workDirectories.length === 0) {
    return {
      defaultWorkDirectory: defaultDirectory,
      workDirectories: [],
      update,
    }
  }
  return {
    defaultWorkDirectory: defaultDirectory,
    workDirectories: stored.workDirectories,
    activeWorkDirectory: stored.activeWorkDirectory,
    update,
  }
}
