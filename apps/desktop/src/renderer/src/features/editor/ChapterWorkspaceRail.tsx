import type { ChapterRevisionConversationMessage, ChapterSynopsis } from "@worldseed/contracts"
import { BookOpenText } from "lucide-react"

import { ChapterConversationComposer } from "./ChapterConversationComposer.js"

type Props = Readonly<{
  messages: readonly ChapterRevisionConversationMessage[]
  revisionTaskId: string | undefined
  busy: boolean
  chapterSynopsis: ChapterSynopsis | undefined
  synopsisPanelOpen: boolean
  onToggleSynopsisPanel(): void
  onSend(message: string): Promise<void>
  onInspectDiff(messageId: string): void
}>

export function ChapterWorkspaceRail(props: Props): React.JSX.Element {
  return <aside className="chapter-workspace-rail" data-testid="chapter-workspace-rail">
    <div className="chapter-workspace-rail-toolbar">
      <button
        type="button"
        className={props.synopsisPanelOpen ? "active" : ""}
        data-testid="chapter-synopsis-toggle"
        onClick={props.onToggleSynopsisPanel}
      >
        <BookOpenText size={14} aria-hidden="true" /> 剧情梗概
      </button>
    </div>
    {props.synopsisPanelOpen
      ? <div className="chapter-synopsis-panel" data-testid="chapter-synopsis-panel">
          {props.chapterSynopsis === undefined
            ? <p className="chapter-synopsis-empty">本章无剧情梗概记录</p>
            : <pre className="chapter-synopsis-markdown">{props.chapterSynopsis.synopsisMarkdown}</pre>}
        </div>
      : <ChapterConversationComposer
          variant="rail"
          messages={props.messages}
          revisionTaskId={props.revisionTaskId}
          busy={props.busy}
          onSend={props.onSend}
          onInspectDiff={props.onInspectDiff}
        />}
  </aside>
}
