import { Check, RotateCcw, Send, ShieldCheck } from "lucide-react"

import type { ChapterReadingPreferences } from "./chapter-reading-preferences.js"
import { ChapterReadingToolbar } from "./ChapterReadingToolbar.js"
import type { RevisionStage } from "./chapter-workspace-types.js"

type Props = Readonly<{
  preferences: ChapterReadingPreferences
  paneLabel: string
  wordCount: number
  onReadingChange(patch: Partial<ChapterReadingPreferences>): void
  showActions: boolean
  statusHint: string | undefined
  stage: RevisionStage
  changed: boolean
  busy: boolean
  error: string | undefined
  onReview(): void
  onDirectSubmit(): void
  onReviewedSubmit(): void
}>

export function ChapterWorkspaceToolbar(props: Props): React.JSX.Element {
  const reviewing = props.stage === "reviewing"

  return <div className="chapter-workspace-toolbar" data-testid="chapter-workspace-toolbar">
    {props.error === undefined ? null : <div className="revision-error" role="alert"><span>{props.error}</span></div>}
    <div className="chapter-workspace-toolbar-row">
      <ChapterReadingToolbar
        preferences={props.preferences}
        onReadingChange={props.onReadingChange}
      />
      {props.showActions
        ? <div className="chapter-revision-actions-inline" data-testid="chapter-revision-actions">
            <button
              className="revision-secondary-command"
              disabled={!props.changed || reviewing || props.busy}
              onClick={props.onReview}
            >
              <ShieldCheck size={14} />{reviewing ? "审核中…" : "审核修订"}
            </button>
            <button
              className="revision-primary-command"
              disabled={!props.changed || reviewing || props.busy}
              onClick={props.onDirectSubmit}
            >
              <Send size={14} />直接提交
            </button>
            {props.stage === "reviewed"
              ? <button className="revision-reviewed-submit" disabled={props.busy} onClick={props.onReviewedSubmit}>
                  <Check size={14} />按审核结果提交
                </button>
              : null}
          </div>
        : null}
      <span className="chapter-reading-toolbar-meta">
        {props.paneLabel} · {String(props.wordCount)} 字
        {props.showActions
          ? <>
              <span className="chapter-toolbar-meta-sep" aria-hidden="true">·</span>
              {reviewing
                ? <><RotateCcw className="revision-spin" size={12} />正在审核…</>
                : props.changed ? "草稿有未提交修改" : "修改草稿后可审核或提交"}
            </>
          : props.statusHint !== undefined
            ? <>
                <span className="chapter-toolbar-meta-sep" aria-hidden="true">·</span>
                <span data-testid="chapter-revision-blocked-hint">{props.statusHint}</span>
              </>
            : null}
      </span>
    </div>
  </div>
}
