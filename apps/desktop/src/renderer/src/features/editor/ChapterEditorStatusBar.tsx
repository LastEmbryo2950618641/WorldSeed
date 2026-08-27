import {
  CHAPTER_FONT_FAMILY_OPTIONS,
  type ChapterReadingPreferences,
} from "./chapter-reading-preferences.js"
import { formatStatusBarSavedAt } from "./chapter-draft-versions-prototype.js"
import { UiTooltip } from "../../components/UiTooltip.js"

type Props = Readonly<{
  title: string
  wordCount: number
  preferences: ChapterReadingPreferences
  showSaveTime: boolean
  saveState: "idle" | "saving" | "saved" | "error"
  lastSavedAtMs: number | undefined
}>

export function ChapterEditorStatusBar(props: Props): React.JSX.Element {
  const fontLabel = CHAPTER_FONT_FAMILY_OPTIONS.find((option) => option.id === props.preferences.fontFamily)?.label
    ?? CHAPTER_FONT_FAMILY_OPTIONS[0]?.label
    ?? "黑体"
  const savedLabel = formatStatusBarSavedAt(props.lastSavedAtMs, props.saveState)
  const titleText = props.title.length > 0 ? props.title : "未命名章节"

  return <footer className="chapter-editor-status-bar" data-testid="chapter-editor-status-bar">
    <div className="chapter-editor-status-bar-main">
      {props.showSaveTime
        ? <span className="chapter-editor-status-item" data-testid="chapter-editor-status-saved">
            <span className="chapter-editor-status-label">最近保存</span>
            <span className="chapter-editor-status-value">{savedLabel}</span>
          </span>
        : null}
      <span className="chapter-editor-status-item" data-testid="chapter-editor-status-words">
        <span className="chapter-editor-status-label">字数</span>
        <span className="chapter-editor-status-value">{String(props.wordCount)}</span>
      </span>
      <span className="chapter-editor-status-item" data-testid="chapter-editor-status-font">
        <span className="chapter-editor-status-label">字体</span>
        <span className="chapter-editor-status-value">{fontLabel}</span>
      </span>
      <span className="chapter-editor-status-item" data-testid="chapter-editor-status-font-size">
        <span className="chapter-editor-status-label">字号</span>
        <span className="chapter-editor-status-value">{String(props.preferences.fontSize)}</span>
      </span>
    </div>
    <UiTooltip label={titleText}>
      <span className="chapter-editor-status-item chapter-editor-status-title" data-testid="chapter-editor-status-title">
        <span className="chapter-editor-status-label">标题</span>
        <span className="chapter-editor-status-value">{titleText}</span>
      </span>
    </UiTooltip>
  </footer>
}
