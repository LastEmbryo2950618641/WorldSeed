import { Check, ChevronDown, FilePlus2, GitCompareArrows, History, PencilLine, RotateCcw, Send, ShieldCheck } from "lucide-react"

import { UiTooltip } from "../../components/UiTooltip.js"
import type { PrototypeDraftVersion } from "./chapter-draft-versions-prototype.js"
import type { RevisionStage } from "./chapter-workspace-types.js"

export type DraftDisplayMode = "edit" | "view" | "diff"

type Props = Readonly<{
  versions: readonly PrototypeDraftVersion[]
  latestVersionId: string
  selectedVersionId: string
  displayMode: DraftDisplayMode
  busy: boolean
  showRevisionActions: boolean
  revisionStage: RevisionStage
  draftChanged: boolean
  onReview(): void
  onDirectSubmit(): void
  onReviewedSubmit(): void
  onSelectVersion(versionId: string): void
  onEnterDiff(): void
  onReturnEdit(): void
  onRestore(version: PrototypeDraftVersion): Promise<void>
  onCreateDraft(): void
}>

export function ChapterDraftVersionsPrototype(props: Props): React.JSX.Element {
  const selected = props.versions.find((version) => version.versionId === props.selectedVersionId)
    ?? props.versions.at(-1)
  const canCompare = props.versions.length > 1
  const canRestore = selected !== undefined && selected.versionId !== props.latestVersionId
  const canCreateDraft = props.displayMode === "edit" && props.selectedVersionId === props.latestVersionId
  const reviewing = props.revisionStage === "reviewing"
  const reviewLabel = reviewing ? "审核中…" : "审核修订"

  return <div className="chapter-draft-versions-prototype" data-testid="chapter-draft-versions-prototype">
    <div className="chapter-draft-versions-bar">
      <span className="chapter-draft-versions-label"><History size={12} /> 草稿版本</span>
      <label className="chapter-draft-version-select">
        <select
          data-testid="chapter-draft-version-select"
          value={selected?.versionId ?? props.latestVersionId}
          onChange={(event) => { props.onSelectVersion(event.target.value); }}
        >
          {props.versions.map((version) => <option key={version.versionId} value={version.versionId}>
            {version.label}
          </option>)}
        </select>
        <ChevronDown size={12} className="chapter-draft-version-select-icon" aria-hidden="true" />
      </label>
      <div className="chapter-draft-versions-actions">
        {props.displayMode === "diff"
          ? <UiTooltip label="返回编辑">
              <button
                type="button"
                className="chapter-draft-version-icon-btn active"
                aria-label="返回编辑"
                onClick={props.onReturnEdit}
              >
                <PencilLine size={13} aria-hidden="true" />
              </button>
            </UiTooltip>
          : <UiTooltip label="版本对比">
              <button
                type="button"
                className="chapter-draft-version-icon-btn"
                aria-label="版本对比"
                disabled={!canCompare}
                onClick={props.onEnterDiff}
              >
                <GitCompareArrows size={13} aria-hidden="true" />
              </button>
            </UiTooltip>}
        <UiTooltip label="应用为最新版本">
          <button
            type="button"
            className="chapter-draft-version-icon-btn"
            aria-label="应用为最新版本"
            disabled={props.busy || !canRestore}
            onClick={() => {
              if (selected === undefined) return
              void props.onRestore(selected)
            }}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </UiTooltip>
        <UiTooltip label="创建新草稿">
          <button
            type="button"
            className="chapter-draft-version-icon-btn"
            data-testid="chapter-draft-version-create"
            aria-label="创建新草稿"
            disabled={props.busy || !canCreateDraft}
            onClick={props.onCreateDraft}
          >
            <FilePlus2 size={13} aria-hidden="true" />
          </button>
        </UiTooltip>
        {props.showRevisionActions
          ? <div className="chapter-draft-revision-actions" data-testid="chapter-revision-actions">
              <UiTooltip label={reviewLabel}>
                <button
                  type="button"
                  className="chapter-draft-version-icon-btn"
                  aria-label={reviewLabel}
                  disabled={!props.draftChanged || reviewing || props.busy}
                  onClick={props.onReview}
                >
                  {reviewing
                    ? <RotateCcw className="revision-spin" size={13} aria-hidden="true" />
                    : <ShieldCheck size={13} aria-hidden="true" />}
                </button>
              </UiTooltip>
              <UiTooltip label="直接提交">
                <button
                  type="button"
                  className="chapter-draft-version-icon-btn primary"
                  aria-label="直接提交"
                  disabled={!props.draftChanged || reviewing || props.busy}
                  onClick={props.onDirectSubmit}
                >
                  <Send size={13} aria-hidden="true" />
                </button>
              </UiTooltip>
              {props.revisionStage === "reviewed"
                ? <UiTooltip label="按审核提交">
                    <button
                      type="button"
                      className="chapter-draft-version-icon-btn"
                      aria-label="按审核提交"
                      disabled={props.busy}
                      onClick={props.onReviewedSubmit}
                    >
                      <Check size={13} aria-hidden="true" />
                    </button>
                  </UiTooltip>
                : null}
            </div>
          : null}
      </div>
    </div>
  </div>
}
