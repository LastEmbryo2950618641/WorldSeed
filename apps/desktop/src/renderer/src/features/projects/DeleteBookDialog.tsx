import { Trash2 } from "lucide-react"

type Props = Readonly<{
  displayName: string
  busy?: boolean
  onCancel(): void
  onConfirm(): void
}>

export function DeleteBookDialog(props: Props): React.JSX.Element {
  return <div
    className="dialog-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && props.busy !== true) props.onCancel()
    }}
  >
    <section
      className="work-name-prompt-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-book-title"
      data-testid="delete-book-dialog"
    >
      <header>
        <span className="work-name-prompt-icon"><Trash2 size={16} /></span>
        <div>
          <strong id="delete-book-title">删除书籍</strong>
          <small>此操作不可撤销</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <p>
          确定删除「{props.displayName}」？将从本机书架移除，并删除工作区与内部数据。
        </p>
      </div>
      <footer>
        <button type="button" disabled={props.busy === true} onClick={props.onCancel}>取消</button>
        <button
          type="button"
          className="destructive-command"
          data-testid="delete-book-confirm"
          disabled={props.busy === true}
          onClick={props.onConfirm}
        >
          {props.busy === true ? "删除中…" : "删除"}
        </button>
      </footer>
    </section>
  </div>
}
