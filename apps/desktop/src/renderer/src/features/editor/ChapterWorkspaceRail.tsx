import type { ChapterRevisionConversationMessage, ChapterSynopsis } from "@worldseed/contracts"
import { BookOpenText, FileText, ScrollText } from "lucide-react"

import { ChapterConversationComposer } from "./ChapterConversationComposer.js"
import {
  chapterArtifactStageLabel,
  type ChapterMarkdownKind,
} from "./synopsis-path.js"
import type { RelatedChapterArtifact } from "./ChapterArtifactRelatedRail.js"

type Props = Readonly<{
  messages: readonly ChapterRevisionConversationMessage[]
  revisionTaskId: string | undefined
  busy: boolean
  chapterSynopsis: ChapterSynopsis | undefined
  synopsisPanelOpen: boolean
  relatedArtifacts?: readonly RelatedChapterArtifact[]
  currentKind?: ChapterMarkdownKind
  currentPath?: string
  onToggleSynopsisPanel(): void
  onSend(message: string): Promise<void>
  onInspectDiff(messageId: string): void
  onOpenRelated?(path: string): void
}>

export function ChapterWorkspaceRail(props: Props): React.JSX.Element {
  const related = (props.relatedArtifacts ?? []).filter((item) => item.path !== props.currentPath)
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
    {related.length > 0
      ? <div className="chapter-workspace-related-strip" data-testid="chapter-workspace-related-strip">
          {props.currentKind === undefined
            ? null
            : <span className="chapter-artifact-stage-chip">当前：{chapterArtifactStageLabel(props.currentKind)}</span>}
          {related.map((item) => <RelatedStripCard
            key={item.path}
            item={item}
            onOpen={props.onOpenRelated}
          />)}
        </div>
      : null}
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

function RelatedStripCard(props: Readonly<{
  item: RelatedChapterArtifact
  onOpen?(path: string): void
}>): React.JSX.Element {
  const item = props.item
  return <section className="chapter-artifact-related-card compact" data-testid={`chapter-artifact-related-${item.kind}`}>
    <div className="chapter-artifact-related-card-head">
      {item.kind === "plot_synopsis"
        ? <BookOpenText size={13} aria-hidden="true" />
        : item.kind === "plot_outline"
          ? <ScrollText size={13} aria-hidden="true" />
          : <FileText size={13} aria-hidden="true" />}
      <strong>{chapterArtifactStageLabel(item.kind)}</strong>
      {!item.present ? <em className="missing">尚未创建</em> : null}
      {item.present && props.onOpen !== undefined
        ? <button type="button" onClick={() => { props.onOpen?.(item.path); }}>打开</button>
        : null}
    </div>
    {item.present && item.content !== undefined && item.content.trim().length > 0
      ? <pre className="chapter-artifact-related-preview">{truncatePreview(item.content, 1_200)}</pre>
      : null}
  </section>
}

function truncatePreview(content: string, maxChars: number): string {
  const normalized = content.replace(/\r\n/gu, "\n").trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}…`
}
