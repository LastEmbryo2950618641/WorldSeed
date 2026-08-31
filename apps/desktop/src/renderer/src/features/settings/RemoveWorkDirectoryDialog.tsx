import { AlertTriangle } from "lucide-react"

import type { RemoveWorkDirectoryMode } from "../../api/client.js"

type Props = Readonly<{
  directoryPath: string
  busy?: boolean
  onCancel(): void
  onConfirm(mode: RemoveWorkDirectoryMode): void
}>

export function RemoveWorkDirectoryDialog(props: Props): React.JSX.Element {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onCancel()
  }}>
    <section
      className="work-name-prompt-dialog remove-work-directory-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-work-directory-title"
      data-testid="remove-work-directory-dialog"
    >
      <header>
        <span className="work-name-prompt-icon remove-work-directory-icon"><AlertTriangle size={16} /></span>
        <div>
          <strong id="remove-work-directory-title">移除工作目录</strong>
          <small>请选择是否同时删除磁盘上的书籍数据</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <code className="work-directory-path">{props.directoryPath}</code>
        <p>不包括数据：仅从应用配置中移除，文件夹保留在磁盘上。</p>
        <p>包括数据：移除配置并删除整个目录，此操作不可恢复。</p>
      </div>
      <footer className="remove-work-directory-actions">
        <button type="button" disabled={props.busy} onClick={props.onCancel}>取消</button>
        <button
          type="button"
          className="secondary-command"
          data-testid="remove-work-directory-keep-data"
          disabled={props.busy}
          onClick={() => { props.onConfirm("keep_data"); }}
        >
          {props.busy ? "处理中…" : "不包括数据"}
        </button>
        <button
          type="button"
          className="dialog-primary-command destructive-command"
          data-testid="remove-work-directory-include-data"
          disabled={props.busy}
          onClick={() => { props.onConfirm("include_data"); }}
        >
          {props.busy ? "处理中…" : "包括数据(高危)"}
        </button>
      </footer>
    </section>
  </div>
}
