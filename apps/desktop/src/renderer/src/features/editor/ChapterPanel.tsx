import { useEffect, useMemo, useState } from "react"
import type { ChapterRevisionReadResult, ChapterSummary } from "@worldseed/contracts"
import { Columns2, FileText, Hash, LayoutGrid, Pause, Play, Square } from "lucide-react"

import { invokeBackend } from "../../api/client.js"
import { UiTooltip } from "../../components/UiTooltip.js"
import {
  batchPhaseTargetStage,
  type BatchDeductionPhase,
} from "./batch-chapter-deduction.js"
import { countChapterCharacters } from "./chapter-draft-versions-prototype.js"
import {
  groupChaptersByVolume,
  type DiscussFocusChapterOption,
} from "./synopsis-path.js"

export type ChapterPanelCardSize = "large" | "medium" | "small" | "tile"

/** Latest completed artifact stage for a chapter tile/card. */
export type ChapterPanelStage = "empty" | "synopsis" | "outline" | "draft" | "body"

export type ChapterPanelProps = Readonly<{
  chapters: readonly DiscussFocusChapterOption[]
  chapterSummaries: readonly ChapterSummary[]
  unpublishedDrafts: readonly ChapterRevisionReadResult[]
  workspaceRootRef: string
  selectedSequence: number | undefined
  selectedVolumeFolderName?: string
  onSelectChapter: (chapter: DiscussFocusChapterOption) => void
  onSelectVolume?: (volumeFolderName: string) => void
  batchRunning?: boolean
  batchPaused?: boolean
  batchStatusLabel?: string
  batchPhase?: BatchDeductionPhase
  batchChapterSequence?: number
  onStartBatch?(): void
  onStopBatch?(): void
  onPauseBatch?(): void
  onContinueBatch?(): void
  onOpenVolumeOutline?(volumeFolderName: string): void
}>

const CHAPTER_PANEL_STAGE_RANK: Readonly<Record<ChapterPanelStage, number>> = {
  empty: 0,
  synopsis: 1,
  outline: 2,
  draft: 3,
  body: 4,
}

export function resolveChapterPanelStage(
  chapter: DiscussFocusChapterOption,
  draft: ChapterRevisionReadResult | undefined,
): ChapterPanelStage {
  if (chapter.bodyPath !== undefined) return "body"
  if (draft !== undefined && draft.proposedBody.trim().length > 0) return "draft"
  if (chapter.outlinePath !== undefined) return "outline"
  if (chapter.synopsisPath !== undefined) return "synopsis"
  return "empty"
}

export function chapterPanelStageLabel(stage: ChapterPanelStage): string {
  if (stage === "empty") return "未开始"
  if (stage === "synopsis") return "梗概"
  if (stage === "outline") return "细纲"
  if (stage === "draft") return "草稿"
  return "正文"
}

type ChapterCardDetails = Readonly<{
  synopsisPreview: string
  wordCount: number | undefined
  updatedAtMs: number | undefined
}>

const CARD_SIZE_STORAGE_KEY = "worldseed.chapterPanelCardSize"
export const CHAPTER_PANEL_CARD_SIZES = ["large", "medium", "small", "tile"] as const satisfies readonly ChapterPanelCardSize[]

const CARD_SIZE_META: Readonly<Record<ChapterPanelCardSize, Readonly<{
  label: string
  icon: typeof LayoutGrid
}>>> = {
  medium: { label: "中等卡片", icon: LayoutGrid },
  large: { label: "大卡片", icon: Square },
  small: { label: "小卡片", icon: Columns2 },
  tile: { label: "序号方块", icon: Hash },
}

export function ChapterPanel(props: ChapterPanelProps): React.JSX.Element {
  const [cardSize, setCardSize] = useState<ChapterPanelCardSize>(() => loadCardSize())
  const [detailsBySequence, setDetailsBySequence] = useState<ReadonlyMap<number, ChapterCardDetails>>(new Map())
  const activeSequence = props.selectedSequence
  const activeVolume = props.selectedVolumeFolderName
  const summaryBySequence = useMemo(() => {
    const map = new Map<number, ChapterSummary>()
    for (const summary of props.chapterSummaries) {
      if (summary.sequence !== undefined) map.set(summary.sequence, summary)
    }
    return map
  }, [props.chapterSummaries])
  const draftBySequence = useMemo(() => {
    const map = new Map<number, ChapterRevisionReadResult>()
    for (const draft of props.unpublishedDrafts) {
      if (draft.chapterSequence !== undefined) map.set(draft.chapterSequence, draft)
    }
    return map
  }, [props.unpublishedDrafts])
  const volumeGroups = useMemo(() => groupChaptersByVolume(props.chapters), [props.chapters])
  const showVolumeHeaders = volumeGroups.some((group) => group.volumeFolderName !== "未分卷")
  const sizeMeta = CARD_SIZE_META[cardSize]
  const SizeIcon = sizeMeta.icon
  const nextSize = nextCardSize(cardSize)

  useEffect(() => {
    try {
      window.localStorage.setItem(CARD_SIZE_STORAGE_KEY, cardSize)
    } catch {
      // ignore storage failures
    }
  }, [cardSize])

  useEffect(() => {
    let cancelled = false
    const chapters = props.chapters
    if (chapters.length === 0) {
      setDetailsBySequence(new Map())
      return
    }
    void (async () => {
      const entries = await Promise.all(chapters.map(async (chapter) => {
        const summary = summaryBySequence.get(chapter.sequence)
        const draft = draftBySequence.get(chapter.sequence)
        const updatedAtMs = draft?.updatedAtMs ?? summary?.createdAtMs
        let synopsisPreview = ""
        let wordCount: number | undefined
        try {
          if (chapter.synopsisPath !== undefined) {
            const result = await invokeBackend<{ content: string }>("workspace.read", {
              workspaceRootRef: props.workspaceRootRef,
              path: chapter.synopsisPath,
            })
            synopsisPreview = extractSynopsisPreview(result.content)
          }
        } catch {
          synopsisPreview = ""
        }
        try {
          if (chapter.bodyPath !== undefined) {
            const result = await invokeBackend<{ content: string }>("workspace.read", {
              workspaceRootRef: props.workspaceRootRef,
              path: chapter.bodyPath,
            })
            wordCount = countChapterCharacters(stripLeadingHeading(result.content))
          } else if (draft?.proposedBody !== undefined) {
            wordCount = countChapterCharacters(draft.proposedBody)
          }
        } catch {
          wordCount = undefined
        }
        return [chapter.sequence, { synopsisPreview, wordCount, updatedAtMs }] as const
      }))
      if (cancelled) return
      setDetailsBySequence(new Map(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [draftBySequence, props.chapters, props.workspaceRootRef, summaryBySequence])

  return <aside className={`chapter-panel size-${cardSize}`} data-testid="chapter-panel" data-card-size={cardSize}>
    <header className="chapter-panel-header">
      <h3 className="chapter-panel-title">章节面板</h3>
      <div className="chapter-panel-header-actions">
        {props.batchStatusLabel !== undefined && props.batchStatusLabel.length > 0
          ? <span className="chapter-panel-batch-status" data-testid="chapter-panel-batch-status">
              {props.batchStatusLabel}
            </span>
          : null}
        {props.batchRunning === true && props.batchPaused !== true
          ? <>
              <button
                type="button"
                className="chapter-panel-batch-btn"
                data-testid="chapter-panel-batch-pause"
                onClick={() => { props.onPauseBatch?.() }}
              >
                <Pause size={14} aria-hidden="true" />
                暂停
              </button>
              <button
                type="button"
                className="chapter-panel-batch-btn is-stop"
                data-testid="chapter-panel-batch-stop"
                onClick={() => { props.onStopBatch?.() }}
              >
                <Square size={14} aria-hidden="true" />
                停止
              </button>
            </>
          : props.batchPaused === true
            ? <>
                <button
                  type="button"
                  className="chapter-panel-batch-btn"
                  data-testid="chapter-panel-batch-continue"
                  onClick={() => { props.onContinueBatch?.() }}
                >
                  <Play size={14} aria-hidden="true" />
                  继续
                </button>
                <button
                  type="button"
                  className="chapter-panel-batch-btn is-stop"
                  data-testid="chapter-panel-batch-stop"
                  onClick={() => { props.onStopBatch?.() }}
                >
                  <Square size={14} aria-hidden="true" />
                  停止
                </button>
              </>
            : null}
        <span className="chapter-panel-count">{String(props.chapters.length)}</span>
        <UiTooltip label={`卡片大小：${sizeMeta.label}（点击切换为${CARD_SIZE_META[nextSize].label}）`}>
          <button
            type="button"
            className="chapter-panel-size-toggle"
            data-testid="chapter-panel-size-toggle"
            aria-label={`切换卡片大小，当前为${sizeMeta.label}`}
            onClick={() => { setCardSize(nextSize) }}
          >
            <SizeIcon size={15} aria-hidden="true" />
          </button>
        </UiTooltip>
      </div>
    </header>
    <div className="chapter-panel-body">
      {props.chapters.length === 0
        ? <p className="chapter-panel-empty">尚未检测到章节文件。可在创作台讨论生成梗概或正文。</p>
        : volumeGroups.map((group) => {
          const volumeActive = activeVolume === group.volumeFolderName && activeSequence === undefined
          return <section
            key={group.volumeFolderName}
            className="chapter-panel-volume"
            data-testid={`chapter-panel-volume-${group.volumeFolderName}`}
          >
            {showVolumeHeaders && group.volumeFolderName !== "未分卷"
              ? <div className="chapter-panel-volume-header-row">
                  <button
                    type="button"
                    className={`chapter-panel-volume-header${volumeActive ? " is-active" : ""}`}
                    data-testid={`chapter-panel-volume-header-${group.volumeFolderName}`}
                    onClick={() => { props.onSelectVolume?.(group.volumeFolderName) }}
                  >
                    <span className="chapter-panel-volume-label">{group.volumeFolderName}</span>
                    <span className="chapter-panel-volume-count">{String(group.chapters.length)} 章</span>
                  </button>
                  {props.onOpenVolumeOutline === undefined
                    ? null
                    : <button
                        type="button"
                        className="chapter-panel-volume-outline-btn"
                        data-testid={`chapter-panel-volume-outline-${group.volumeFolderName}`}
                        title="查看卷大纲"
                        onClick={() => { props.onOpenVolumeOutline?.(group.volumeFolderName) }}
                      >
                        <FileText size={13} aria-hidden="true" />
                        卷大纲
                      </button>}
                </div>
              : null}
            <div className="chapter-panel-grid">
              {group.chapters.map((chapter) => {
                const details = detailsBySequence.get(chapter.sequence)
                const isActive = activeSequence === chapter.sequence
                const stage = resolveChapterPanelStage(chapter, draftBySequence.get(chapter.sequence))
                const cup = resolveChapterCupState({
                  stage,
                  batchRunning: props.batchRunning === true,
                  batchPhase: props.batchPhase,
                  batchChapterSequence: props.batchChapterSequence,
                  chapterSequence: chapter.sequence,
                })
                const stageTitle = `${chapter.label} · ${chapterPanelStageLabel(stage)}${cup.filling ? ` → ${chapterPanelStageLabel(cup.to)}` : ""}`
                const cupLayer = <span
                  key={`${String(chapter.sequence)}:${cup.from}->${cup.to}:${props.batchPhase ?? "idle"}`}
                  className={`chapter-panel-stage-cup${cup.filling ? " is-filling" : " is-settled"}`}
                  data-testid={`chapter-panel-cup-${String(chapter.sequence)}`}
                  data-from-stage={cup.from}
                  data-to-stage={cup.to}
                  aria-hidden="true"
                  style={{
                    ["--chapter-stage-from" as string]: `var(--chapter-stage-${cup.from})`,
                    ["--chapter-stage-to" as string]: `var(--chapter-stage-${cup.to})`,
                  }}
                />
                if (cardSize === "tile") {
                  return <button
                    key={`${String(chapter.sequence)}:${chapter.bodyPath ?? chapter.outlinePath ?? chapter.synopsisPath ?? chapter.label}`}
                    type="button"
                    className={`chapter-panel-card chapter-panel-tile stage-${stage}${isActive ? " is-active" : ""}${cup.filling ? " is-progressing" : ""}`}
                    data-testid={`chapter-panel-card-${String(chapter.sequence)}`}
                    data-stage={stage}
                    title={stageTitle}
                    aria-label={stageTitle}
                    onClick={() => { props.onSelectChapter(chapter) }}
                  >
                    {cupLayer}
                    <span className="chapter-panel-tile-number">{String(chapter.sequence)}</span>
                  </button>
                }
                return <button
                  key={`${String(chapter.sequence)}:${chapter.bodyPath ?? chapter.outlinePath ?? chapter.synopsisPath ?? chapter.label}`}
                  type="button"
                  className={`chapter-panel-card stage-${stage}${isActive ? " is-active" : ""}${cup.filling ? " is-progressing" : ""}`}
                  data-testid={`chapter-panel-card-${String(chapter.sequence)}`}
                  data-stage={stage}
                  title={stageTitle}
                  onClick={() => { props.onSelectChapter(chapter) }}
                >
                  {cupLayer}
                  <div className="chapter-panel-card-body">
                    <div className="chapter-panel-card-head">
                      <span className="chapter-panel-card-index" aria-hidden="true">{String(chapter.sequence)}</span>
                      <strong className="chapter-panel-card-title">{chapter.label}</strong>
                    </div>
                    {cardSize === "small"
                      ? null
                      : <p className="chapter-panel-card-synopsis">
                          {details?.synopsisPreview !== undefined && details.synopsisPreview.length > 0
                            ? details.synopsisPreview
                            : "暂无章节梗概"}
                        </p>}
                    <footer className="chapter-panel-card-meta">
                      <span>{formatWordCount(details?.wordCount)}</span>
                      <time>{formatUpdatedAt(details?.updatedAtMs)}</time>
                    </footer>
                  </div>
                </button>
              })}
            </div>
          </section>
        })}
    </div>
  </aside>
}

export type ChapterCupState = Readonly<{
  from: ChapterPanelStage
  to: ChapterPanelStage
  filling: boolean
}>

export function resolveChapterCupState(input: Readonly<{
  stage: ChapterPanelStage
  batchRunning: boolean
  batchPhase: BatchDeductionPhase | undefined
  batchChapterSequence: number | undefined
  chapterSequence: number
}>): ChapterCupState {
  const from = input.stage
  if (
    !input.batchRunning
    || input.batchChapterSequence !== input.chapterSequence
    || input.batchPhase === undefined
  ) {
    return { from, to: from, filling: false }
  }
  const target = batchPhaseTargetStage(input.batchPhase)
  if (target === undefined) {
    return { from, to: from, filling: false }
  }
  if (CHAPTER_PANEL_STAGE_RANK[from] >= CHAPTER_PANEL_STAGE_RANK[target]) {
    return { from, to: from, filling: false }
  }
  return { from, to: target, filling: true }
}

export function nextCardSize(current: ChapterPanelCardSize): ChapterPanelCardSize {
  const index = CHAPTER_PANEL_CARD_SIZES.indexOf(current)
  return CHAPTER_PANEL_CARD_SIZES[(index + 1) % CHAPTER_PANEL_CARD_SIZES.length] ?? "medium"
}

function loadCardSize(): ChapterPanelCardSize {
  try {
    if (typeof window === "undefined") return "medium"
    const raw = window.localStorage.getItem(CARD_SIZE_STORAGE_KEY)
    if (raw === "large" || raw === "medium" || raw === "small" || raw === "tile") return raw
  } catch {
    // ignore storage failures
  }
  return "medium"
}

function stripLeadingHeading(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n")
  return normalized.replace(/^#[^\n]*\n+/u, "")
}

export function extractSynopsisPreview(markdown: string, maxChars = 120): string {
  const plain = markdown
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .filter((line) => !/^#{1,6}\s/u.test(line.trim()))
    .join(" ")
    .replace(/[`*_>#\[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  if (plain.length <= maxChars) return plain
  return `${plain.slice(0, maxChars)}…`
}

function formatWordCount(wordCount: number | undefined): string {
  if (wordCount === undefined) return "— 字"
  return `${wordCount.toLocaleString("zh-CN")} 字`
}

function formatUpdatedAt(updatedAtMs: number | undefined, nowMs = Date.now()): string {
  if (updatedAtMs === undefined) return "—"
  const elapsedMs = Math.max(0, nowMs - updatedAtMs)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return new Date(updatedAtMs).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
