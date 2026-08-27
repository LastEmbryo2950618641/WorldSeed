import { GitCompareArrows } from "lucide-react"

import {
  COMMITTED_DRAFT_VERSION_ID,
  computeLineDiff,
  countChapterCharacters,
  type PrototypeDraftVersion,
} from "./chapter-draft-versions-prototype.js"

function versionOptionLabel(version: PrototypeDraftVersion): string {
  const chars = String(countChapterCharacters(version.body))
  return version.versionId === COMMITTED_DRAFT_VERSION_ID
    ? `正文 (${chars})`
    : `${version.label} (${chars})`
}

type Props = Readonly<{
  versions: readonly PrototypeDraftVersion[]
  baseVersionId: string
  headVersionId: string
  onBaseVersionChange(versionId: string): void
  onHeadVersionChange(versionId: string): void
}>

export function ChapterDraftDiffView(props: Props): React.JSX.Element {
  const base = props.versions.find((version) => version.versionId === props.baseVersionId)
  const head = props.versions.find((version) => version.versionId === props.headVersionId)
  const diffLines = computeLineDiff(base?.body ?? "", head?.body ?? "")
  const added = diffLines.filter((line) => line.type === "add").length
  const removed = diffLines.filter((line) => line.type === "del").length

  return <div className="chapter-draft-diff-view" data-testid="chapter-draft-diff-view">
    <div className="chapter-draft-diff-toolbar">
      <span className="chapter-draft-diff-toolbar-label"><GitCompareArrows size={14} /> 版本对比</span>
      <label className="chapter-draft-diff-picker">
        <span>基准</span>
        <select
          data-testid="chapter-draft-diff-base"
          value={props.baseVersionId}
          onChange={(event) => { props.onBaseVersionChange(event.target.value); }}
        >
          {props.versions.map((version) => <option key={version.versionId} value={version.versionId}>
            {versionOptionLabel(version)}
          </option>)}
        </select>
      </label>
      <label className="chapter-draft-diff-picker">
        <span>对比</span>
        <select
          data-testid="chapter-draft-diff-head"
          value={props.headVersionId}
          onChange={(event) => { props.onHeadVersionChange(event.target.value); }}
        >
          {props.versions.map((version) => <option key={version.versionId} value={version.versionId}>
            {versionOptionLabel(version)}
          </option>)}
        </select>
      </label>
      <button
        type="button"
        className="chapter-draft-diff-against-committed"
        data-testid="chapter-draft-diff-against-committed"
        disabled={props.baseVersionId === COMMITTED_DRAFT_VERSION_ID}
        onClick={() => { props.onBaseVersionChange(COMMITTED_DRAFT_VERSION_ID); }}
      >
        与正文对比
      </button>
    </div>
    <div className="chapter-draft-diff-file">
      <span className="chapter-draft-diff-file-label">{base?.label ?? "基准"} → {head?.label ?? "对比"}</span>
      <span className="chapter-draft-diff-stats">
        {added > 0 ? <span className="chapter-draft-diff-stat-add">+{String(added)}</span> : null}
        {removed > 0 ? <span className="chapter-draft-diff-stat-del">−{String(removed)}</span> : null}
        {added === 0 && removed === 0 ? <span className="chapter-draft-diff-stat-neutral">无变更</span> : null}
      </span>
    </div>
    <pre className="chapter-draft-diff-body" data-testid="chapter-draft-diff-body">
      {diffLines.length === 0
        ? <span className="chapter-draft-diff-empty">两个版本正文相同。</span>
        : diffLines.map((line, index) => <div
            key={`${line.type}-${String(index)}`}
            className={`chapter-draft-diff-line chapter-draft-diff-${line.type}`}
          ><span className="chapter-draft-diff-gutter" aria-hidden="true">{line.type === "add" ? "+" : line.type === "del" ? "−" : ""}</span><span className="chapter-draft-diff-text">{line.text.length === 0 ? " " : line.text}</span></div>)}
    </pre>
  </div>
}
