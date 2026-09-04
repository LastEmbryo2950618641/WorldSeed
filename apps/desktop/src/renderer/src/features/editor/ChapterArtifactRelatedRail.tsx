import { BookOpenText, FileText, ScrollText } from "lucide-react"

import {
  chapterArtifactStageLabel,
  type ChapterMarkdownKind,
} from "./synopsis-path.js"

export type RelatedChapterArtifact = Readonly<{
  kind: ChapterMarkdownKind
  path: string
  present: boolean
  content?: string
}>

type Props = Readonly<{
  currentKind: ChapterMarkdownKind
  currentPath: string
  related: readonly RelatedChapterArtifact[]
  onOpen(path: string): void
}>

export function ChapterArtifactRelatedRail(props: Props): React.JSX.Element {
  const stage = chapterArtifactStageLabel(props.currentKind)
  return <aside className="chapter-artifact-related-rail" data-testid="chapter-artifact-related-rail">
    <header className="chapter-artifact-related-header">
      <h3>章关联文稿</h3>
      <span className="chapter-artifact-stage-chip" data-testid="chapter-artifact-stage">
        当前：{stage}
      </span>
    </header>
    <p className="chapter-artifact-related-hint">
      树上默认只显示表面文件；关联前档在此预览，点击「打开」可切换编辑。
    </p>
    <div className="chapter-artifact-related-list">
      {props.related.map((item) => {
        const isCurrent = item.path === props.currentPath
        return <section
          key={item.path}
          className={`chapter-artifact-related-card${isCurrent ? " is-current" : ""}`}
          data-testid={`chapter-artifact-related-${item.kind}`}
        >
          <div className="chapter-artifact-related-card-head">
            {item.kind === "plot_synopsis"
              ? <BookOpenText size={13} aria-hidden="true" />
              : item.kind === "plot_outline"
                ? <ScrollText size={13} aria-hidden="true" />
                : <FileText size={13} aria-hidden="true" />}
            <strong>{chapterArtifactStageLabel(item.kind)}</strong>
            {isCurrent ? <em>正在编辑</em> : null}
            {!item.present ? <em className="missing">尚未创建</em> : null}
            {item.present && !isCurrent
              ? <button type="button" onClick={() => { props.onOpen(item.path); }}>
                  打开
                </button>
              : null}
          </div>
          <code className="chapter-artifact-related-path">{item.path}</code>
          {item.present && item.content !== undefined && item.content.trim().length > 0
            ? <pre className="chapter-artifact-related-preview">{truncatePreview(item.content)}</pre>
            : item.present
              ? <p className="chapter-artifact-related-empty">文件为空</p>
              : <p className="chapter-artifact-related-empty">
                  {item.kind === "plot_synopsis"
                    ? "尚未有关联剧情梗概；可在创作台讨论生成。"
                    : item.kind === "plot_outline"
                      ? "尚未有关联剧情细纲；可在创作台继续细化。"
                      : "尚未发布正式正文。"}
                </p>}
        </section>
      })}
    </div>
  </aside>
}

function truncatePreview(content: string, maxChars = 2_400): string {
  const normalized = content.replace(/\r\n/gu, "\n").trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}…`
}
