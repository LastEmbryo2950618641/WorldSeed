import { useState } from "react"
import { BookOpenText, MessageSquare, ScrollText } from "lucide-react"
import type { ReactNode } from "react"

export type ChapterRailTab = "outline" | "synopsis" | "conversation"

type Props = Readonly<{
  conversation: ReactNode
  synopsisMarkdown?: string
  outlineMarkdown?: string
  synopsisPath?: string
  outlinePath?: string
  activeTab?: ChapterRailTab
  onOpenFile?(path: string): void
}>

const TABS: ReadonlyArray<Readonly<{
  id: ChapterRailTab
  label: string
  testId: string
}>> = [
  { id: "outline", label: "剧情细纲", testId: "chapter-rail-tab-outline" },
  { id: "synopsis", label: "剧情梗概", testId: "chapter-rail-tab-synopsis" },
  { id: "conversation", label: "Agent 对话", testId: "chapter-rail-tab-conversation" },
]

export function ChapterWorkspaceRail(props: Props): React.JSX.Element {
  const [uncontrolledTab, setUncontrolledTab] = useState<ChapterRailTab>("conversation")
  const tab = props.activeTab ?? uncontrolledTab
  const setTab = (next: ChapterRailTab): void => {
    if (props.activeTab === undefined) setUncontrolledTab(next)
  }

  return <aside className="chapter-workspace-rail" data-testid="chapter-workspace-rail">
    <div className="chapter-rail-tabs" data-testid="chapter-rail-tabs" role="tablist" aria-label="章节侧栏">
      {TABS.map((item) => {
        const selected = tab === item.id
        return <button
          key={item.id}
          type="button"
          role="tab"
          className={selected ? "active" : ""}
          aria-selected={selected}
          data-testid={item.testId}
          onClick={() => { setTab(item.id); }}
        >
          {item.id === "outline"
            ? <ScrollText size={12} aria-hidden="true" />
            : item.id === "synopsis"
              ? <BookOpenText size={12} aria-hidden="true" />
              : <MessageSquare size={12} aria-hidden="true" />}
          {item.label}
        </button>
      })}
    </div>
    {tab === "conversation"
      ? props.conversation
      : <ChapterRailDocumentPane
          kind={tab}
          markdown={tab === "outline" ? props.outlineMarkdown : props.synopsisMarkdown}
          filePath={tab === "outline" ? props.outlinePath : props.synopsisPath}
          onOpenFile={props.onOpenFile}
        />}
  </aside>
}

function ChapterRailDocumentPane(props: Readonly<{
  kind: "outline" | "synopsis"
  markdown: string | undefined
  filePath: string | undefined
  onOpenFile?(path: string): void
}>): React.JSX.Element {
  const title = props.kind === "outline" ? "剧情细纲" : "剧情梗概"
  const empty = props.markdown === undefined || props.markdown.trim().length === 0
  const filePath = props.filePath
  return <div
    className="chapter-rail-document"
    data-testid={props.kind === "outline" ? "chapter-outline-panel" : "chapter-synopsis-panel"}
    role="tabpanel"
  >
    <div className="chapter-rail-document-head">
      <strong>{title}</strong>
      {filePath !== undefined && props.onOpenFile !== undefined
        ? <button
            type="button"
            className="chapter-rail-document-open"
            onClick={() => { props.onOpenFile?.(filePath); }}
          >
            在编辑器打开
          </button>
        : null}
    </div>
    {empty
      ? <p className="chapter-synopsis-empty">本章无{title}记录</p>
      : <pre className="chapter-synopsis-markdown">{props.markdown}</pre>}
  </div>
}
