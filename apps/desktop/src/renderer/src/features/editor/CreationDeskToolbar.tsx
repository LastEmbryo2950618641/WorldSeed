import { useEffect, useRef } from "react"
import { Target } from "lucide-react"

import { UiTooltip } from "../../components/UiTooltip.js"

type Props = Readonly<{
  goalsOpen: boolean
  badgeCount: number
  onToggleGoals(): void
  onCloseGoals(): void
  goalsPanel: React.ReactNode
}>

export function CreationDeskToolbar(props: Props): React.JSX.Element {
  const toolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!props.goalsOpen) return
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return
      if (event instanceof MouseEvent) {
        const target = event.target
        if (target instanceof Node && toolbarRef.current?.contains(target)) return
      }
      props.onCloseGoals()
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", close)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", close)
    }
  }, [props.goalsOpen, props.onCloseGoals])

  return <div className="creation-desk-toolbar" ref={toolbarRef} data-testid="creation-desk-toolbar">
    {props.goalsOpen ? props.goalsPanel : null}
    <UiTooltip label="推演目标">
      <button
        type="button"
        className={`chapter-editor-chrome-tag creation-desk-toolbar-button${props.goalsOpen ? " is-open" : ""}`}
        data-testid="creation-desk-goals-trigger"
        aria-label="推演目标"
        aria-expanded={props.goalsOpen}
        onClick={props.onToggleGoals}
      >
        <Target size={12} strokeWidth={2} aria-hidden="true" />
        {props.badgeCount > 0
          ? <span className="creation-desk-toolbar-badge" data-testid="creation-desk-goals-badge">
              {props.badgeCount > 9 ? "9+" : String(props.badgeCount)}
            </span>
          : null}
      </button>
    </UiTooltip>
  </div>
}
