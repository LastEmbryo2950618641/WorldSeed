import { useEffect, useRef, useState } from "react"
import { Bot, Ellipsis, FileText, Play, Send, Settings2, Sparkles, UserRound } from "lucide-react"
import type { SynopsisConversationMessage, SynopsisConversationSession } from "@worldseed/contracts"

import { UiTooltip } from "../../components/UiTooltip.js"
import { toolbarBadgeCount } from "./creation-desk-goals.js"
import { CreationDeskGoalsPopover } from "./CreationDeskGoalsPopover.js"
import { CreationDeskToolbar } from "./CreationDeskToolbar.js"
import { useDeductionGoals } from "./use-deduction-goals.js"

type PresentationProps = Readonly<{
  descriptionRule: string
  proseRule: string
  minimumWordCount: string
  maximumWordCount: string
  wordCountValid: boolean
  descriptionRules: readonly string[]
  proseRules: readonly string[]
  onDescriptionRuleChange(value: string): void
  onProseRuleChange(value: string): void
  onMinimumWordCountChange(value: string): void
  onMaximumWordCountChange(value: string): void
}>

type Props = Readonly<{
  projectId: string | undefined
  workspaceRootRef: string | undefined
  session: SynopsisConversationSession | undefined
  messages: readonly SynopsisConversationMessage[]
  busy: boolean
  running: boolean
  onSend(message: string): Promise<void>
  onStartTurn(): void
  onOpenSynopsisFile?(path: string): void
}> & PresentationProps

export function SynopsisConversationComposer(props: Props): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false)
  const [goalsOpen, setGoalsOpen] = useState(false)
  const [focusUnfilled, setFocusUnfilled] = useState(false)
  const goals = useDeductionGoals({
    projectId: props.projectId,
    workspaceRootRef: props.workspaceRootRef,
  })
  const chapterSequence = props.session?.chapterSequence ?? 1
  const threadRef = useRef<HTMLDivElement>(null)
  const advancedMenuRef = useRef<HTMLDivElement>(null)

  const submit = async (): Promise<void> => {
    const message = draft.trim()
    if (message.length === 0 || props.busy) return
    setDraft("")
    await props.onSend(message)
    await goals.refresh()
  }

  useEffect(() => {
    const thread = threadRef.current
    if (thread === undefined) return
    thread.scrollTop = thread.scrollHeight
  }, [props.messages.length, props.busy])

  useEffect(() => {
    if (!advancedMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && advancedMenuRef.current?.contains(target)) return
      setAdvancedMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setAdvancedMenuOpen(false)
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [advancedMenuOpen])

  useEffect(() => {
    const thread = threadRef.current
    if (thread === undefined) return
    let scrollHideTimer: number | undefined
    const showWhileScrolling = (): void => {
      thread.classList.add("is-scrollbar-active")
      if (scrollHideTimer !== undefined) window.clearTimeout(scrollHideTimer)
      scrollHideTimer = window.setTimeout(() => {
        thread.classList.remove("is-scrollbar-active")
      }, 900)
    }
    const onMouseMove = (event: MouseEvent): void => {
      const rect = thread.getBoundingClientRect()
      const inRail = event.clientX >= rect.right - 14
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom
      thread.classList.toggle("is-scrollbar-hovered", inRail)
    }
    const onMouseLeave = (): void => {
      thread.classList.remove("is-scrollbar-hovered")
    }
    thread.addEventListener("scroll", showWhileScrolling, { passive: true })
    thread.addEventListener("mousemove", onMouseMove)
    thread.addEventListener("mouseleave", onMouseLeave)
    return () => {
      thread.removeEventListener("scroll", showWhileScrolling)
      thread.removeEventListener("mousemove", onMouseMove)
      thread.removeEventListener("mouseleave", onMouseLeave)
      if (scrollHideTimer !== undefined) window.clearTimeout(scrollHideTimer)
    }
  }, [])

  const badgeCount = toolbarBadgeCount(goals.snapshot, chapterSequence)

  return <div className="creation-desk-workspace" data-testid="synopsis-conversation">
    <div className="creation-desk-body">
      <div className="creation-desk-thread-wrap">
        <CreationDeskToolbar
          goalsOpen={goalsOpen}
          badgeCount={badgeCount}
          onToggleGoals={() => {
            setGoalsOpen((open) => {
              if (open) setFocusUnfilled(false)
              return !open
            })
          }}
          onCloseGoals={() => {
            setGoalsOpen(false)
            setFocusUnfilled(false)
          }}
          goalsPanel={<CreationDeskGoalsPopover
            snapshot={goals.snapshot}
            chapterSequence={chapterSequence}
            focusUnfilled={focusUnfilled}
            onClose={() => {
              setGoalsOpen(false)
              setFocusUnfilled(false)
            }}
            onAdd={goals.addGoal}
            onUpdateContent={goals.updateContent}
            onComplete={goals.completeGoal}
            onRemove={goals.removeGoal}
            onSetProgress={goals.setProgress}
            onReviewProgress={goals.reviewProgress}
            onApprove={goals.approveProposals}
            onReject={goals.rejectProposals}
          />}
        />
        <div className="creation-desk-thread overlay-scrollbar" ref={threadRef} aria-live="polite">
        <div className="creation-desk-thread-inner">
          {props.messages.length === 0
            ? <div className="creation-desk-empty">
                <Sparkles size={28} aria-hidden="true" />
                <h2>剧情梗概讨论</h2>
                <p>描述下一章想怎么写，Agent 会与你讨论并更新 `[剧情梗概].md`。</p>
                {props.session === undefined
                  ? <span className="creation-desk-empty-hint">发送首条消息后将创建占位文件</span>
                  : null}
              </div>
            : props.messages.map((message) => <article className={`creation-desk-message ${message.role}`} key={message.messageId}>
                <div className="creation-desk-message-avatar" aria-hidden="true">
                  {message.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}
                </div>
                <div className="creation-desk-message-body">
                  <header>{message.role === "user" ? "你" : "Agent"}</header>
                  <p>{message.content}</p>
                  {message.role === "assistant" && message.choices !== undefined
                    ? <div className="synopsis-conversation-choices">
                        {message.choices.map((choice) => <button
                          key={choice.label}
                          type="button"
                          className="synopsis-choice"
                          disabled={props.running || props.busy}
                          onClick={() => {
                            if (choice.action === "start_turn") props.onStartTurn()
                          }}
                        >
                          {choice.label}
                        </button>)}
                      </div>
                    : null}
                </div>
              </article>)}
        </div>
      </div>
      </div>

      <footer className="creation-desk-footer">
        {props.session !== undefined
          ? <div className="creation-desk-session-bar">
              <FileText size={13} aria-hidden="true" />
              <span>{props.session.synopsisPath}</span>
              {props.onOpenSynopsisFile === undefined
                ? null
                : <button type="button" className="synopsis-open-file" onClick={() => { props.onOpenSynopsisFile?.(props.session!.synopsisPath); }}>
                    打开梗概文件
                  </button>}
            </div>
          : null}
        {goals.error !== undefined
          ? <div className="creation-desk-goals-error" role="alert">{goals.error}</div>
          : null}
        <div className="creation-desk-settings">
          <Settings2 size={13} aria-hidden="true" />
          <label>
            <span>描写</span>
            <select value={props.descriptionRule} onChange={(event) => { props.onDescriptionRuleChange(event.target.value); }}>
              <option value="">自动</option>
              {props.descriptionRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}
            </select>
          </label>
          <label>
            <span>笔风</span>
            <select value={props.proseRule} onChange={(event) => { props.onProseRuleChange(event.target.value); }}>
              <option value="">默认</option>
              {props.proseRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}
            </select>
          </label>
          <label className={`creation-desk-word-count${props.wordCountValid ? "" : " invalid"}`}>
            <UiTooltip label="正文主体字数范围，标题不计入">
              <span>字数</span>
            </UiTooltip>
            <input aria-label="正文最少字数" type="number" min="1" step="100" value={props.minimumWordCount} onChange={(event) => { props.onMinimumWordCountChange(event.target.value); }} />
            <span>—</span>
            <input aria-label="正文最多字数" type="number" min="1" step="100" value={props.maximumWordCount} onChange={(event) => { props.onMaximumWordCountChange(event.target.value); }} />
          </label>
        </div>
        <div className="creation-desk-composer">
          <textarea
            value={draft}
            disabled={props.busy || props.running}
            placeholder="告诉 Agent 下一章想怎么推进…"
            rows={3}
            onChange={(event) => { setDraft(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <div className="creation-desk-composer-actions">
            <button
              type="button"
              className="creation-desk-send"
              disabled={props.busy || props.running || draft.trim().length === 0}
              onClick={() => { void submit(); }}
            >
              <Send size={15} aria-hidden="true" />{props.busy ? "处理中" : "发送"}
            </button>
            <div className="creation-desk-advanced-menu" ref={advancedMenuRef}>
              <UiTooltip label="更多操作">
                <button
                  type="button"
                  className={`creation-desk-advanced-trigger${advancedMenuOpen ? " open" : ""}`}
                  data-testid="creation-desk-advanced-trigger"
                  aria-label="更多操作"
                  aria-expanded={advancedMenuOpen}
                  aria-haspopup="menu"
                  disabled={props.busy && !props.running}
                  onClick={() => { setAdvancedMenuOpen((open) => !open); }}
                >
                  <Ellipsis size={16} aria-hidden="true" />
                </button>
              </UiTooltip>
              {advancedMenuOpen
                ? <div className="creation-desk-advanced-panel" role="menu" data-testid="creation-desk-advanced-menu">
                    <p className="creation-desk-advanced-hint">建议先与 Agent 讨论并确认梗概</p>
                    <button
                      type="button"
                      role="menuitem"
                      className="creation-desk-start-turn"
                      data-testid="creation-desk-start-turn"
                      disabled={props.running || props.busy}
                      onClick={() => {
                        setAdvancedMenuOpen(false)
                        props.onStartTurn()
                      }}
                    >
                      <span><Play size={15} aria-hidden="true" />{props.running ? "推演中" : "开始推演"}</span>
                      <small>使用当前梗概直接推演</small>
                    </button>
                  </div>
                : null}
            </div>
          </div>
        </div>
      </footer>
    </div>
  </div>
}
