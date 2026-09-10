import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, FileText } from "lucide-react"
import type { DiscussFocusKind, SynopsisConversationSession } from "@worldseed/contracts"

import {
  discussFocusOpenLabel,
  resolveDiscussFocusKindForChapter,
  resolveDiscussFocusOpenPath,
  type DiscussFocusChapterOption,
} from "./synopsis-path.js"

type Props = Readonly<{
  session: SynopsisConversationSession
  chapters: readonly DiscussFocusChapterOption[]
  onSelectChapter(sequence: number, focusKind: DiscussFocusKind): void
  onOpenFile(path: string): void
}>

export function CreationDeskFocusBar(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusKind = props.session.focusKind ?? "plot_synopsis"
  const selected = props.chapters.find((item) => item.sequence === props.session.chapterSequence)
  const displayLabel = selected?.label
    ?? (props.session.title.length > 0
      ? `第${String(props.session.chapterSequence)}章 ${props.session.title}`
      : `第${String(props.session.chapterSequence)}章`)
  const filtered = useMemo(() => {
    const needle = query.trim()
    if (needle.length === 0) return props.chapters
    return props.chapters.filter((item) => (
      item.label.includes(needle)
      || String(item.sequence).includes(needle)
    ))
  }, [props.chapters, query])
  const openPath = resolveDiscussFocusOpenPath(selected, focusKind)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery("")
      }
    }
    window.addEventListener("pointerdown", onPointer)
    return () => { window.removeEventListener("pointerdown", onPointer) }
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  return <div className="creation-desk-session-bar" ref={rootRef} data-testid="creation-desk-focus-bar">
    <FileText size={13} aria-hidden="true" />
    <div className="creation-desk-focus-combobox">
      <button
        type="button"
        className="creation-desk-focus-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="当前讨论焦点章节"
        onClick={() => { setOpen((current) => !current); }}
      >
        <span>{displayLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open
        ? <div className="creation-desk-focus-menu" role="listbox">
            <input
              ref={inputRef}
              value={query}
              placeholder="搜索章节…"
              aria-label="搜索章节"
              onChange={(event) => { setQuery(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false)
                  setQuery("")
                }
                if (event.key === "Enter") {
                  const first = filtered[0]
                  if (first !== undefined) {
                    props.onSelectChapter(
                      first.sequence,
                      resolveDiscussFocusKindForChapter(first, focusKind),
                    )
                    setOpen(false)
                    setQuery("")
                  }
                }
              }}
            />
            <ul>
              {filtered.length === 0
                ? <li className="creation-desk-focus-empty">没有匹配的章节</li>
                : filtered.map((item) => <li key={item.sequence}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={item.sequence === props.session.chapterSequence}
                      className={item.sequence === props.session.chapterSequence ? "is-selected" : ""}
                      onClick={() => {
                        props.onSelectChapter(
                          item.sequence,
                          resolveDiscussFocusKindForChapter(item, focusKind),
                        )
                        setOpen(false)
                        setQuery("")
                      }}
                    >
                      {item.label}
                    </button>
                  </li>)}
            </ul>
          </div>
        : null}
    </div>
    {openPath === undefined
      ? null
      : <button
          type="button"
          className="synopsis-open-file"
          onClick={() => { props.onOpenFile(openPath); }}
        >
          {discussFocusOpenLabel(focusKind)}
        </button>}
  </div>
}
