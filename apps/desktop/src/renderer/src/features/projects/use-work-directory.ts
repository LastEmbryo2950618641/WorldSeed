import { useCallback, useEffect, useState } from "react"

import {
  addWorkDirectory as addWorkDirectoryApi,
  allocateBookPath,
  readAppSettings,
  removeWorkDirectory as removeWorkDirectoryApi,
  selectDirectory,
  setActiveWorkDirectory as setActiveWorkDirectoryApi,
  type RemoveWorkDirectoryMode,
} from "../../api/client.js"

function readInitialDefaultWorkDirectory(): string {
  const bridge = typeof window === "undefined" ? undefined : window.worldseed
  if (bridge !== undefined && typeof bridge.defaultWorkDirectoryPath === "string" && bridge.defaultWorkDirectoryPath.length > 0) {
    return bridge.defaultWorkDirectoryPath
  }
  return ""
}

function initialWorkDirectoryState(): Readonly<{
  loading: boolean
  workDirectories: readonly string[]
  activeWorkDirectory: string | undefined
  defaultWorkDirectory: string
}> {
  const bridge = typeof window === "undefined" ? undefined : window.worldseed
  const defaultWorkDirectory = readInitialDefaultWorkDirectory()
  if (bridge !== undefined) {
    return {
      loading: true,
      workDirectories: [],
      activeWorkDirectory: undefined,
      defaultWorkDirectory,
    }
  }
  const fallback = "C:\\Users\\Example\\.worldseed"
  return {
    loading: false,
    workDirectories: [fallback],
    activeWorkDirectory: fallback,
    defaultWorkDirectory: fallback,
  }
}

const FALLBACK_WORK_DIRECTORY_STATE = initialWorkDirectoryState()

function applySettingsReadResult(
  settings: Awaited<ReturnType<typeof readAppSettings>>,
): Readonly<{ workDirectories: readonly string[]; activeWorkDirectory: string | undefined; defaultWorkDirectory: string }> {
  return {
    defaultWorkDirectory: settings.defaultWorkDirectory,
    workDirectories: settings.workDirectories,
    activeWorkDirectory: settings.activeWorkDirectory,
  }
}

export function useWorkDirectory(): Readonly<{
  workDirectory: string | undefined
  activeWorkDirectory: string | undefined
  workDirectories: readonly string[]
  defaultWorkDirectory: string
  loading: boolean
  saving: boolean
  error: string | undefined
  refresh(): Promise<void>
  confirmWorkDirectory(directory: string): Promise<void>
  chooseWorkDirectory(): Promise<void>
  addWorkDirectory(directory: string): Promise<void>
  removeWorkDirectory(input: Readonly<{ directoryPath: string; mode: RemoveWorkDirectoryMode }>): Promise<void>
  setActiveWorkDirectory(directory: string): Promise<void>
  allocateBookWorkspacePath(): Promise<string>
}> {
  const [workDirectories, setWorkDirectories] = useState<readonly string[]>(FALLBACK_WORK_DIRECTORY_STATE.workDirectories)
  const [activeWorkDirectory, setActiveWorkDirectoryState] = useState<string | undefined>(FALLBACK_WORK_DIRECTORY_STATE.activeWorkDirectory)
  const [defaultWorkDirectory, setDefaultWorkDirectory] = useState<string>(FALLBACK_WORK_DIRECTORY_STATE.defaultWorkDirectory)
  const [loading, setLoading] = useState(FALLBACK_WORK_DIRECTORY_STATE.loading)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const applyReadResult = useCallback((settings: Awaited<ReturnType<typeof readAppSettings>>): void => {
    const next = applySettingsReadResult(settings)
    setDefaultWorkDirectory(next.defaultWorkDirectory)
    setWorkDirectories(next.workDirectories)
    setActiveWorkDirectoryState(next.activeWorkDirectory)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const settings = await readAppSettings()
      applyReadResult(settings)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setDefaultWorkDirectory(readInitialDefaultWorkDirectory())
    } finally {
      setLoading(false)
    }
  }, [applyReadResult])

  useEffect(() => {
    if (!FALLBACK_WORK_DIRECTORY_STATE.loading) return
    void refresh()
  }, [refresh])

  const runMutation = useCallback(async (
    action: () => Promise<Awaited<ReturnType<typeof readAppSettings>>>,
  ): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const settings = await action()
      applyReadResult(settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      setSaving(false)
    }
  }, [applyReadResult])

  const addWorkDirectory = useCallback(async (directory: string): Promise<void> => {
    await runMutation(() => addWorkDirectoryApi(directory))
  }, [runMutation])

  const confirmWorkDirectory = useCallback(async (directory: string): Promise<void> => {
    await addWorkDirectory(directory)
  }, [addWorkDirectory])

  const chooseWorkDirectory = useCallback(async (): Promise<void> => {
    const picked = await selectDirectory({
      title: "选择书籍存放目录",
      ...(activeWorkDirectory ?? defaultWorkDirectory === undefined
        ? {}
        : { defaultPath: activeWorkDirectory ?? defaultWorkDirectory }),
    })
    if (picked === undefined) return
    await confirmWorkDirectory(picked)
  }, [activeWorkDirectory, confirmWorkDirectory, defaultWorkDirectory])

  const removeWorkDirectory = useCallback(async (
    input: Readonly<{ directoryPath: string; mode: RemoveWorkDirectoryMode }>,
  ): Promise<void> => {
    await runMutation(() => removeWorkDirectoryApi(input))
  }, [runMutation])

  const setActiveWorkDirectory = useCallback(async (directory: string): Promise<void> => {
    await runMutation(() => setActiveWorkDirectoryApi(directory))
  }, [runMutation])

  const allocateBookWorkspacePath = useCallback(async (): Promise<string> => {
    if (activeWorkDirectory === undefined) throw new Error("请先配置软件工作目录")
    return allocateBookPath(activeWorkDirectory)
  }, [activeWorkDirectory])

  return {
    workDirectory: activeWorkDirectory,
    activeWorkDirectory,
    workDirectories,
    defaultWorkDirectory,
    loading,
    saving,
    error,
    refresh,
    confirmWorkDirectory,
    chooseWorkDirectory,
    addWorkDirectory,
    removeWorkDirectory,
    setActiveWorkDirectory,
    allocateBookWorkspacePath,
  }
}

export type { RemoveWorkDirectoryMode }
