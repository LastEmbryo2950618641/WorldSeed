import { useEffect, useState } from "react"
import { Info, RefreshCw } from "lucide-react"

import {
  saveAppUpdatePrefs,
  type AppUpdateInfoResult,
  type UpdateCheckIntervalHours,
  type UpdateCheckResult,
  type UpdateManifest,
} from "../../api/client.js"

const INTERVAL_OPTIONS: readonly (UpdateCheckIntervalHours | 0)[] = [0, 1, 2, 4, 8, 24]

type Props = Readonly<{
  info: AppUpdateInfoResult | null
  checking: boolean
  error: string | null
  statusMessage: string | null
  remote: UpdateManifest | null
  onRefreshInfo: () => Promise<void>
  onCheckNow: (force?: boolean) => Promise<UpdateCheckResult | null>
}>

function formatCheckedAt(ms: number | undefined): string {
  if (ms === undefined) return "尚未检测"
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return "尚未检测"
  }
}

export function AboutSettingsPanel({
  info,
  checking,
  error,
  statusMessage,
  remote,
  onRefreshInfo,
  onCheckNow,
}: Props): React.JSX.Element {
  const [updateUrl, setUpdateUrl] = useState("")
  const [intervalHours, setIntervalHours] = useState<UpdateCheckIntervalHours | 0>(24)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [saveOk, setSaveOk] = useState(false)

  useEffect(() => {
    if (info === null) return
    setUpdateUrl(info.update.updateUrl)
    setIntervalHours(info.update.checkIntervalHours ?? 0)
  }, [info])

  const savePrefs = async (): Promise<void> => {
    const trimmed = updateUrl.trim()
    if (trimmed.length === 0) {
      setSaveError("更新地址不能为空")
      return
    }
    setSaving(true)
    setSaveError(undefined)
    setSaveOk(false)
    try {
      await saveAppUpdatePrefs({
        updateUrl: trimmed,
        ...(intervalHours === 0 ? {} : { checkIntervalHours: intervalHours }),
        ...(info?.update.lastCheckedAtMs === undefined ? {} : { lastCheckedAtMs: info.update.lastCheckedAtMs }),
        compareMode: info?.update.compareMode ?? "any_change",
      })
      await onRefreshInfo()
      setSaveOk(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const local = info?.local

  return (
    <section className="settings-page" data-testid="about-settings-panel">
      <header>
        <span><Info size={18} /></span>
        <div>
          <h2>关于</h2>
          <p>产品信息与自动更新检测。发现新版本后会在应用内下载安装包。</p>
        </div>
      </header>
      <div className="settings-fields about-settings">
        <div className="settings-field-row">
          <span>
            <strong>产品名称</strong>
            <small>当前安装的应用标识</small>
          </span>
          <div className="settings-readonly-value" data-testid="about-product-name">
            {local?.productName ?? "—"}
          </div>
        </div>
        <div className="settings-field-row">
          <span>
            <strong>版本号</strong>
            <small>语义化版本</small>
          </span>
          <div className="settings-readonly-value" data-testid="about-version">
            {local?.version ?? "—"}
          </div>
        </div>
        <div className="settings-field-row">
          <span>
            <strong>构建号</strong>
            <small>同版本下的构建序号</small>
          </span>
          <div className="settings-readonly-value" data-testid="about-build-number">
            {local?.buildNumber ?? "—"}
          </div>
        </div>
        <div className="settings-field-row about-settings-url-row">
          <span>
            <strong>更新地址</strong>
            <small>指向 latest.json 清单的 URL</small>
          </span>
          <input
            className="about-settings-url"
            data-testid="about-update-url"
            value={updateUrl}
            onChange={(event) => {
              setUpdateUrl(event.target.value)
              setSaveOk(false)
            }}
            placeholder="https://…/latest.json"
            spellCheck={false}
          />
        </div>
        <div className="settings-field-row">
          <span>
            <strong>自动检测间隔</strong>
            <small>可选；关闭后仅手动检查</small>
          </span>
          <select
            className="about-settings-interval"
            data-testid="about-check-interval"
            value={String(intervalHours)}
            onChange={(event) => {
              setIntervalHours(Number(event.target.value) as UpdateCheckIntervalHours | 0)
              setSaveOk(false)
            }}
          >
            {INTERVAL_OPTIONS.map((hours) => (
              <option key={hours} value={String(hours)}>
                {hours === 0 ? "关闭" : `${String(hours)} 小时`}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-field-row">
          <span>
            <strong>上次检测</strong>
            <small>{statusMessage ?? (remote === null ? "—" : `远端 ${remote.version} / ${remote.buildNumber}`)}</small>
          </span>
          <div className="settings-readonly-value" data-testid="about-last-checked">
            {formatCheckedAt(info?.update.lastCheckedAtMs)}
          </div>
        </div>
        <div className="about-settings-toolbar">
          <button
            type="button"
            className="secondary-command"
            data-testid="about-save-prefs"
            disabled={saving || checking}
            onClick={() => { void savePrefs() }}
          >
            保存更新设置
          </button>
          <button
            type="button"
            className="dialog-primary-command"
            data-testid="about-check-update"
            disabled={checking || saving}
            onClick={() => { void onCheckNow(true) }}
          >
            <RefreshCw size={14} />
            {checking ? "检测中…" : "检查更新"}
          </button>
        </div>
        {saveOk ? <p className="about-settings-ok" role="status">更新设置已保存</p> : null}
        {statusMessage !== null && statusMessage.length > 0 && error === null
          ? <p className="about-settings-ok" role="status" data-testid="about-check-status">{statusMessage}</p>
          : null}
        {saveError !== undefined
          ? <p className="form-error" role="alert">{saveError}</p>
          : null}
        {error !== null && error.length > 0
          ? <p className="form-error" role="alert">{error}</p>
          : null}
      </div>
    </section>
  )
}
