import { Library } from "lucide-react"

type Props = Readonly<{
  busy?: boolean
  onCancel(): void
  onConfirm(): void
}>

export function BrowseAllBooksDialog(props: Props): React.JSX.Element {
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
      aria-labelledby="browse-all-books-title"
      data-testid="browse-all-books-dialog"
    >
      <header>
        <span className="work-name-prompt-icon"><Library size={16} /></span>
        <div>
          <strong id="browse-all-books-title">回到书籍浏览</strong>
          <small>将离开当前书籍工作台</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <p>是否返回所有书籍浏览界面？未保存的对话进度仍保留在本书中，可随时再打开。</p>
      </div>
      <footer>
        <button type="button" disabled={props.busy === true} onClick={props.onCancel}>取消</button>
        <button
          type="button"
          className="dialog-primary-command"
          data-testid="browse-all-books-confirm"
          disabled={props.busy === true}
          onClick={props.onConfirm}
        >
          {props.busy === true ? "处理中…" : "返回浏览"}
        </button>
      </footer>
    </section>
  </div>
}
