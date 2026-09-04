import { useCallback, useEffect, useRef, useState } from "react"
import {
  checkAppUpdate,
  getAppUpdateInfo,
  openAppUpdateDownload,
  type AppUpdateInfoResult,
  type UpdateCheckResult,
  type UpdateManifest,
} from "../api/client.js"

export type UseAppUpdateResult = Readonly<{
  info: AppUpdateInfoResult | null
  available: boolean
  remote: UpdateManifest | null
  checking: boolean
  error: string | null
  statusMessage: string | null
  refreshInfo: () => Promise<void>
  checkNow: (force?: boolean) => Promise<UpdateCheckResult | null>
  openDownload: () => Promise<void>
  clearAvailable: () => void
}>

export function useAppUpdate(): UseAppUpdateResult {
  const [info, setInfo] = useState<AppUpdateInfoResult | null>(null)
  const [available, setAvailable] = useState(false)
  const [remote, setRemote] = useState<UpdateManifest | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const checkingRef = useRef(false)

  const applyCheckResult = useCallback((result: UpdateCheckResult) => {
    if (result.skipped) return
    setAvailable(result.updateAvailable)
    setRemote(result.remote ?? null)
    if (result.updateAvailable) {
      setStatusMessage(result.reason ?? "发现新版本")
      setError(null)
      return
    }
    if (result.remote === undefined && result.reason !== undefined && result.reason.length > 0) {
      setError(result.reason)
      setStatusMessage(null)
      return
    }
    setError(null)
    setStatusMessage(result.reason ?? "已是最新")
  }, [])

  const refreshInfo = useCallback(async () => {
    try {
      const next = await getAppUpdateInfo()
      setInfo(next)
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
      // Refresh prefs/identity first; applyCheckResult last so it is not wiped by refreshInfo.
      await refreshInfo()
      applyCheckResult(result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatusMessage(null)
      return null
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }, [applyCheckResult, refreshInfo])

  const openDownload = useCallback(async () => {
    const url = remote?.downloadUrl
    if (url === undefined || url.trim().length === 0) {
      throw new Error("没有可用的下载地址")
    }
    await openAppUpdateDownload(url)
  }, [remote?.downloadUrl])

  const clearAvailable = useCallback(() => {
    setAvailable(false)
  }, [])

  useEffect(() => {
    void refreshInfo().then(() => {
      void checkNow(true)
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
    refreshInfo,
    checkNow,
    openDownload,
    clearAvailable,
  }
}
