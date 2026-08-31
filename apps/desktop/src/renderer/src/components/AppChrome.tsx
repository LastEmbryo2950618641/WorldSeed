import { useEffect, useState, type ReactNode } from "react"

export function AppTitleBar({
  leading,
  trailing,
}: Readonly<{
  leading?: ReactNode
  trailing?: ReactNode
}>): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const hasWindowBridge = typeof window !== "undefined"
    && window.worldseed !== undefined
    && typeof window.worldseed.windowControl === "function"

  useEffect(() => {
    const bridge = window.worldseed
    if (bridge === undefined || typeof bridge.windowControl !== "function") return
    void bridge.windowControl("isMaximized").then((value) => {
      if (typeof value === "boolean") setMaximized(value)
    })
    return bridge.onWindowMaximized(setMaximized)
  }, [])

  const control = (action: "minimize" | "maximize" | "close"): void => {
    const bridge = window.worldseed
    if (bridge === undefined || typeof bridge.windowControl !== "function") return
    void bridge.windowControl(action).then((value) => {
      if (action === "maximize" && typeof value === "boolean") setMaximized(value)
    }).catch(() => undefined)
  }

  return (
    <header className="chrome-titlebar">
      {leading === undefined || leading === null
        ? null
        : <div className="chrome-titlebar-leading">{leading}</div>}
      <div
        className="chrome-titlebar-drag"
        onDoubleClick={() => { if (hasWindowBridge) control("maximize") }}
      />
      {trailing === undefined || trailing === null
        ? null
        : <div className="chrome-titlebar-trailing">{trailing}</div>}
      {hasWindowBridge
        ? <div className="chrome-window-controls" role="group" aria-label="窗口控制">
          <button
            type="button"
            className="chrome-window-btn chrome-window-btn--min"
            aria-label="最小化"
            title="最小化"
            onClick={() => { control("minimize") }}
          >
            <CartoonMinimizeIcon />
          </button>
          <button
            type="button"
            className="chrome-window-btn chrome-window-btn--max"
            aria-label={maximized ? "还原" : "最大化"}
            title={maximized ? "还原" : "最大化"}
            onClick={() => { control("maximize") }}
          >
            {maximized ? <CartoonRestoreIcon /> : <CartoonMaximizeIcon />}
          </button>
          <button
            type="button"
            className="chrome-window-btn chrome-window-btn--close"
            aria-label="关闭"
            title="关闭"
            onClick={() => { control("close") }}
          >
            <CartoonCloseIcon />
          </button>
        </div>
        : null}
    </header>
  )
}

export function AppChrome({
  children,
  rail,
  titleLeading,
  titleTrailing,
}: Readonly<{
  children: ReactNode
  /** Discord-style left rail; when set, spans full window height beside the title bar. */
  rail?: ReactNode
  /** Controls shown in the title bar, left of the drag region (same row as window buttons). */
  titleLeading?: ReactNode
  /** Controls shown before window buttons (e.g. model / settings). */
  titleTrailing?: ReactNode
}>): React.JSX.Element {
  return (
    <div className={rail === undefined ? "app-chrome" : "app-chrome app-chrome--with-rail"}>
      {rail}
      <div className="app-chrome-main">
        <AppTitleBar leading={titleLeading} trailing={titleTrailing} />
        <div className="app-chrome-body">{children}</div>
      </div>
    </div>
  )
}

function CartoonMinimizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden>
      <rect x="2" y="5.25" width="8" height="1.5" rx="0.4" fill="currentColor" />
    </svg>
  )
}

function CartoonMaximizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden>
      <rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function CartoonRestoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden>
      <rect x="3.6" y="2.2" width="5.6" height="5.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2.2" y="3.8" width="5.6" height="5.6" rx="1" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function CartoonCloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden>
      <path
        d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
