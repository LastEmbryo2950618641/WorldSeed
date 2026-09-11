import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, FilePlus2, GitCompareArrows, History, PencilLine, RotateCcw, Send, ShieldCheck } from "lucide-react"

import { UiTooltip } from "../../components/UiTooltip.js"
import {
  presentDraftAxis,
  presentOfficialAxis,
  type PrototypeDraftVersion,
  type VersionMark,
} from "./chapter-draft-versions-prototype.js"
import type { RevisionStage } from "./chapter-workspace-types.js"

export type DraftDisplayMode = "edit" | "view" | "diff"

type Props = Readonly<{
  versions: readonly PrototypeDraftVersion[]
  latestVersionId: string
  selectedVersionId: string
  displayMode: DraftDisplayMode
  busy: boolean
  mutable?: boolean
  kind?: "draft" | "official"
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

function VersionMarks(props: Readonly<{ version: PrototypeDraftVersion }>): React.JSX.Element {
  const marks = props.version.marks ?? fallbackMarks(props.version)
  return <>
    {marks.map((mark) => (
      <span key={`${mark.kind}-${mark.text}`} className={`chapter-version-mark chapter-version-mark-${mark.kind}`}>
        {mark.text}
      </span>
    ))}
  </>
}

function fallbackMarks(version: PrototypeDraftVersion): readonly VersionMark[] {
  if (version.sequenceNo === undefined) return []
  return [{ kind: "ordinal", text: `v${String(version.sequenceNo)}` }]
}

function VersionOptionLabel(props: Readonly<{ version: PrototypeDraftVersion }>): React.JSX.Element {
  return <span className="chapter-version-option">
    <span className="chapter-version-title">{props.version.title ?? props.version.label}</span>
    <VersionMarks version={props.version} />
    <span className="sr-only">{props.version.label}</span>
  </span>
}

export function ChapterDraftVersionsPrototype(props: Props): React.JSX.Element {
  const official = props.kind === "official"
  const presented = official ? presentOfficialAxis(props.versions) : presentDraftAxis(props.versions)
  const selected = presented.find((version) => version.versionId === props.selectedVersionId)
    ?? presented.at(-1)
  const canCompare = presented.length > 1
  const canRestore = !official && (props.mutable ?? true) && selected !== undefined && selected.versionId !== props.latestVersionId
  const canCreateDraft = !official && (props.mutable ?? true) && props.displayMode !== "diff"
  const reviewing = props.revisionStage === "reviewing"
  const reviewLabel = reviewing ? "审核中…" : "审核修订"
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLLabelElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointer)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", onPointer)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  return <div className="chapter-draft-versions-prototype" data-testid="chapter-draft-versions-prototype" data-version-kind={official ? "official" : "draft"}>
    <div className="chapter-draft-versions-bar">
      <span className="chapter-draft-versions-label"><History size={12} /> {official ? "正文版本" : "草稿版本"}</span>
      <label className="chapter-draft-version-select" ref={rootRef}>
        <button
          type="button"
          className="chapter-draft-version-trigger"
          data-testid="chapter-draft-version-select"
          aria-label={official ? "正文版本" : "草稿版本"}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => { setOpen((current) => !current); }}
        >
          {selected === undefined
            ? <span className="chapter-version-title">{official ? "暂无正文版本" : "暂无草稿"}</span>
            : <VersionOptionLabel version={selected} />}
          <ChevronDown size={12} className="chapter-draft-version-select-icon" aria-hidden="true" />
        </button>
        <div
          className="chapter-draft-version-menu"
          data-testid="chapter-draft-version-menu"
          role="listbox"
          hidden={!open}
        >
          {presented.map((version) => (
            <button
              key={version.versionId}
              type="button"
              role="option"
              className={version.versionId === selected?.versionId ? "is-selected" : ""}
              aria-selected={version.versionId === selected?.versionId}
              onClick={() => {
                props.onSelectVersion(version.versionId)
                setOpen(false)
              }}
            >
              <VersionOptionLabel version={version} />
            </button>
          ))}
        </div>
      </label>
      <div className="chapter-draft-versions-actions">
        {official
          ? null
          : props.displayMode === "diff"
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
        {official
          ? null
          : <>
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
        </>}
      </div>
    </div>
  </div>
}
