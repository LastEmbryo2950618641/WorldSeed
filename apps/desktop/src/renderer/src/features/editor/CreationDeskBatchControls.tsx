import { useEffect, useRef, useState } from "react"
import { ChevronDown, ListChecks, Pause, Play, Square } from "lucide-react"

import type { BatchDeductionStatus } from "./batch-chapter-deduction.js"
import {
  volumeBatchProgressStageLabel,
  type VolumeBatchProgressRow,
} from "./volume-batch-deduction.js"

type ProgressStage = VolumeBatchProgressRow["stage"]
type StageTransition = Readonly<{ from: ProgressStage; to: ProgressStage }>

const COLLAPSED_STORAGE_KEY = "worldseed.creationDesk.progressCollapsed"

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0")
  } catch {
    // storage unavailable: collapse state stays in memory only
  }
}

export type CreationDeskBatchControlsProps = Readonly<{
  batchStatus: BatchDeductionStatus
  progressRows: readonly VolumeBatchProgressRow[]
  /** Discuss Agent is operating on chapters (drafts / publish) outside the batch runner. */
  agentActive?: boolean
  agentChapterSequence?: number
  agentStatusLabel?: string
  onStopAgent?(): void
  onPause(): void
  onContinue(): void
  onStop(): void
  onSelectChapter(sequence: number): void
}>

/** Shown while volume/chapter batch runs, or while the discuss Agent works chapter by chapter. */
export function CreationDeskBatchControls(props: CreationDeskBatchControlsProps): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const previousStagesRef = useRef(new Map<number, ProgressStage>())
  const transitionsRef = useRef(new Map<number, StageTransition>())

  for (const row of props.progressRows) {
    const previous = previousStagesRef.current.get(row.sequence)
    if (previous !== undefined && previous !== row.stage) {
      transitionsRef.current.set(row.sequence, { from: previous, to: row.stage })
    }
  }

  useEffect(() => {
    const next = new Map<number, ProgressStage>()
    for (const row of props.progressRows) next.set(row.sequence, row.stage)
    previousStagesRef.current = next
  }, [props.progressRows])

  const running = props.batchStatus.running
  const paused = props.batchStatus.phase === "paused"
  const batchMode = running || paused
  const agentMode = !batchMode && props.agentActive === true
  if (!batchMode && !agentMode) return null
  const statusLabel = batchMode ? props.batchStatus.label : (props.agentStatusLabel ?? "")
  if (props.progressRows.length === 0 && statusLabel.length === 0) return null
  const activeSequence = batchMode ? props.batchStatus.chapterSequence : props.agentChapterSequence
  const doneCount = props.progressRows.filter((row) => row.done).length
  const total = props.progressRows.length

  const toggleCollapsed = (): void => {
    setCollapsed((current) => {
      writeCollapsed(!current)
      return !current
    })
  }

  return <div className="creation-desk-batch-controls" data-testid="creation-desk-batch-controls">
    <div className="creation-desk-batch-actions">
      {batchMode
        ? paused
          ? <button
              type="button"
              className="creation-desk-batch-action"
              data-testid="creation-desk-batch-continue"
              onClick={props.onContinue}
            >
              <Play size={13} aria-hidden="true" />
              继续
            </button>
          : <button
              type="button"
              className="creation-desk-batch-action is-pause"
              data-testid="creation-desk-batch-pause"
              onClick={props.onPause}
            >
              <Pause size={13} aria-hidden="true" />
              暂停
            </button>
        : null}
      <button
        type="button"
        className="creation-desk-batch-action is-stop"
        data-testid="creation-desk-batch-stop"
        onClick={batchMode ? props.onStop : props.onStopAgent}
      >
        <Square size={13} aria-hidden="true" />
        停止
      </button>
      {statusLabel.length > 0
        ? <span className="creation-desk-batch-status" data-testid="creation-desk-batch-status">
            {statusLabel}
          </span>
        : null}
    </div>
    {total > 0
      ? <div
          className={`creation-desk-batch-progress${collapsed ? " is-collapsed" : ""}`}
          data-testid="creation-desk-batch-progress"
        >
          <header>
            <button
              type="button"
              className="creation-desk-batch-progress-toggle"
              data-testid="creation-desk-batch-progress-toggle"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展开章节进度" : "收起章节进度"}
              title={collapsed ? "展开" : "收起"}
              onClick={toggleCollapsed}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <ListChecks size={13} aria-hidden="true" />
            <span>{agentMode ? "Agent 逐章进度" : "本卷推演进度"}</span>
            {props.batchStatus.volumeFolderName === undefined
              ? null
              : <small>{props.batchStatus.volumeFolderName}</small>}
          </header>
          <div className="creation-desk-batch-progress-summary" data-testid="creation-desk-batch-progress-summary">
            <div className="creation-desk-batch-progress-bar" aria-hidden="true">
              <span style={{ width: `${String(Math.round((doneCount / total) * 100))}%` }} />
            </div>
            <span>{`正文 ${String(doneCount)}/${String(total)}`}</span>
          </div>
          {collapsed
            ? null
            : <ul>
                {props.progressRows.map((row) => {
                  const active = activeSequence === row.sequence
                  const progressing = (active && !row.done) || row.stage === "publishing"
                  const transition = transitionsRef.current.get(row.sequence)
                  const growing = transition !== undefined && transition.to === row.stage
                  const baseStage = growing ? transition.from : row.stage
                  return <li key={row.sequence}>
                    <button
                      type="button"
                      className={[
                        "creation-desk-batch-progress-row",
                        `stage-${row.stage}`,
                        row.done ? "is-done" : "",
                        active ? "is-active" : "",
                        progressing ? "is-progressing" : "",
                      ].filter(Boolean).join(" ")}
                      data-testid={`creation-desk-batch-progress-${String(row.sequence)}`}
                      data-stage={row.stage}
                      onClick={() => { props.onSelectChapter(row.sequence) }}
                    >
                      <span className="creation-desk-batch-progress-base" data-stage={baseStage} aria-hidden="true" />
                      <span
                        key={row.stage}
                        className={`creation-desk-batch-progress-fill${growing ? " is-growing" : ""}`}
                        data-stage={row.stage}
                        aria-hidden="true"
                        onAnimationEnd={(event) => {
                          if (event.animationName === "chapter-stage-grow-x") {
                            transitionsRef.current.delete(row.sequence)
                          }
                        }}
                      />
                      <span className="creation-desk-batch-progress-seq">{String(row.sequence)}</span>
                      <span className="creation-desk-batch-progress-label">{row.label}</span>
                      <span className="creation-desk-batch-progress-stage">
                        {volumeBatchProgressStageLabel(row.stage)}
                      </span>
                    </button>
                  </li>
                })}
              </ul>}
        </div>
      : null}
  </div>
}
