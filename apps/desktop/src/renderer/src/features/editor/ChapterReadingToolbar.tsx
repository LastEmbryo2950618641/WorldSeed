import { ChevronDown, Minus, Plus, Type } from "lucide-react"

import type { ChapterFontFamily, ChapterLineHeight, ChapterReadingPreferences } from "./chapter-reading-preferences.js"
import {
  CHAPTER_FONT_FAMILY_OPTIONS,
  CHAPTER_FONT_SIZE_OPTIONS,
  CHAPTER_LINE_HEIGHT_OPTIONS,
} from "./chapter-reading-preferences.js"

type Props = Readonly<{
  variant?: "inline" | "composer" | "embedded"
  preferences: ChapterReadingPreferences
  onReadingChange(patch: Partial<ChapterReadingPreferences>): void
}>

export function ChapterReadingToolbar(props: Props): React.JSX.Element {
  const variant = props.variant === "embedded" ? "composer" : (props.variant ?? "inline")
  const sizeIndex = CHAPTER_FONT_SIZE_OPTIONS.indexOf(
    props.preferences.fontSize as (typeof CHAPTER_FONT_SIZE_OPTIONS)[number],
  )

  if (variant === "composer") {
    const bumpSize = (delta: number): void => {
      const nextIndex = sizeIndex + delta
      if (nextIndex < 0 || nextIndex >= CHAPTER_FONT_SIZE_OPTIONS.length) return
      const nextSize = CHAPTER_FONT_SIZE_OPTIONS[nextIndex]
      if (nextSize === undefined) return
      props.onReadingChange({ fontSize: nextSize })
    }

    return <div className="chapter-reading-composer" data-testid="chapter-reading-toolbar" role="toolbar" aria-label="阅读样式">
      <label className="chapter-reading-composer-select">
        <span className="sr-only">字体</span>
        <select
          aria-label="正文字体"
          value={props.preferences.fontFamily}
          onChange={(event) => { props.onReadingChange({ fontFamily: event.target.value as ChapterFontFamily }); }}
        >
          {CHAPTER_FONT_FAMILY_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <ChevronDown size={12} aria-hidden="true" className="chapter-reading-composer-select-icon" />
      </label>
      <div className="chapter-reading-size-stepper" aria-label="正文字号">
        <button type="button" className="chapter-reading-size-step" disabled={sizeIndex <= 0} onClick={() => { bumpSize(-1); }}>
          <Minus size={12} aria-hidden="true" />
        </button>
        <select
          aria-label="正文字号"
          className="chapter-reading-size-value"
          value={String(props.preferences.fontSize)}
          onChange={(event) => { props.onReadingChange({ fontSize: Number.parseInt(event.target.value, 10) }); }}
        >
          {CHAPTER_FONT_SIZE_OPTIONS.map((size) => (
            <option key={size} value={String(size)}>{String(size)}</option>
          ))}
        </select>
        <button
          type="button"
          className="chapter-reading-size-step"
          disabled={sizeIndex < 0 || sizeIndex >= CHAPTER_FONT_SIZE_OPTIONS.length - 1}
          onClick={() => { bumpSize(1); }}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="chapter-reading-spacing-toggle" role="group" aria-label="正文行距">
        {CHAPTER_LINE_HEIGHT_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={props.preferences.lineHeight === option.id ? "active" : ""}
            aria-pressed={props.preferences.lineHeight === option.id}
            onClick={() => { props.onReadingChange({ lineHeight: option.id as ChapterLineHeight }); }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  }

  return <aside className="chapter-reading-toolbar chapter-reading-toolbar-inline" data-testid="chapter-reading-toolbar" aria-label="阅读样式">
    <span className="chapter-reading-toolbar-label">
      <Type size={14} aria-hidden="true" />
      阅读样式
    </span>
    <label>
      <span>字体</span>
      <select
        aria-label="正文字体"
        value={props.preferences.fontFamily}
        onChange={(event) => { props.onReadingChange({ fontFamily: event.target.value as ChapterFontFamily }); }}
      >
        {CHAPTER_FONT_FAMILY_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
    <label>
      <span>字号</span>
      <select
        aria-label="正文字号"
        value={String(props.preferences.fontSize)}
        onChange={(event) => { props.onReadingChange({ fontSize: Number.parseInt(event.target.value, 10) }); }}
      >
        {CHAPTER_FONT_SIZE_OPTIONS.map((size) => (
          <option key={size} value={String(size)}>{String(size)} px</option>
        ))}
      </select>
    </label>
    <label>
      <span>行距</span>
      <select
        aria-label="正文行距"
        value={props.preferences.lineHeight}
        onChange={(event) => { props.onReadingChange({ lineHeight: event.target.value as ChapterLineHeight }); }}
      >
        {CHAPTER_LINE_HEIGHT_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    </label>
  </aside>
}
