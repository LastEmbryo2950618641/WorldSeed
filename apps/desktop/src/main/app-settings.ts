import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { app } from "electron"

export type AppSettings = Readonly<{
  workDirectories: readonly string[]
  activeWorkDirectory: string
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

function parseStoredSettings(raw: unknown): AppSettings | undefined {
  if (raw === null || typeof raw !== "object") return undefined

  const record = raw as {
    workDirectory?: unknown
    workDirectories?: unknown
    activeWorkDirectory?: unknown
  }

  if (Array.isArray(record.workDirectories)) {
    const workDirectories = record.workDirectories
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizeDirectoryPath)
      .filter((entry) => entry.length > 0)
    if (workDirectories.length === 0) return undefined
    const activeCandidate = typeof record.activeWorkDirectory === "string"
      ? normalizeDirectoryPath(record.activeWorkDirectory)
      : workDirectories[0]!
    const activeWorkDirectory = workDirectories.includes(activeCandidate)
      ? activeCandidate
      : workDirectories[0]!
    return { workDirectories, activeWorkDirectory }
  }

  if (typeof record.workDirectory === "string" && record.workDirectory.trim().length > 0) {
    const legacy = normalizeDirectoryPath(record.workDirectory)
    return { workDirectories: [legacy], activeWorkDirectory: legacy }
  }

  return undefined
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
  if (workDirectories.length === 0) {
    await mkdir(applicationDataRoot, { recursive: true })
    await writeFile(
      settingsPath(applicationDataRoot),
      `${JSON.stringify({ workDirectories: [], activeWorkDirectory: "" }, null, 2)}\n`,
      "utf8",
    )
    return { workDirectories: [], activeWorkDirectory: "" }
  }
  const activeCandidate = normalizeDirectoryPath(settings.activeWorkDirectory)
  const activeWorkDirectory = workDirectories.includes(activeCandidate)
    ? activeCandidate
    : workDirectories[0]!
  const normalized = { workDirectories, activeWorkDirectory }
  await mkdir(applicationDataRoot, { recursive: true })
  await writeFile(settingsPath(applicationDataRoot), `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  return normalized
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
  return saveAppSettings(applicationDataRoot, { workDirectories, activeWorkDirectory })
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
  })
}

export function toAppSettingsReadResult(stored: AppSettings | undefined): Readonly<{
  defaultWorkDirectory: string
  workDirectories: readonly string[]
  activeWorkDirectory?: string
}> {
  const defaultDirectory = defaultWorkDirectory()
  if (stored === undefined || stored.workDirectories.length === 0) {
    return {
      defaultWorkDirectory: defaultDirectory,
      workDirectories: [],
    }
  }
  return {
    defaultWorkDirectory: defaultDirectory,
    workDirectories: stored.workDirectories,
    activeWorkDirectory: stored.activeWorkDirectory,
  }
}
