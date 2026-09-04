import type { LocalAppIdentity, UpdateManifest } from "../../api/client.js"

export type AppUpdateDialogPhase =
  | "available"
  | "downloading"
  | "ready"
  | "upToDate"
  | "checkFailed"
  | "error"

export type AppUpdateDialogState = Readonly<{
  phase: AppUpdateDialogPhase
  local?: LocalAppIdentity
  remote?: UpdateManifest
  receivedBytes?: number
  totalBytes?: number
  percent?: number
  installerPath?: string
  message?: string
}>

type Props = Readonly<{
  state: AppUpdateDialogState
  busy?: boolean
  onClose(): void
  onConfirmDownload(): void
  onCancelDownload(): void
  onInstall(): void
}>

function formatBytes(value: number | undefined): string {
  if (value === undefined || value <= 0) return "—"
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function AppUpdateDialog(props: Props): React.JSX.Element {
  const { state, busy = false } = props
  const remoteLabel = state.remote === undefined
    ? undefined
    : `${state.remote.version}（构建 ${state.remote.buildNumber}）`
  const localLabel = state.local === undefined
    ? undefined
    : `${state.local.version}（构建 ${state.local.buildNumber}）`

  let title = "应用更新"
  let subtitle = "WorldSeed"
  let body: React.ReactNode = null
  let footer: React.ReactNode = null

  if (state.phase === "available") {
    title = "发现新版本"
    subtitle = remoteLabel ?? "有可用更新"
    body = (
      <>
        <p>检测到新的安装包。确认后将在应用内下载，不会打开浏览器。</p>
        <p className="app-update-dialog-meta">
          当前版本：{localLabel ?? "—"}
          <br />
          新版本：{remoteLabel ?? "—"}
        </p>
        {state.remote?.releaseNotes !== undefined
          ? <p className="app-update-dialog-notes">{state.remote.releaseNotes}</p>
          : null}
      </>
    )
    footer = (
      <>
        <button type="button" data-testid="app-update-dismiss" onClick={props.onClose} disabled={busy}>
          稍后
        </button>
        <button
          type="button"
          className="dialog-primary-command"
          data-testid="app-update-confirm-download"
          onClick={props.onConfirmDownload}
          disabled={busy}
        >
          下载更新
        </button>
      </>
    )
  } else if (state.phase === "downloading") {
    title = "正在下载更新"
    subtitle = remoteLabel ?? "下载中"
    const percent = state.percent ?? 0
    body = (
      <>
        <p>正在下载安装包到本地临时目录…</p>
        <div className="app-update-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="app-update-progress-bar" style={{ width: `${String(percent)}%` }} />
        </div>
        <p className="app-update-dialog-meta">
          {String(percent)}% · {formatBytes(state.receivedBytes)}
          {state.totalBytes !== undefined && state.totalBytes > 0 ? ` / ${formatBytes(state.totalBytes)}` : ""}
        </p>
      </>
    )
    footer = (
      <button type="button" data-testid="app-update-cancel-download" onClick={props.onCancelDownload}>
        取消下载
      </button>
    )
  } else if (state.phase === "ready") {
    title = "下载完成"
    subtitle = remoteLabel ?? "可以安装"
    body = (
      <>
        <p>安装包已就绪。点击后将退出 WorldSeed 并打开安装向导（可选择安装目录）。</p>
        <p className="app-update-dialog-meta">请先保存未提交的工作，再开始安装。</p>
      </>
    )
    footer = (
      <>
        <button type="button" data-testid="app-update-dismiss" onClick={props.onClose} disabled={busy}>
          稍后安装
        </button>
        <button
          type="button"
          className="dialog-primary-command"
          data-testid="app-update-install"
          onClick={props.onInstall}
          disabled={busy}
        >
          {busy ? "正在启动…" : "立即安装并退出"}
        </button>
      </>
    )
  } else if (state.phase === "upToDate") {
    title = "已是最新"
    subtitle = localLabel ?? "无需更新"
    body = (
      <p>
        当前安装已是最新。
        {state.remote !== undefined
          ? ` 远端同样为 ${remoteLabel}。`
          : null}
      </p>
    )
    footer = (
      <button type="button" className="dialog-primary-command" data-testid="app-update-dismiss" onClick={props.onClose}>
        知道了
      </button>
    )
  } else {
    title = state.phase === "checkFailed" ? "检查更新失败" : "更新出错"
    subtitle = "请稍后重试"
    body = <p>{state.message?.trim() || "未知错误"}</p>
    footer = (
      <button type="button" className="dialog-primary-command" data-testid="app-update-dismiss" onClick={props.onClose}>
        关闭
      </button>
    )
  }

  return (
    <div className="dialog-backdrop" role="presentation" data-testid="app-update-dialog">
      <section
        className="work-name-prompt-dialog app-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-dialog-title"
      >
        <header>
          <div>
            <strong id="app-update-dialog-title">{title}</strong>
            <small>{subtitle}</small>
          </div>
        </header>
        <div className="work-name-prompt-body">{body}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  )
}
