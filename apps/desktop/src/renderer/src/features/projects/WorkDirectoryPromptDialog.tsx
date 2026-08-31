import { FolderOpen } from "lucide-react"

type Props = Readonly<{
  defaultDirectory: string
  busy?: boolean
  onConfirmDefault(): void
  onChooseDirectory(): void
}>

export function WorkDirectoryPromptDialog(props: Props): React.JSX.Element {
  return <div className="dialog-backdrop" role="presentation">
    <section
      className="work-name-prompt-dialog work-directory-prompt-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="work-directory-prompt-title"
      data-testid="work-directory-prompt-dialog"
    >
      <header>
        <span className="work-name-prompt-icon"><FolderOpen size={16} /></span>
        <div>
          <strong id="work-directory-prompt-title">选择软件工作目录</strong>
          <small>新建书籍将保存在此目录下的子文件夹中</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <p>默认位置：</p>
        <code className="work-directory-path">{props.defaultDirectory}</code>
        <p>不选择其他位置时，将使用上述默认目录。</p>
      </div>
      <footer>
        <button type="button" disabled={props.busy} onClick={props.onChooseDirectory}>选择其他位置</button>
        <button
          className="dialog-primary-command"
          type="button"
          data-testid="work-directory-prompt-confirm"
          disabled={props.busy}
          onClick={props.onConfirmDefault}
        >
          {props.busy ? "正在保存…" : "使用默认目录"}
        </button>
      </footer>
    </section>
  </div>
}
