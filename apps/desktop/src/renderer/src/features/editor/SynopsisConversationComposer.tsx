import { useEffect, useRef, useState } from "react"
import { Bot, ChevronDown, Ellipsis, FileText, Globe, Play, RefreshCw, Send, Settings2, Sparkles, UserRound } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type {
  SynopsisConversationMessage,
  SynopsisConversationSession,
  SynopsisConversationStreamSnapshot,
  SynopsisStagingPromoteProposal,
  ChapterNarrativeIntent,
} from "@worldseed/contracts"

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
  boundaryPace: ChapterNarrativeIntent["boundaryPace"]
  causalityFocus: ChapterNarrativeIntent["causalityFocus"]
  onDescriptionRuleChange(value: string): void
  onProseRuleChange(value: string): void
  onMinimumWordCountChange(value: string): void
  onMaximumWordCountChange(value: string): void
  onBoundaryPaceChange(value: ChapterNarrativeIntent["boundaryPace"]): void
  onCausalityFocusChange(value: ChapterNarrativeIntent["causalityFocus"]): void
}>

type Props = Readonly<{
  projectId: string | undefined
  workspaceRootRef: string | undefined
  session: SynopsisConversationSession | undefined
  messages: readonly SynopsisConversationMessage[]
  busy: boolean
  stream?: SynopsisConversationStreamSnapshot | undefined
  running: boolean
  pendingStagingPromotes?: readonly SynopsisStagingPromoteProposal[]
  onSend(message: string): Promise<void>
  onRefreshChoices(messageId: string): Promise<void>
  onPromoteStaging(): Promise<void>
  onRejectStagingPromote?(proposalIds: readonly string[]): Promise<void>
  onStartTurn(): void
  onOpenSynopsisFile?(path: string): void
}> & PresentationProps

export function SynopsisConversationComposer(props: Props): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false)
  const [goalsOpen, setGoalsOpen] = useState(false)
  const [focusUnfilled, setFocusUnfilled] = useState(false)
  const [choicesRefreshing, setChoicesRefreshing] = useState(false)
  const goals = useDeductionGoals({
    projectId: props.projectId,
    workspaceRootRef: props.workspaceRootRef,
  })
  const chapterSequence = props.session?.chapterSequence ?? 1
  const threadRef = useRef<HTMLDivElement>(null)
  const advancedMenuRef = useRef<HTMLDivElement>(null)
  const stickToLatestRef = useRef(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const visibleMessages = props.messages.filter((message) => message.hidden !== true)

  const scrollThreadToLatest = (): void => {
    const thread = threadRef.current
    if (thread === null) return
    stickToLatestRef.current = true
    setShowJumpToLatest(false)
    thread.scrollTop = thread.scrollHeight
  }

  const submit = async (): Promise<void> => {
    const message = draft.trim()
    if (message.length === 0 || props.busy || choicesRefreshing) return
    setDraft("")
    stickToLatestRef.current = true
    setShowJumpToLatest(false)
    await props.onSend(message)
    await goals.refresh()
  }

  const refreshChoices = async (messageId: string): Promise<void> => {
    if (props.busy || choicesRefreshing) return
    setChoicesRefreshing(true)
    try {
      await props.onRefreshChoices(messageId)
    } finally {
      setChoicesRefreshing(false)
    }
  }

  useEffect(() => {
    if (!stickToLatestRef.current) return
    const thread = threadRef.current
    if (thread === null) return
    thread.scrollTop = thread.scrollHeight
  }, [props.messages.length, props.busy, props.stream?.thinking, props.stream?.content, props.stream?.searching])

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
    if (thread === null) return
    let scrollHideTimer: number | undefined
    const syncStickState = (): void => {
      const nearBottom = isCreationDeskNearBottom(thread)
      stickToLatestRef.current = nearBottom
      setShowJumpToLatest(!nearBottom)
    }
    const showWhileScrolling = (): void => {
      thread.classList.add("is-scrollbar-active")
      if (scrollHideTimer !== undefined) window.clearTimeout(scrollHideTimer)
      scrollHideTimer = window.setTimeout(() => {
        thread.classList.remove("is-scrollbar-active")
      }, 900)
      syncStickState()
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
    syncStickState()
    return () => {
      thread.removeEventListener("scroll", showWhileScrolling)
      thread.removeEventListener("mousemove", onMouseMove)
      thread.removeEventListener("mouseleave", onMouseLeave)
      if (scrollHideTimer !== undefined) window.clearTimeout(scrollHideTimer)
    }
  }, [])

  const badgeCount = toolbarBadgeCount(goals.snapshot, chapterSequence)
  const latestChoiceMessageId = [...visibleMessages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.choices?.length ?? 0) > 0)
    ?.messageId

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
        {(props.pendingStagingPromotes?.length ?? 0) > 0
          ? <div className="synopsis-staging-promote-panel" data-testid="synopsis-staging-promote-panel">
              <div className="synopsis-staging-promote-panel-title">待确认落盘</div>
              {props.pendingStagingPromotes?.map((proposal) => (
                <div className="synopsis-staging-promote-card" key={proposal.proposalId}>
                  <p>{proposal.reason ?? "将暂存区确认内容写入设定集"}</p>
                  <ul>
                    {proposal.settingsWrites.map((write) => (
                      <li key={`${write.entryId}:${write.relativePath}`}>
                        <code>{write.relativePath}</code>
                        <span>{write.mode === "create" ? "新建" : "更新"}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="synopsis-staging-promote-actions">
                    <button
                      type="button"
                      className="synopsis-choice"
                      disabled={props.busy || props.running}
                      onClick={() => { void props.onPromoteStaging() }}
                    >
                      确认落盘到设定集与目标
                    </button>
                    {props.onRejectStagingPromote === undefined
                      ? null
                      : <button
                          type="button"
                          className="synopsis-choice muted"
                          disabled={props.busy || props.running}
                          onClick={() => { void props.onRejectStagingPromote?.([proposal.proposalId]) }}
                        >
                          暂不落盘
                        </button>}
                  </div>
                </div>
              ))}
            </div>
          : null}
        <div className="creation-desk-thread overlay-scrollbar" ref={threadRef} aria-live="polite">
        <div className="creation-desk-thread-inner">
          {visibleMessages.length === 0 && !props.busy
            ? <div className="creation-desk-empty">
                <Sparkles size={28} aria-hidden="true" />
                <h2>剧情梗概讨论</h2>
                <p>描述下一章想怎么写，Agent 会与你讨论并更新 `[剧情梗概].md`。</p>
                {props.session === undefined
                  ? <span className="creation-desk-empty-hint">发送首条消息后将创建占位文件</span>
                  : null}
              </div>
            : <>
                {visibleMessages.map((message) => <article className={`creation-desk-message ${message.role}`} key={message.messageId}>
                  <div className="creation-desk-message-avatar" aria-hidden="true">
                    {message.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}
                  </div>
                  <div className="creation-desk-message-body">
                    <header>{message.role === "user" ? "你" : "Agent"}</header>
                    {message.role === "assistant"
                      ? <AgentStructuredBody
                          thinking={resolveThinkingDisplay(message.reasoningContent)}
                          searching={message.searching}
                          content={message.content}
                          defaultThinkingOpen={false}
                        />
                      : <p>{message.content}</p>}
                    {message.role === "assistant" && message.choices !== undefined && message.choices.length > 0
                      ? <div className="synopsis-conversation-choices">
                          {message.choices.map((choice) => <button
                            key={choice.label}
                            type="button"
                            className="synopsis-choice"
                            disabled={props.running || props.busy || choicesRefreshing}
                            onClick={() => {
                              if (choice.action === "start_turn") {
                                props.onStartTurn()
                                return
                              }
                              if (choice.action === "promote_staging") {
                                void props.onPromoteStaging()
                                return
                              }
                              void props.onSend(choice.label)
                            }}
                          >
                            {choice.label}
                          </button>)}
                          {message.messageId === latestChoiceMessageId
                            ? <button
                                type="button"
                                className={`synopsis-choice-refresh${choicesRefreshing ? " is-spinning" : ""}`}
                                data-testid="synopsis-choice-refresh"
                                title="换一批不同选项"
                                aria-label="换一批不同选项"
                                disabled={props.running || props.busy || choicesRefreshing}
                                onClick={() => {
                                  void refreshChoices(message.messageId)
                                }}
                              >
                                <RefreshCw size={14} aria-hidden="true" />
                              </button>
                            : null}
                        </div>
                      : null}
                  </div>
                </article>)}
                {props.busy
                  ? <article className="creation-desk-message assistant pending" aria-live="polite">
                      <div className="creation-desk-message-avatar" aria-hidden="true"><Bot size={16} /></div>
                      <div className="creation-desk-message-body">
                        <header>Agent</header>
                        <AgentStructuredBody
                          thinking={resolveThinkingDisplay(props.stream?.thinking, props.stream?.content)}
                          searching={props.stream?.searching}
                          content={extractAssistantPreview(props.stream?.content)}
                          defaultThinkingOpen
                          streaming
                        />
                      </div>
                    </article>
                  : null}
              </>}
        </div>
        {showJumpToLatest
          ? <button
              type="button"
              className="creation-desk-jump-latest"
              data-testid="creation-desk-jump-latest"
              onClick={scrollThreadToLatest}
            >
              <ChevronDown size={14} aria-hidden="true" />
              回到最新
            </button>
          : null}
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
          <label>
            <UiTooltip label="管情节节奏，不管设定发散。压而不决：加压与过程选择，禁止不可逆定局。">
              <span>边界节奏</span>
            </UiTooltip>
            <select
              aria-label="边界节奏"
              value={props.boundaryPace}
              onChange={(event) => {
                props.onBoundaryPaceChange(event.target.value as ChapterNarrativeIntent["boundaryPace"])
              }}
            >
              <option value="advance_allowed">可推进（仍贴梗概）</option>
              <option value="hold_without_resolution">压而不决</option>
            </select>
          </label>
          <label>
            <UiTooltip label="本章因果描写重心；细调可在对话里说明。">
              <span>因果焦点</span>
            </UiTooltip>
            <select
              aria-label="因果焦点"
              value={props.causalityFocus}
              onChange={(event) => {
                props.onCausalityFocusChange(event.target.value as ChapterNarrativeIntent["causalityFocus"])
              }}
            >
              <option value="auto">自动</option>
              <option value="buildup">蓄势</option>
              <option value="action">行动</option>
              <option value="payoff">落点</option>
            </select>
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

function AgentStructuredBody({
  thinking,
  searching,
  content,
  defaultThinkingOpen,
  streaming = false,
}: Readonly<{
  thinking?: string | undefined
  searching?: SynopsisConversationStreamSnapshot["searching"] | SynopsisConversationMessage["searching"]
  content?: string | undefined
  defaultThinkingOpen: boolean
  streaming?: boolean
}>): React.JSX.Element {
  const hasThinking = (thinking?.trim().length ?? 0) > 0
  const hasSearching = (searching?.length ?? 0) > 0
  const hasContent = (content?.trim().length ?? 0) > 0
  return <div className="agent-structured-body">
    {hasThinking
      ? <details className="agent-stream-block thinking" open={defaultThinkingOpen}>
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            thinking
            {streaming ? <em>流式</em> : null}
          </summary>
          <div className="agent-stream-thinking-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking ?? ""}</ReactMarkdown>
          </div>
        </details>
      : streaming
        ? <div className="agent-stream-block thinking muted"><span>thinking</span><p className="creation-desk-pending">深度思考中…</p></div>
        : null}
    {hasSearching
      ? <details className="agent-stream-block searching">
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            <Globe size={13} aria-hidden="true" />
            searching
            {streaming ? <em>{(searching ?? []).some((item) => item.status === "running") ? "查询中" : "完成"}</em> : null}
          </summary>
          <ul>
            {(searching ?? []).map((item) => <li key={item.query}>
              <strong>{item.query}</strong>
              <small>{item.status === "running" ? "查询中" : item.status === "failed" ? "失败" : "完成"}</small>
              {item.resultSummary === undefined ? null : <pre>{item.resultSummary}</pre>}
            </li>)}
          </ul>
        </details>
      : null}
    {hasContent
      ? <div className="agent-stream-block final">
          <header>正式输出</header>
          <p>{content}</p>
        </div>
      : streaming
        ? <p className="creation-desk-pending">{hasThinking ? "正在整理正式回复…" : "正在生成正式回复…"}</p>
        : null}
  </div>
}

function resolveThinkingDisplay(thinking: string | undefined, phaseJson?: string): string | undefined {
  return normalizeThinkingDisplayText(thinking) ?? normalizeThinkingDisplayText(phaseJson)
}

/** Keep in sync with apps/backend/.../synopsis-thinking-text.ts */
function normalizeThinkingDisplayText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith("{")) return raw
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : ""
    const selfReview = typeof parsed.selfReview === "string" ? parsed.selfReview.trim() : ""
    const artifact = parsed.artifact !== null && typeof parsed.artifact === "object"
      ? parsed.artifact as Record<string, unknown>
      : undefined
    const finalSelfReview = typeof artifact?.finalSelfReview === "string" ? artifact.finalSelfReview.trim() : ""
    const parts = [reason, selfReview, finalSelfReview].filter((part) => part.length > 0)
    return parts.length === 0 ? undefined : parts.join("\n\n")
  } catch {
    const reason = extractJsonStringField(trimmed, "reason")
    const selfReview = extractJsonStringField(trimmed, "selfReview")
    const finalSelfReview = extractJsonStringField(trimmed, "finalSelfReview")
    const parts = [reason, selfReview, finalSelfReview].filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join("\n\n")
  }
}

function extractJsonStringField(raw: string, field: string): string | undefined {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u"))
  if (match?.[1] === undefined) return undefined
  try {
    const value = JSON.parse(`"${match[1]}"`) as string
    return value.trim().length === 0 ? undefined : value
  } catch {
    const value = match[1]
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
      .trim()
    return value.length === 0 ? undefined : value
  }
}

function extractAssistantPreview(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const match = raw.match(/"assistantMessage"\s*:\s*"((?:\\.|[^"\\])*)"/u)
  if (match?.[1] === undefined) {
    if (raw.trimStart().startsWith("{")) return undefined
    return raw
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
  }
}

const CREATION_DESK_NEAR_BOTTOM_PX = 72

export function isCreationDeskNearBottom(thread: Readonly<{
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}>, thresholdPx = CREATION_DESK_NEAR_BOTTOM_PX): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= thresholdPx
}
