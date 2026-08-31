import { useState } from "react"
import { BookMarked } from "lucide-react"

import { DEFAULT_WORK_NAME } from "./work-name-history.js"

type Props = Readonly<{
  folderLabel: string
  onConfirm(displayName: string): void
  onCancel(): void
}>

export function WorkNamePromptDialog({ folderLabel, onConfirm, onCancel }: Props): React.JSX.Element {
  const [draft, setDraft] = useState("")

  const submit = (useDefault: boolean): void => {
    const trimmed = draft.trim()
    onConfirm(useDefault || trimmed.length === 0 ? DEFAULT_WORK_NAME : trimmed)
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onCancel()
  }}>
    <section className="work-name-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="work-name-prompt-title" data-testid="work-name-prompt-dialog">
      <header>
        <span className="work-name-prompt-icon"><BookMarked size={16} /></span>
        <div>
          <strong id="work-name-prompt-title">填写作品名</strong>
          <small>{folderLabel}</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <label>
          <span>作品名</span>
          <input
            value={draft}
            placeholder={DEFAULT_WORK_NAME}
            autoFocus
            maxLength={200}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(false)
              if (event.key === "Escape") onCancel()
            }}
          />
        </label>
        <p>可跳过；跳过后默认使用「{DEFAULT_WORK_NAME}」。</p>
      </div>
      <footer>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" data-testid="work-name-prompt-skip" onClick={() => { submit(true) }}>跳过</button>
        <button className="dialog-primary-command" type="button" data-testid="work-name-prompt-confirm" onClick={() => { submit(false) }}>创建书籍</button>
      </footer>
    </section>
  </div>
}
