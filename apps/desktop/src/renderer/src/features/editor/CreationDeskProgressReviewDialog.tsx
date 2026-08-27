import { useEffect, useMemo, useState } from "react"
import { X } from "lucide-react"
import type { DeductionGoalsSnapshot } from "@worldseed/contracts"

import { invokeBackend } from "../../api/client.js"
import { listReviewableProgress } from "./creation-desk-goals.js"
import { CreationDeskProgressReview } from "./CreationDeskProgressReview.js"

type Props = Readonly<{
  open: boolean
  projectId: string
  workspaceRootRef: string
  onClose(): void
  onReviewed?(): void
}>

export function CreationDeskProgressReviewDialog(props: Props): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DeductionGoalsSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await invokeBackend<DeductionGoalsSnapshot>("deduction.goals.list", {
        projectId: props.projectId,
        workspaceRootRef: props.workspaceRootRef,
      })
      setSnapshot(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!props.open) return
    void refresh()
  }, [props.open, props.projectId, props.workspaceRootRef])

  const items = useMemo(
    () => listReviewableProgress(snapshot?.goals ?? [], snapshot?.progress ?? []),
    [snapshot],
  )

  if (!props.open) return null

  return <div className="creation-desk-progress-review-dialog" data-testid="creation-desk-progress-review-dialog" role="dialog" aria-label="章后目标复盘">
    <div className="creation-desk-progress-review-dialog-panel">
      <button
        type="button"
        className="creation-desk-progress-review-dialog-close"
        aria-label="关闭"
        onClick={props.onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {error !== undefined ? <div className="creation-desk-goals-error" role="alert">{error}</div> : null}
      {snapshot !== undefined && items.length === 0
        ? <div className="creation-desk-progress-review-empty">
            <p>本章目标已全部复盘完成。</p>
            <button type="button" onClick={props.onClose}>关闭</button>
          </div>
        : <CreationDeskProgressReview
            items={items}
            busy={busy}
            onClose={props.onClose}
            onReview={async (goalId, chapterSequence, status, summary) => {
              setBusy(true)
              setError(undefined)
              try {
                const next = await invokeBackend<DeductionGoalsSnapshot>("deduction.goals.progress.set", {
                  projectId: props.projectId,
                  workspaceRootRef: props.workspaceRootRef,
                  goalId,
                  chapterSequence,
                  summary,
                  status,
                })
                setSnapshot(next)
                const remaining = listReviewableProgress(next.goals, next.progress)
                props.onReviewed?.()
                if (remaining.length === 0) props.onClose()
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                setBusy(false)
              }
            }}
          />}
    </div>
  </div>
}
