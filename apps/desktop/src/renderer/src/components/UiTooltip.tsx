import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { computeUiTooltipPosition, type TooltipPosition } from "./ui-tooltip-position.js"

type Props = Readonly<{
  label: ReactNode
  children: ReactElement
  disabled?: boolean
  rich?: boolean
}>

export { computeUiTooltipPosition, type TooltipPlacement, type TooltipPosition } from "./ui-tooltip-position.js"

export function uiTooltipRich(label: string, detail: string): ReactNode {
  return <>
    <strong>{label}</strong>
    <span>{detail}</span>
  </>
}

export function UiTooltip(props: Props): React.JSX.Element {
  const { label, children, disabled = false, rich = false } = props
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | undefined>(undefined)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const showTimerRef = useRef<number | undefined>(undefined)

  const hasLabel = label !== undefined && label !== null && label !== ""

  const hide = useCallback((): void => {
    if (showTimerRef.current !== undefined) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = undefined
    }
    setOpen(false)
    setPosition(undefined)
  }, [])

  const show = useCallback((): void => {
    if (disabled || !hasLabel) return
    if (showTimerRef.current !== undefined) window.clearTimeout(showTimerRef.current)
    showTimerRef.current = window.setTimeout(() => { setOpen(true) }, 120)
  }, [disabled, hasLabel])

  const updatePosition = useCallback((): void => {
    const anchor = anchorRef.current
    const tooltip = tooltipRef.current
    if (anchor === null || tooltip === null) return
    const rect = anchor.getBoundingClientRect()
    setPosition(computeUiTooltipPosition({
      anchorRect: rect,
      tooltipWidth: tooltip.offsetWidth,
      tooltipHeight: tooltip.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const handleReposition = (): void => { updatePosition() }
    window.addEventListener("scroll", handleReposition, true)
    window.addEventListener("resize", handleReposition)
    return () => {
      window.removeEventListener("scroll", handleReposition, true)
      window.removeEventListener("resize", handleReposition)
    }
  }, [open, label, updatePosition])

  useEffect(() => () => { hide() }, [hide])

  return <>
    <span
      ref={anchorRef}
      className="ui-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
    </span>
    {open && hasLabel && typeof document !== "undefined"
      ? createPortal(
        <div
          ref={tooltipRef}
          className={`ui-tooltip ui-tooltip--${position?.placement ?? "top"}${rich ? " ui-tooltip--rich" : ""}`}
          role="tooltip"
          style={{
            left: position?.left ?? -9999,
            top: position?.top ?? -9999,
            visibility: position === undefined ? "hidden" : "visible",
            ["--ui-tooltip-arrow-x" as string]: position === undefined
              ? "50%"
              : `${String(position.arrowX)}px`,
          }}
        >
          {label}
        </div>,
        document.body,
      )
      : null}
  </>
}
