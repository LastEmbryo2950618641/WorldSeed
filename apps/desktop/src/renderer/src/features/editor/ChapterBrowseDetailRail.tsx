import { useEffect, useMemo, useState } from "react"
import type { DeductionGoal } from "@worldseed/contracts"
import { AlertTriangle, BookOpenText, ChevronDown, ChevronRight, FileText, Link2, Library } from "lucide-react"

import { invokeBackend } from "../../api/client.js"
import {
  listChapterRelevantGoals,
  narrativeKindLabel,
  progressStatusLabel,
  scaleLabel,
} from "./creation-desk-goals.js"
import { resolveDiscussFocusOpenPath, type DiscussFocusChapterOption } from "./synopsis-path.js"
import { useDeductionGoals } from "./use-deduction-goals.js"
import {
  buildVolumeHookDensityReport,
  hookRoleLabel,
  isHookScheduleIncomplete,
  type VolumeChapterHookSummary,
} from "./volume-hook-density.js"

export { isHookScheduleIncomplete } from "./volume-hook-density.js"

export type ChapterBrowseVolumeSelection = Readonly<{
  folderName: string
  chapters: readonly DiscussFocusChapterOption[]
}>

export type ChapterBrowseDetailRailProps = Readonly<{
  projectId: string
  workspaceRootRef: string
  chapter: DiscussFocusChapterOption | undefined
  volume?: ChapterBrowseVolumeSelection
  onOpenBody(path: string): void
}>

export function ChapterBrowseDetailRail(props: ChapterBrowseDetailRailProps): React.JSX.Element {
  const [synopsisMarkdown, setSynopsisMarkdown] = useState<string>()
  const [volumeSynopsis, setVolumeSynopsis] = useState<string>()
  const [synopsisLoading, setSynopsisLoading] = useState(false)
  const [expandedChapters, setExpandedChapters] = useState<ReadonlySet<number>>(() => new Set())
  const goals = useDeductionGoals({
    projectId: props.projectId,
    workspaceRootRef: props.workspaceRootRef,
  })
  const hooks = useMemo(
    () => listChapterHooks(goals.snapshot?.goals ?? [], props.chapter?.sequence),
    [goals.snapshot?.goals, props.chapter?.sequence],
  )
  const volumeHookReport = useMemo(() => {
    if (props.volume === undefined) return undefined
    return buildVolumeHookDensityReport(
      props.volume.chapters,
      goals.snapshot?.goals ?? [],
      goals.snapshot?.progress ?? [],
    )
  }, [goals.snapshot?.goals, goals.snapshot?.progress, props.volume])
  const bodyPath = resolveDiscussFocusOpenPath(props.chapter, "chapter_body")
  const hasBody = props.chapter?.bodyPath !== undefined
  const volumeMode = props.chapter === undefined && props.volume !== undefined

  const volumeFolderKey = props.volume?.folderName
  useEffect(() => {
    setExpandedChapters(new Set())
  }, [volumeFolderKey])
  useEffect(() => {
    if (!volumeMode || volumeHookReport === undefined) return
    setExpandedChapters((current) => {
      if (current.size > 0) return current
      return new Set(
        volumeHookReport.chapterRows
          .filter((row) => row.hookCount > 0)
          .map((row) => row.chapterSequence),
      )
    })
  }, [volumeMode, volumeFolderKey, volumeHookReport])

  useEffect(() => {
    let cancelled = false
    const synopsisPath = props.chapter?.synopsisPath
    if (synopsisPath === undefined) {
      setSynopsisMarkdown(undefined)
      setSynopsisLoading(false)
      return
    }
    setSynopsisLoading(true)
    void (async () => {
      try {
        const result = await invokeBackend<{ content: string }>("workspace.read", {
          workspaceRootRef: props.workspaceRootRef,
          path: synopsisPath,
        })
        if (!cancelled) setSynopsisMarkdown(result.content)
      } catch {
        if (!cancelled) setSynopsisMarkdown(undefined)
      } finally {
        if (!cancelled) setSynopsisLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.chapter?.synopsisPath, props.workspaceRootRef])

  useEffect(() => {
    let cancelled = false
    if (!volumeMode || props.volume === undefined) {
      setVolumeSynopsis(undefined)
      return
    }
    const chapters = props.volume.chapters
    setSynopsisLoading(true)
    void (async () => {
      try {
        const assembled = await assembleVolumeSynopsis(props.workspaceRootRef, chapters)
        if (!cancelled) setVolumeSynopsis(assembled)
      } catch {
        if (!cancelled) setVolumeSynopsis(undefined)
      } finally {
        if (!cancelled) setSynopsisLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [volumeMode, props.volume, props.workspaceRootRef])

  if (props.chapter === undefined && props.volume === undefined) {
    return <aside className="chapter-browse-rail" data-testid="chapter-browse-detail-rail">
      <div className="chapter-browse-rail-empty">
        <BookOpenText size={18} aria-hidden="true" />
        <p>点击左侧卷标题查看本卷梗概，或点击章节卡片查看本章梗概与预留钩子。</p>
      </div>
    </aside>
  }

  if (volumeMode && props.volume !== undefined) {
    const synopsisText = volumeSynopsis?.trim() ?? ""
    const report = volumeHookReport
    return <aside className="chapter-browse-rail" data-testid="chapter-browse-detail-rail" data-mode="volume">
      <header className="chapter-browse-rail-header">
        <h3>{props.volume.folderName}</h3>
        <span className="chapter-browse-volume-meta">{String(props.volume.chapters.length)} 章</span>
      </header>

      <section className="chapter-browse-section" data-testid="chapter-browse-volume-hooks">
        <h4>
          <Link2 size={13} aria-hidden="true" />
          本卷钩子密度
        </h4>
        {report === undefined || report.totals.hookCount === 0
          ? <p className="chapter-browse-muted">本卷尚未登记伏笔 / 高潮钩子。</p>
          : <>
              <div className="chapter-browse-volume-hook-totals" data-testid="chapter-browse-volume-hook-totals">
                <span>钩子 {String(report.totals.hookCount)}</span>
                <span>埋下 {String(report.totals.plantCount)}</span>
                <span>兑现 {String(report.totals.payoffCount)}</span>
                <span>时限完整 {String(report.totals.completeSchedule)}</span>
                <span>时限不完整 {String(report.totals.incompleteSchedule)}</span>
              </div>
              {report.densityWarning === undefined
                ? null
                : <p className="chapter-browse-density-warning" data-testid="chapter-browse-density-warning">
                    <AlertTriangle size={13} aria-hidden="true" />
                    {report.densityWarning}
                  </p>}
              <ul className="chapter-browse-volume-chapter-list">
                {report.chapterRows.map((row) => (
                  <VolumeChapterHookRow
                    key={row.chapterSequence}
                    row={row}
                    expanded={expandedChapters.has(row.chapterSequence)}
                    onToggle={() => {
                      setExpandedChapters((current) => {
                        const next = new Set(current)
                        if (next.has(row.chapterSequence)) next.delete(row.chapterSequence)
                        else next.add(row.chapterSequence)
                        return next
                      })
                    }}
                  />
                ))}
              </ul>
            </>}
      </section>

      <section className="chapter-browse-section" data-testid="chapter-browse-volume-synopsis">
        <h4>
          <Library size={13} aria-hidden="true" />
          本卷梗概
        </h4>
        {synopsisLoading
          ? <p className="chapter-browse-muted">正在汇总本卷章节梗概…</p>
          : synopsisText.length > 0
            ? <pre className="chapter-browse-markdown">{synopsisText}</pre>
            : <p className="chapter-browse-muted">本卷各章尚无剧情梗概可汇总。</p>}
      </section>
    </aside>
  }

  const synopsisText = synopsisMarkdown?.trim() ?? ""
  const synopsisPreview = synopsisText.length > 0
    ? stripLeadingHeadingKeepBody(synopsisMarkdown ?? "")
    : ""

  return <aside className="chapter-browse-rail" data-testid="chapter-browse-detail-rail" data-mode="chapter">
    <header className="chapter-browse-rail-header">
      <h3>{props.chapter!.label}</h3>
      <button
        type="button"
        className="chapter-browse-open-body"
        data-testid="chapter-browse-open-body"
        disabled={bodyPath === undefined}
        onClick={() => {
          if (bodyPath !== undefined) props.onOpenBody(bodyPath)
        }}
      >
        <FileText size={14} aria-hidden="true" />
        {hasBody ? "定位正文" : "打开章节文稿"}
      </button>
    </header>

    <section className="chapter-browse-section" data-testid="chapter-browse-synopsis">
      <h4>
        <BookOpenText size={13} aria-hidden="true" />
        剧情梗概
      </h4>
      {synopsisLoading
        ? <p className="chapter-browse-muted">正在加载梗概…</p>
        : synopsisPreview.length > 0
          ? <pre className="chapter-browse-markdown">{synopsisPreview}</pre>
          : <p className="chapter-browse-muted">本章尚无剧情梗概。</p>}
    </section>

    <section className="chapter-browse-section" data-testid="chapter-browse-hooks">
      <h4>
        <Link2 size={13} aria-hidden="true" />
        本章剧情钩子
      </h4>
      {hooks.length === 0
        ? <p className="chapter-browse-muted">本章尚未预留剧情钩子（伏笔 / 高潮目标）。</p>
        : <ul className="chapter-browse-hook-list">
            {hooks.map((hook) => {
              const incomplete = isHookScheduleIncomplete(hook)
              return <li
                key={hook.goalId}
                className={`chapter-browse-hook-item${incomplete ? " is-incomplete" : ""}`}
                data-testid={incomplete ? "chapter-browse-hook-incomplete" : undefined}
              >
                <div className="chapter-browse-hook-meta">
                  <span className="chapter-browse-hook-kind">
                    {narrativeKindLabel(hook.narrativeKind)}
                    {hook.narrativeKind === "general" ? null : `·${scaleLabel(hook.scale)}`}
                  </span>
                  {formatHookWindow(hook)}
                  {incomplete
                    ? <span className="chapter-browse-hook-incomplete" title="起势章与兑现章须同时填写">
                        时限不完整
                      </span>
                    : null}
                </div>
                <p>{hook.content}</p>
              </li>
            })}
          </ul>}
    </section>
  </aside>
}

export function listChapterHooks(
  goals: readonly DeductionGoal[],
  chapterSequence: number | undefined,
): readonly DeductionGoal[] {
  if (chapterSequence === undefined) return []
  return listChapterRelevantGoals(goals, chapterSequence)
    .filter((goal) => goal.narrativeKind === "foreshadow" || goal.narrativeKind === "climax")
}

function VolumeChapterHookRow(props: Readonly<{
  row: VolumeChapterHookSummary
  expanded: boolean
  onToggle(): void
}>): React.JSX.Element {
  const { row, expanded, onToggle } = props
  const Chevron = expanded ? ChevronDown : ChevronRight
  return <li className="chapter-browse-volume-chapter" data-testid={`chapter-browse-volume-chapter-${String(row.chapterSequence)}`}>
    <button
      type="button"
      className="chapter-browse-volume-chapter-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <Chevron size={14} aria-hidden="true" />
      <span className="chapter-browse-volume-chapter-title">{row.chapterLabel}</span>
      <span className="chapter-browse-volume-chapter-stats">
        埋 {String(row.plantCount)} · 收 {String(row.payoffCount)} · 共 {String(row.hookCount)}
      </span>
    </button>
    <div className="chapter-browse-volume-status-pills">
      {row.statusCounts.incompleteSchedule > 0
        ? <span className="is-warn">时限不完整 {String(row.statusCounts.incompleteSchedule)}</span>
        : null}
      {row.statusCounts.completeSchedule > 0
        ? <span>时限完整 {String(row.statusCounts.completeSchedule)}</span>
        : null}
      {row.statusCounts.planned > 0 ? <span>计划 {String(row.statusCounts.planned)}</span> : null}
      {row.statusCounts.partial > 0 ? <span>推进 {String(row.statusCounts.partial)}</span> : null}
      {row.statusCounts.achieved > 0 ? <span>达成 {String(row.statusCounts.achieved)}</span> : null}
      {row.statusCounts.missed > 0 ? <span>未达 {String(row.statusCounts.missed)}</span> : null}
      {row.hookCount === 0 ? <span className="is-muted">本章无钩子</span> : null}
    </div>
    {expanded && row.hooks.length > 0
      ? <ul className="chapter-browse-hook-list">
          {row.hooks.map((hook) => (
            <li
              key={`${hook.goalId}:${hook.roles.join(",")}`}
              className={`chapter-browse-hook-item${hook.incompleteSchedule ? " is-incomplete" : ""}`}
            >
              <div className="chapter-browse-hook-meta">
                <span className="chapter-browse-hook-kind">
                  {narrativeKindLabel(hook.narrativeKind)}
                  {hook.narrativeKind === "general" ? null : `·${scaleLabel(hook.scale)}`}
                </span>
                <span className="chapter-browse-hook-roles">
                  {hook.roles.map((role) => hookRoleLabel(role)).join("·")}
                </span>
                {formatHookWindow({
                  plantChapterSequence: hook.plantChapterSequence,
                  payoffChapterSequence: hook.payoffChapterSequence,
                })}
                {hook.progressStatus === undefined
                  ? null
                  : <span className="chapter-browse-hook-window">
                      {progressStatusLabel(hook.progressStatus, hook.narrativeKind)}
                    </span>}
                {hook.incompleteSchedule
                  ? <span className="chapter-browse-hook-incomplete">时限不完整</span>
                  : null}
              </div>
              <p>{hook.content}</p>
            </li>
          ))}
        </ul>
      : null}
  </li>
}

export async function assembleVolumeSynopsis(
  workspaceRootRef: string,
  chapters: readonly DiscussFocusChapterOption[],
): Promise<string> {
  const parts: string[] = []
  for (const chapter of chapters) {
    if (chapter.synopsisPath === undefined) continue
    try {
      const result = await invokeBackend<{ content: string }>("workspace.read", {
        workspaceRootRef,
        path: chapter.synopsisPath,
      })
      const body = stripLeadingHeadingKeepBody(result.content)
      if (body.length === 0) continue
      parts.push(`【${chapter.label}】\n${body}`)
    } catch {
      // skip unreadable chapter synopsis
    }
  }
  return parts.join("\n\n")
}

function formatHookWindow(goal: Readonly<{
  plantChapterSequence?: number
  payoffChapterSequence?: number
}>): React.JSX.Element | null {
  const plant = goal.plantChapterSequence
  const payoff = goal.payoffChapterSequence
  if (plant === undefined && payoff === undefined) return null
  const parts: string[] = []
  if (plant !== undefined) parts.push(`埋于第${String(plant)}章`)
  if (payoff !== undefined) parts.push(`收于第${String(payoff)}章`)
  return <span className="chapter-browse-hook-window">{parts.join(" · ")}</span>
}

function stripLeadingHeadingKeepBody(markdown: string): string {
  const normalized = markdown.replace(/\r\n/gu, "\n").trim()
  if (normalized.length === 0) return ""
  // Prefer full synopsis for the detail rail; only drop a lone top heading line.
  const withoutTitle = normalized.replace(/^#[^\n]*\n+/u, "").trim()
  return withoutTitle.length > 0 ? withoutTitle : normalized
}
