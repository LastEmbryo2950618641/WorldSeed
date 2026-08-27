import type { ReactNode } from "react"

type Props = Readonly<{
  chapterMode: boolean
  chapterPanel: ReactNode
  defaultPanel: ReactNode
}>

export function RightPanelViewport({ chapterMode, chapterPanel, defaultPanel }: Props): React.JSX.Element {
  return <div className="right-panel-viewport" data-testid="right-panel-viewport">
    <div className={`right-panel-layer${chapterMode ? " active" : " inactive"}`} aria-hidden={!chapterMode}>
      {chapterPanel}
    </div>
    <div className={`right-panel-layer${chapterMode ? " inactive" : " active"}`} aria-hidden={chapterMode}>
      {defaultPanel}
    </div>
  </div>
}
