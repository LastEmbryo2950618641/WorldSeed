import type { CSSProperties } from "react"
import { useEffect, useState } from "react"

export type ChapterFontFamily = "sans" | "serif" | "kai" | "mono"
export type ChapterLineHeight = "compact" | "normal" | "relaxed"

export type ChapterReadingPreferences = Readonly<{
  fontFamily: ChapterFontFamily
  fontSize: number
  lineHeight: ChapterLineHeight
}>

const STORAGE_KEY = "worldseed.chapterReadingPreferences"

export const CHAPTER_FONT_FAMILY_OPTIONS: readonly Readonly<{ id: ChapterFontFamily; label: string; stack: string }>[] = [
  { id: "sans", label: "黑体", stack: 'Inter, "Microsoft YaHei UI", "Segoe UI", sans-serif' },
  { id: "serif", label: "宋体", stack: 'Georgia, "Noto Serif SC", "Songti SC", serif' },
  { id: "kai", label: "楷体", stack: '"KaiTi", "STKaiti", "Noto Serif SC", serif' },
  { id: "mono", label: "等宽", stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
]

export const CHAPTER_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18] as const

export const CHAPTER_LINE_HEIGHT_OPTIONS: readonly Readonly<{ id: ChapterLineHeight; label: string; value: number }>[] = [
  { id: "compact", label: "紧凑", value: 1.55 },
  { id: "normal", label: "标准", value: 1.75 },
  { id: "relaxed", label: "宽松", value: 2 },
]

const DEFAULT_PREFERENCES: ChapterReadingPreferences = {
  fontFamily: "sans",
  fontSize: 13,
  lineHeight: "normal",
}

export function useChapterReadingPreferences(): readonly [
  ChapterReadingPreferences,
  (patch: Partial<ChapterReadingPreferences>) => void,
] {
  const [preferences, setPreferences] = useState<ChapterReadingPreferences>(() => loadChapterReadingPreferences())

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  }, [preferences])

  const update = (patch: Partial<ChapterReadingPreferences>): void => {
    setPreferences((current) => ({ ...current, ...patch }))
  }

  return [preferences, update]
}

export function chapterBodyStyle(preferences: ChapterReadingPreferences): CSSProperties {
  const family = CHAPTER_FONT_FAMILY_OPTIONS.find((option) => option.id === preferences.fontFamily)?.stack
    ?? CHAPTER_FONT_FAMILY_OPTIONS[0]?.stack
  const lineHeight = CHAPTER_LINE_HEIGHT_OPTIONS.find((option) => option.id === preferences.lineHeight)?.value
    ?? 1.75
  return {
    fontFamily: family,
    fontSize: `${String(preferences.fontSize)}px`,
    lineHeight,
  }
}

function loadChapterReadingPreferences(): ChapterReadingPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<ChapterReadingPreferences>
    const fontFamily = CHAPTER_FONT_FAMILY_OPTIONS.some((option) => option.id === parsed.fontFamily)
      ? parsed.fontFamily as ChapterFontFamily
      : DEFAULT_PREFERENCES.fontFamily
    const fontSize = CHAPTER_FONT_SIZE_OPTIONS.includes(parsed.fontSize as typeof CHAPTER_FONT_SIZE_OPTIONS[number])
      ? parsed.fontSize as number
      : DEFAULT_PREFERENCES.fontSize
    const lineHeight = CHAPTER_LINE_HEIGHT_OPTIONS.some((option) => option.id === parsed.lineHeight)
      ? parsed.lineHeight as ChapterLineHeight
      : DEFAULT_PREFERENCES.lineHeight
    return { fontFamily, fontSize, lineHeight }
  } catch {
    return DEFAULT_PREFERENCES
  }
}
