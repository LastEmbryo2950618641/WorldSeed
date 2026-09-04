import { useCallback, useEffect, useRef, useState } from "react"
import {
  cancelAppUpdateDownload,
  checkAppUpdate,
  getAppUpdateInfo,
  installAppUpdateAndQuit,
  onAppUpdateDownloadProgress,
  startAppUpdateDownload,
  type AppUpdateInfoResult,
  type LocalAppIdentity,
  type UpdateCheckResult,
  type UpdateManifest,
} from "../api/client.js"
import type { AppUpdateDialogState } from "../features/settings/AppUpdateDialog.js"

export type UseAppUpdateResult = Readonly<{
  info: AppUpdateInfoResult | null
  available: boolean
  remote: UpdateManifest | null
  checking: boolean
  error: string | null
  statusMessage: string | null
  dialog: AppUpdateDialogState | null
  refreshInfo: () => Promise<void>
  checkNow: (force?: boolean) => Promise<UpdateCheckResult | null>
  openUpdatePrompt: () => void
  closeDialog: () => void
  confirmDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  installAndQuit: () => Promise<void>
  clearAvailable: () => void
}>

export function useAppUpdate(): UseAppUpdateResult {
  const [info, setInfo] = useState<AppUpdateInfoResult | null>(null)
  const [available, setAvailable] = useState(false)
  const [remote, setRemote] = useState<UpdateManifest | null>(null)
  const [local, setLocal] = useState<LocalAppIdentity | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [dialog, setDialog] = useState<AppUpdateDialogState | null>(null)
  const [installerPath, setInstallerPath] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const checkingRef = useRef(false)
  const downloadingRef = useRef(false)

  const applyCheckResult = useCallback((result: UpdateCheckResult, openDialog: boolean) => {
    if (result.skipped) {
      if (openDialog) {
        setDialog({
          phase: "checkFailed",
          message: result.reason ?? "已跳过本次检测（未满检测间隔）。",
        })
      }
      return
    }
    setLocal(result.local)
    setAvailable(result.updateAvailable)
    setRemote(result.remote ?? null)
    if (result.updateAvailable && result.remote !== undefined) {
      setStatusMessage(result.reason ?? "发现新版本")
      setError(null)
      if (openDialog) {
        setDialog({
          phase: "available",
          local: result.local,
          remote: result.remote,
        })
      }
      return
    }
    if (result.remote === undefined) {
      const message = result.reason ?? "检查更新失败"
      setError(message)
      setStatusMessage(null)
      if (openDialog) {
        setDialog({ phase: "checkFailed", message })
      }
      return
    }
    setError(null)
    setStatusMessage(result.reason ?? "已是最新")
    if (openDialog) {
      setDialog({
        phase: "upToDate",
        local: result.local,
        remote: result.remote,
      })
    }
  }, [])

  const refreshInfo = useCallback(async () => {
    try {
      const next = await getAppUpdateInfo()
      setInfo(next)
      setLocal(next.local)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const checkNow = useCallback(async (force = false): Promise<UpdateCheckResult | null> => {
    if (checkingRef.current) return null
    checkingRef.current = true
    setChecking(true)
    try {
      const result = await checkAppUpdate(force)
      await refreshInfo()
      applyCheckResult(result, force)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatusMessage(null)
      if (force) {
        setDialog({ phase: "checkFailed", message })
      }
      return null
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }, [applyCheckResult, refreshInfo])

  const openUpdatePrompt = useCallback(() => {
    if (remote === null) return
    setDialog({
      phase: "available",
      ...(local === null ? {} : { local }),
      remote,
    })
  }, [local, remote])

  const closeDialog = useCallback(() => {
    if (downloadingRef.current) return
    setDialog(null)
  }, [])

  const confirmDownload = useCallback(async () => {
    const target = remote ?? dialog?.remote
    if (target === undefined || downloadingRef.current) return
    downloadingRef.current = true
    setInstallerPath(null)
    setDialog({
      phase: "downloading",
      remote: target,
      ...(local === null ? {} : { local }),
      receivedBytes: 0,
      totalBytes: 0,
      percent: 0,
    })
    try {
      const result = await startAppUpdateDownload({
        downloadUrl: target.downloadUrl,
        version: target.version,
        buildNumber: target.buildNumber,
      })
      setInstallerPath(result.installerPath)
      setDialog({
        phase: "ready",
        remote: target,
        ...(local === null ? {} : { local }),
        installerPath: result.installerPath,
        percent: 100,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDialog({
        phase: "error",
        remote: target,
        ...(local === null ? {} : { local }),
        message,
      })
    } finally {
      downloadingRef.current = false
    }
  }, [dialog?.remote, local, remote])

  const cancelDownload = useCallback(async () => {
    try {
      await cancelAppUpdateDownload()
    } catch {
      // ignore
    }
    downloadingRef.current = false
    if (remote !== null) {
      setDialog({
        phase: "available",
        remote,
        ...(local === null ? {} : { local }),
      })
      return
    }
    setDialog(null)
  }, [local, remote])

  const installAndQuit = useCallback(async () => {
    const path = installerPath ?? dialog?.installerPath
    if (path === undefined) return
    await installAppUpdateAndQuit(path)
  }, [dialog?.installerPath, installerPath])

  const clearAvailable = useCallback(() => {
    setAvailable(false)
  }, [])

  useEffect(() => {
    return onAppUpdateDownloadProgress((progress) => {
      setDialog((current) => {
        if (current === null || current.phase !== "downloading") return current
        return {
          ...current,
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes,
          percent: progress.percent,
        }
      })
    })
  }, [])

  useEffect(() => {
    void refreshInfo().then(() => {
      void checkNow(false)
    })
  }, [checkNow, refreshInfo])

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    const hours = info?.update.checkIntervalHours
    if (hours === undefined) return
    const ms = Math.max(1, hours) * 60 * 60 * 1000
    timerRef.current = window.setInterval(() => {
      void checkNow(false)
    }, ms)
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [checkNow, info?.update.checkIntervalHours])

  return {
    info,
    available,
    remote,
    checking,
    error,
    statusMessage,
    dialog,
    refreshInfo,
    checkNow,
    openUpdatePrompt,
    closeDialog,
    confirmDownload,
    cancelDownload,
    installAndQuit,
    clearAvailable,
  }
}
