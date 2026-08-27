import { SlidersHorizontal } from "lucide-react"
import type { ReactNode } from "react"

import { UiTooltip } from "../../components/UiTooltip.js"

type ToggleProps = Readonly<{
  open: boolean
  onToggle(): void
}>

export function ChapterEditorChromeToggle(props: ToggleProps): React.JSX.Element {
  const label = props.open ? "隐藏排版" : "排版"
  return <UiTooltip label={label}>
    <button
      type="button"
      className={`chapter-editor-chrome-tag ${props.open ? "is-open" : ""}`}
      data-testid="chapter-editor-chrome-toggle"
      aria-label={props.open ? "隐藏排版栏" : "显示排版栏"}
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <SlidersHorizontal size={11} strokeWidth={2} aria-hidden="true" />
    </button>
  </UiTooltip>
}

type PanelProps = Readonly<{
  open: boolean
  children: ReactNode
}>

export function ChapterEditorChromePanel(props: PanelProps): React.JSX.Element {
  return <div
    className={`chapter-editor-chrome ${props.open ? "is-open" : ""}`}
    data-testid="chapter-editor-chrome"
    role="dialog"
    aria-label="排版设置"
    aria-hidden={!props.open}
  >
    <div className="chapter-editor-chrome-inner">{props.children}</div>
  </div>
}
