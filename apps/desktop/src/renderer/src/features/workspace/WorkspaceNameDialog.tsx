import { useEffect, useRef, useState } from "react"
import { FilePlus2, FolderPlus } from "lucide-react"

type Props = Readonly<{
  kind: "file" | "directory"
  parentPath: string
  onConfirm(name: string): void
  onCancel(): void
}>

export function WorkspaceNameDialog({ kind, parentPath, onConfirm, onCancel }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(kind === "file" ? "未命名.md" : "未命名文件夹")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (): void => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    onConfirm(trimmed)
  }

  const title = kind === "file" ? "新建 Markdown" : "新建文件夹"
  const label = kind === "file" ? "文件名" : "文件夹名称"
  const Icon = kind === "file" ? FilePlus2 : FolderPlus

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCancel()
  }}>
    <section
      className="work-name-prompt-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-name-prompt-title"
      data-testid="workspace-name-dialog"
    >
      <header>
        <span className="work-name-prompt-icon"><Icon size={16} /></span>
        <div>
          <strong id="workspace-name-prompt-title">{title}</strong>
          <small>位置：{parentPath}</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <label>
          <span>{label}</span>
          <input
            ref={inputRef}
            value={draft}
            maxLength={200}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
              if (event.key === "Escape") onCancel()
            }}
          />
        </label>
        {kind === "file"
          ? <p>可省略扩展名，保存时会自动补上 .md。</p>
          : <p>文件夹名称不能包含斜杠。</p>}
      </div>
      <footer>
        <button type="button" onClick={onCancel}>取消</button>
        <button
          className="dialog-primary-command"
          type="button"
          data-testid="workspace-name-confirm"
          onClick={submit}
        >
          创建
        </button>
      </footer>
    </section>
  </div>
}
