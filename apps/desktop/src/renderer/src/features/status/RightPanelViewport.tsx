import type { ReactNode } from "react"

type Props = Readonly<{
  chapterMode: boolean
  chapterPanel: ReactNode
  defaultPanel: ReactNode
}>

/** Mount only the visible rail — inactive panel stays unmounted to cut DOM/CPU. */
export function RightPanelViewport({ chapterMode, chapterPanel, defaultPanel }: Props): React.JSX.Element {
  return (
    <div className="right-panel-viewport" data-testid="right-panel-viewport">
      <div className="right-panel-layer active" aria-hidden={false}>
        {chapterMode ? chapterPanel : defaultPanel}
      </div>
    </div>
  )
}
