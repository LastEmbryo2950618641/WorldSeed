import { memo, useCallback, useEffect, useRef, useState } from "react"
import { Bot, ChevronDown, Ellipsis, FileText, Globe, Play, RefreshCw, Send, Settings2, Sparkles, Square, UserRound } from "lucide-react"
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
import { listModelCatalog } from "../../api/client.js"
import {
  catalogSignature,
  hasValidBaseUrl,
  isOfficialDeepSeekEndpoint,
} from "../settings/ModelConfigurationDialog.js"
import { toolbarBadgeCount } from "./creation-desk-goals.js"
import { CreationDeskGoalsPopover } from "./CreationDeskGoalsPopover.js"
import { CreationDeskToolbar } from "./CreationDeskToolbar.js"
import {
  discussBusyPhaseLabel,
  discussFinalOutputHeader,
  resolveDiscussBusyPhase,
  type DiscussBusyPhase,
} from "./discuss-busy-phase.js"
import {
  timelineFromMessage,
  toAgentTimeline,
  type AgentTimelineSegment,
} from "./agent-timeline.js"
import { isOutlineMarkdownPath } from "./synopsis-path.js"
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

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

type ModelQuickProfile = Readonly<{
  id: string
  name: string
  model: string
  baseUrl: string
  credentialRef: string
  apiKey: string
  hasApiKey: boolean
  reasoningEffort: ReasoningEffort
}>

type ModelQuickSelectProps = Readonly<{
  modelProfiles: readonly ModelQuickProfile[]
  activeModelProfileId: string
  onActiveModelIdChange(modelId: string): void
  onReasoningEffortChange(effort: ReasoningEffort): void
}>

type Props = Readonly<{
  projectId: string | undefined
  workspaceRootRef: string | undefined
  session: SynopsisConversationSession | undefined
  messages: readonly SynopsisConversationMessage[]
  busy: boolean
  stream?: SynopsisConversationStreamSnapshot | undefined
  draftRestore?: { text: string; token: number } | undefined
  running: boolean
  pendingStagingPromotes?: readonly SynopsisStagingPromoteProposal[]
  onSend(message: string): Promise<void>
  onStop?(): Promise<void>
  onRefreshChoices(messageId: string): Promise<void>
  onPromoteStaging(): Promise<void>
  onRejectStagingPromote?(proposalIds: readonly string[]): Promise<void>
  onStartTurn(): void
  onOpenSynopsisFile?(path: string): void
  onOpenSettingsLineage?(): void
  tokenMetrics?: Readonly<{
    kvRate?: number
    totalTokens?: number
    currentContextTokens?: number
    contextWindowTokens?: number
  }>
}> & PresentationProps & ModelQuickSelectProps

export function SynopsisConversationComposer(props: Props): React.JSX.Element {
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
  const streamPreview = extractAssistantPreview(props.stream?.content)
  // Stream can be "completed" while send() still persists; don't keep showing Stop.
  const discussPhase = resolveDiscussBusyPhase({
    busy: props.busy,
    streamStatus: props.stream?.status,
    hasPreviewContent: (streamPreview?.trim().length ?? 0) > 0,
  })
  const replyFinalizing = discussPhase === "finalizing"
  const showStop = discussPhase === "generating" || discussPhase === "previewing"
  const discussStatusLabel = discussBusyPhaseLabel(discussPhase)

  const scrollThreadToLatest = (): void => {
    const thread = threadRef.current
    if (thread === null) return
    stickToLatestRef.current = true
    setShowJumpToLatest(false)
    thread.scrollTop = thread.scrollHeight
  }

  const sendMessage = useCallback(async (message: string): Promise<void> => {
    stickToLatestRef.current = true
    setShowJumpToLatest(false)
    await props.onSend(message)
    await goals.refresh()
  }, [goals.refresh, props.onSend])

  const refreshChoices = useCallback(async (messageId: string): Promise<void> => {
    if (props.busy || choicesRefreshing) return
    setChoicesRefreshing(true)
    try {
      await props.onRefreshChoices(messageId)
    } finally {
      setChoicesRefreshing(false)
    }
  }, [choicesRefreshing, props.busy, props.onRefreshChoices])

  useEffect(() => {
    if (!stickToLatestRef.current) return
    const thread = threadRef.current
    if (thread === null) return
    thread.scrollTop = thread.scrollHeight
  }, [props.messages.length, props.busy, props.stream?.thinking, props.stream?.thinkingRounds, props.stream?.content, props.stream?.searching, props.stream?.editing])

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
            onUpdateGoal={goals.updateGoal}
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
                {visibleMessages.map((message) => <CreationDeskMessage
                  key={message.messageId}
                  message={message}
                  running={props.running}
                  busy={props.busy}
                  choicesRefreshing={choicesRefreshing}
                  isLatestChoiceMessage={message.messageId === latestChoiceMessageId}
                  onSend={sendMessage}
                  onPromoteStaging={props.onPromoteStaging}
                  onStartTurn={props.onStartTurn}
                  onRefreshChoices={refreshChoices}
                  {...(props.pendingStagingPromotes === undefined
                    ? {}
                    : { pendingStagingPromotes: props.pendingStagingPromotes })}
                  {...(props.onRejectStagingPromote === undefined
                    ? {}
                    : { onRejectStagingPromote: props.onRejectStagingPromote })}
                  {...(props.onOpenSettingsLineage === undefined
                    ? {}
                    : { onOpenSettingsLineage: props.onOpenSettingsLineage })}
                />)}
                {props.busy
                  ? <article className="creation-desk-message assistant pending" aria-live="polite">
                      <div className="creation-desk-message-avatar" aria-hidden="true"><Bot size={16} /></div>
                      <div className="creation-desk-message-body">
                        <header>Agent{discussPhase === "finalizing" ? " · 收尾中" : " · 进行中"}</header>
                        <AgentStructuredBody
                          segments={buildLiveTimeline(props.stream, streamPreview)}
                          mode="live"
                          streaming
                          discussPhase={discussPhase}
                          {...(props.onOpenSettingsLineage === undefined
                            ? {}
                            : { onOpenSettingsLineage: props.onOpenSettingsLineage })}
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
                    {isOutlineMarkdownPath(props.session.synopsisPath) ? "打开纲要文件" : "打开梗概文件"}
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
        {discussStatusLabel === undefined
          ? null
          : <p className="creation-desk-discuss-status" data-testid="creation-desk-discuss-status" aria-live="polite">
              {discussStatusLabel}
              <span className="creation-desk-discuss-status-hint">右侧「运行监控」仅反映正式推演</span>
            </p>}
        <CreationDeskComposerInput
          busy={props.busy}
          running={props.running}
          showStop={showStop}
          replyFinalizing={replyFinalizing}
          advancedMenuOpen={advancedMenuOpen}
          advancedMenuRef={advancedMenuRef}
          modelProfiles={props.modelProfiles}
          activeModelProfileId={props.activeModelProfileId}
          onActiveModelIdChange={props.onActiveModelIdChange}
          onReasoningEffortChange={props.onReasoningEffortChange}
          onToggleAdvancedMenu={() => { setAdvancedMenuOpen((open) => !open); }}
          onCloseAdvancedMenu={() => { setAdvancedMenuOpen(false); }}
          onSend={sendMessage}
          onStartTurn={props.onStartTurn}
          {...(props.tokenMetrics === undefined ? {} : { tokenMetrics: props.tokenMetrics })}
          {...(props.draftRestore === undefined ? {} : { draftRestore: props.draftRestore })}
          {...(props.onStop === undefined ? {} : { onStop: props.onStop })}
        />
      </footer>
    </div>
  </div>
}

type ComposerInputProps = Readonly<{
  busy: boolean
  running: boolean
  showStop: boolean
  replyFinalizing: boolean
  tokenMetrics?: Props["tokenMetrics"]
  draftRestore?: Props["draftRestore"]
  advancedMenuOpen: boolean
  advancedMenuRef: React.RefObject<HTMLDivElement | null>
  modelProfiles: ModelQuickSelectProps["modelProfiles"]
  activeModelProfileId: string
  onActiveModelIdChange(modelId: string): void
  onReasoningEffortChange(effort: ReasoningEffort): void
  onToggleAdvancedMenu(): void
  onCloseAdvancedMenu(): void
  onSend(message: string): Promise<void>
  onStop?(): Promise<void>
  onStartTurn(): void
}>

/** Owns draft text so keystrokes do not re-render the markdown message thread. */
function CreationDeskComposerInput(props: ComposerInputProps): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const [catalogModels, setCatalogModels] = useState<readonly string[]>([])
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const loadedCatalogSigRef = useRef("")

  useEffect(() => {
    if (props.draftRestore === undefined) return
    setDraft(props.draftRestore.text)
  }, [props.draftRestore])

  const activeProfile = props.modelProfiles.find((profile) => profile.id === props.activeModelProfileId)
    ?? props.modelProfiles[0]

  useEffect(() => {
    if (activeProfile === undefined) {
      loadedCatalogSigRef.current = ""
      setCatalogModels([])
      setCatalogStatus("idle")
      return
    }
    const currentModel = activeProfile.model.trim()
    if (!isOfficialDeepSeekEndpoint(activeProfile.baseUrl)) {
      loadedCatalogSigRef.current = ""
      setCatalogModels(currentModel.length === 0 ? [] : [currentModel])
      setCatalogStatus("ready")
      return
    }
    if ((!activeProfile.hasApiKey && activeProfile.apiKey.trim().length === 0) || !hasValidBaseUrl(activeProfile.baseUrl)) {
      loadedCatalogSigRef.current = ""
      setCatalogModels(currentModel.length === 0 ? [] : [currentModel])
      setCatalogStatus("idle")
      return
    }
    const signature = `${activeProfile.id}\u0000${catalogSignature({
      id: activeProfile.id,
      name: activeProfile.name,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model,
      credentialRef: activeProfile.credentialRef,
      apiProtocol: "openai_chat_completions",
      contextWindowTokens: 1,
      apiKey: activeProfile.apiKey,
      hasApiKey: activeProfile.hasApiKey,
      thinkingModeEnabled: true,
      reasoningEffort: activeProfile.reasoningEffort,
      jsonModeEnabled: false,
      disableResponseStorage: true,
      serviceTier: "auto",
    })}`
    if (signature === loadedCatalogSigRef.current) return
    let cancelled = false
    setCatalogStatus("loading")
    const timeout = window.setTimeout(() => {
      void listModelCatalog({
        baseUrl: activeProfile.baseUrl.trim(),
        credentialRef: activeProfile.credentialRef,
        apiKey: activeProfile.apiKey.trim(),
      }).then((result) => {
        if (cancelled) return
        const ids = result.models.map((model) => model.id)
        setCatalogModels(currentModel.length > 0 && !ids.includes(currentModel) ? [currentModel, ...ids] : ids)
        setCatalogStatus("ready")
        loadedCatalogSigRef.current = signature
      }).catch(() => {
        if (cancelled) return
        setCatalogModels(currentModel.length === 0 ? [] : [currentModel])
        setCatalogStatus("error")
        loadedCatalogSigRef.current = signature
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [activeProfile])

  const submit = async (): Promise<void> => {
    const message = draft.trim()
    if (message.length === 0 || props.busy) return
    setDraft("")
    await props.onSend(message)
  }

  const modelOptions = (() => {
    const current = activeProfile?.model.trim() ?? ""
    if (catalogModels.length === 0) return current.length === 0 ? [] : [current]
    if (current.length > 0 && !catalogModels.includes(current)) return [current, ...catalogModels]
    return catalogModels
  })()

  return <div className="creation-desk-composer">
    <div className="creation-desk-token-metrics" data-testid="creation-desk-token-metrics">
      <span>KV <strong>{formatDeskKv(props.tokenMetrics?.kvRate)}</strong></span>
      <span>Token <strong>{formatDeskTokens(props.tokenMetrics?.totalTokens)}</strong></span>
      <span>上下文 <strong>{formatDeskContext(props.tokenMetrics?.currentContextTokens, props.tokenMetrics?.contextWindowTokens)}</strong></span>
    </div>
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
      <div className="creation-desk-model-quick" data-testid="creation-desk-model-quick">
        <label>
          <UiTooltip label="当前模型配置下的可选模型（与「模型配置」里的模型列表相同）">
            <span>模型</span>
          </UiTooltip>
          <select
            aria-label="选择模型"
            value={activeProfile?.model ?? ""}
            disabled={activeProfile === undefined || (modelOptions.length === 0 && catalogStatus === "loading")}
            onChange={(event) => { props.onActiveModelIdChange(event.target.value); }}
          >
            {modelOptions.length === 0
              ? <option value="">
                  {catalogStatus === "loading"
                    ? "正在获取模型…"
                    : catalogStatus === "error"
                      ? "获取失败"
                      : "暂无可用模型"}
                </option>
              : modelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>{modelId}</option>
                ))}
          </select>
        </label>
        <label>
          <UiTooltip label="思考强度 / 推理效果（与「模型配置」中的思考强度相同）">
            <span>效果</span>
          </UiTooltip>
          <select
            aria-label="模型效果"
            value={activeProfile?.reasoningEffort ?? "high"}
            disabled={activeProfile === undefined}
            onChange={(event) => {
              props.onReasoningEffortChange(event.target.value as ReasoningEffort)
            }}
          >
            <option value="none">无</option>
            <option value="minimal">最小</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="xhigh">极高</option>
            <option value="max">最大</option>
          </select>
        </label>
      </div>
      {props.showStop
        ? <button
            type="button"
            className="creation-desk-stop"
            data-testid="creation-desk-stop"
            title="讨论仍在进行，停止将丢弃本轮未完成回复"
            disabled={props.onStop === undefined}
            onClick={() => { void props.onStop?.(); }}
          >
            <Square size={15} aria-hidden="true" />停止
          </button>
        : props.replyFinalizing
          ? <button
              type="button"
              className="creation-desk-send is-finalizing"
              data-testid="creation-desk-finalizing"
              title="可见回复已就绪，正在写入梗概/细纲与消息"
              disabled
            >
              收尾中…
            </button>
          : <button
            type="button"
            className="creation-desk-send"
            disabled={props.running || draft.trim().length === 0}
            onClick={() => { void submit(); }}
          >
            <Send size={15} aria-hidden="true" />发送
          </button>}
      <div className="creation-desk-advanced-menu" ref={props.advancedMenuRef}>
        <UiTooltip label="更多操作">
          <button
            type="button"
            className={`creation-desk-advanced-trigger${props.advancedMenuOpen ? " open" : ""}`}
            data-testid="creation-desk-advanced-trigger"
            aria-label="更多操作"
            aria-expanded={props.advancedMenuOpen}
            aria-haspopup="menu"
            disabled={props.busy && !props.running}
            onClick={() => { props.onToggleAdvancedMenu(); }}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </UiTooltip>
        {props.advancedMenuOpen
          ? <div className="creation-desk-advanced-panel" role="menu" data-testid="creation-desk-advanced-menu">
              <p className="creation-desk-advanced-hint">建议先与 Agent 讨论并确认梗概</p>
              <button
                type="button"
                role="menuitem"
                className="creation-desk-start-turn"
                data-testid="creation-desk-start-turn"
                disabled={props.running || props.busy}
                onClick={() => {
                  props.onCloseAdvancedMenu()
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
}

const CreationDeskMessage = memo(function CreationDeskMessage(props: Readonly<{
  message: SynopsisConversationMessage
  running: boolean
  busy: boolean
  choicesRefreshing: boolean
  isLatestChoiceMessage: boolean
  pendingStagingPromotes?: readonly SynopsisStagingPromoteProposal[]
  onSend(message: string): Promise<void>
  onPromoteStaging(): Promise<void>
  onRejectStagingPromote?(proposalIds: readonly string[]): Promise<void>
  onStartTurn(): void
  onRefreshChoices(messageId: string): Promise<void>
  onOpenSettingsLineage?(): void
}>): React.JSX.Element {
  const { message } = props
  return <article className={`creation-desk-message ${message.role}`}>
    <div className="creation-desk-message-avatar" aria-hidden="true">
      {message.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}
    </div>
    <div className="creation-desk-message-body">
      <header>{message.role === "user" ? "你" : "Agent"}</header>
      {message.role === "assistant"
        ? <AgentStructuredBody
            segments={timelineFromMessage({
              ...message,
              reasoningContent: resolveThinkingDisplay(message.reasoningContent),
              thinkingRounds: message.thinkingRounds?.map((round) => ({
                round: round.round,
                text: resolveThinkingDisplay(round.text) ?? round.text,
              })),
            })}
            mode="persisted"
            {...(props.onOpenSettingsLineage === undefined
              ? {}
              : { onOpenSettingsLineage: props.onOpenSettingsLineage })}
          />
        : <p>{message.content}</p>}
      {message.role === "assistant" && message.choices !== undefined && message.choices.length > 0
        ? <div className="synopsis-conversation-choices">
            {message.choices.map((choice) => <button
              key={choice.label}
              type="button"
              className="synopsis-choice"
              disabled={props.running || props.busy || props.choicesRefreshing}
              onClick={() => {
                if (choice.action === "start_turn") {
                  props.onStartTurn()
                  return
                }
                if (choice.action === "promote_staging") {
                  void props.onPromoteStaging()
                  return
                }
                if (choice.action === "confirm_synopsis") {
                  void props.onSend("用这份梗概写细纲")
                  return
                }
                if (
                  choice.label.includes("暂不落盘")
                  && props.onRejectStagingPromote !== undefined
                  && (props.pendingStagingPromotes?.length ?? 0) > 0
                ) {
                  void props.onRejectStagingPromote(
                    props.pendingStagingPromotes!.map((proposal) => proposal.proposalId),
                  )
                }
                void props.onSend(choice.label)
              }}
            >
              {choice.label}
            </button>)}
            {props.isLatestChoiceMessage
              ? <button
                  type="button"
                  className={`synopsis-choice-refresh${props.choicesRefreshing ? " is-spinning" : ""}`}
                  data-testid="synopsis-choice-refresh"
                  title="换一批不同选项"
                  aria-label="换一批不同选项"
                  disabled={props.running || props.busy || props.choicesRefreshing}
                  onClick={() => {
                    void props.onRefreshChoices(message.messageId)
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </button>
              : null}
          </div>
        : null}
    </div>
  </article>
})

const AgentStructuredBody = memo(function AgentStructuredBody({
  segments,
  mode,
  streaming = false,
  discussPhase = "idle",
  onOpenSettingsLineage,
}: Readonly<{
  segments: readonly AgentTimelineSegment[]
  mode: "live" | "persisted"
  streaming?: boolean
  discussPhase?: DiscussBusyPhase
  onOpenSettingsLineage?(): void
}>): React.JSX.Element {
  const hasAny = segments.length > 0
  const lastThinkingIndex = (() => {
    let index = -1
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]?.kind === "thinking") index = i
    }
    return index
  })()
  return <div className="agent-structured-body">
    {segments.map((segment, index) => {
      if (segment.kind === "thinking") {
        const open = mode === "live" && index === lastThinkingIndex
        return <details
          key={`thinking-${String(segment.round)}-${String(index)}`}
          className="agent-stream-block thinking"
          open={open}
        >
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            thinking
            {streaming && index === lastThinkingIndex ? <em>流式</em> : null}
          </summary>
          <div className="agent-stream-thinking-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.text}</ReactMarkdown>
          </div>
        </details>
      }
      if (segment.kind === "searching") {
        const active = segment.items.some((item) => item.status === "running")
        const noun = streaming && active ? "searching" : "searched"
        return <details
          key={`searching-${String(segment.round)}-${String(index)}`}
          className="agent-stream-block searching"
        >
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            <Globe size={13} aria-hidden="true" />
            {noun}
            <span className="agent-stream-count">{segment.items.length}</span>
            {streaming ? <em>{active ? "查询中" : "完成"}</em> : null}
          </summary>
          <ul>
            {segment.items.map((item) => <li key={`${String(item.round ?? "x")}:${item.query}`}>
              <strong>{item.query}</strong>
              {item.asOfChapterSequence !== undefined && item.temporalRole === "as_of"
                ? onOpenSettingsLineage === undefined
                  ? <span className="settings-as-of-chip">按第 {item.asOfChapterSequence} 章视角（非当前设定全文）</span>
                  : <button
                      type="button"
                      className="settings-as-of-chip settings-as-of-chip-button"
                      onClick={onOpenSettingsLineage}
                    >
                      按第 {item.asOfChapterSequence} 章视角（非当前设定全文）
                    </button>
                : null}
              <small>{item.status === "running" ? "查询中" : item.status === "failed" ? "失败" : "完成"}</small>
              {item.resultSummary === undefined ? null : <pre>{item.resultSummary}</pre>}
            </li>)}
          </ul>
        </details>
      }
      if (segment.kind === "editing") {
        const active = segment.items.some((item) => item.status === "running")
        const noun = streaming && active ? "editing" : "edited"
        return <details
          key={`editing-${String(index)}`}
          className="agent-stream-block editing"
          open
        >
          <summary>
            <ChevronDown size={14} aria-hidden="true" />
            <FileText size={13} aria-hidden="true" />
            {noun}
            <span className="agent-stream-count">{segment.items.length}</span>
            {streaming ? <em>{active ? "写入中" : "已写入"}</em> : null}
          </summary>
          <ul>
            {segment.items.map((item) => <li key={item.path}>
              <strong>{item.path}</strong>
              <small>{item.status === "running"
                ? "写入中"
                : item.status === "failed"
                  ? "未落盘"
                  : "已写入"}</small>
              {item.summary === undefined ? null : <pre>{item.summary}</pre>}
              {item.opsAttempted === undefined
                ? null
                : <small>{`${String(item.opsApplied ?? 0)}/${String(item.opsAttempted)} 处`}</small>}
            </li>)}
          </ul>
        </details>
      }
      const finalHeader = discussFinalOutputHeader(discussPhase, streaming)
      return <div
        key={`final-${String(index)}`}
        className={`agent-stream-block final${streaming && discussPhase !== "idle" ? " is-live" : ""}`}
      >
        <header>{finalHeader}</header>
        <p>{segment.content}</p>
        {streaming && discussPhase === "previewing"
          ? <p className="creation-desk-pending creation-desk-preview-note">预览来自流式解析，本轮尚未结束</p>
          : null}
        {streaming && discussPhase === "finalizing"
          ? <p className="creation-desk-pending creation-desk-preview-note">正在写入工作区与对话记录…</p>
          : null}
      </div>
    })}
    {!hasAny && streaming
      ? <>
          <div className="agent-stream-block thinking muted"><span>thinking</span><p className="creation-desk-pending">深度思考中…</p></div>
          <p className="creation-desk-pending">正在生成正式回复…</p>
        </>
      : null}
    {hasAny && streaming && !segments.some((item) => item.kind === "final") && discussPhase !== "finalizing"
      ? <p className="creation-desk-pending">
          {segments.some((item) => item.kind === "thinking") ? "正在整理正式回复…" : "正在生成正式回复…"}
        </p>
      : null}
  </div>
})

function buildLiveTimeline(
  stream: SynopsisConversationStreamSnapshot | undefined,
  contentPreview: string | undefined,
): AgentTimelineSegment[] {
  if (stream === undefined) return []
  const thinkingRounds = stream.thinkingRounds
    .map((round) => ({
      round: round.round,
      text: resolveThinkingDisplay(round.text) ?? round.text,
    }))
    .filter((round) => round.text.trim().length > 0)
  const liveThinking = resolveThinkingDisplay(stream.thinking, stream.content)
  return toAgentTimeline({
    thinking: liveThinking,
    thinkingRounds: thinkingRounds.length > 0
      ? thinkingRounds
      : liveThinking === undefined
        ? undefined
        : [{ round: Math.max(1, stream.thinkingRounds.at(-1)?.round ?? 1), text: liveThinking }],
    searching: stream.searching,
    editing: stream.editing,
    content: contentPreview ?? extractAssistantPreview(stream.content) ?? (stream.content.trimStart().startsWith("{")
      ? undefined
      : stream.content),
  })
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

function formatDeskKv(rate: number | undefined): string {
  return rate === undefined ? "—" : `${String(Math.round(rate * 100))}%`
}

function formatDeskTokens(total: number | undefined): string {
  if (total === undefined) return "—"
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`
  return String(total)
}

function formatDeskContext(current: number | undefined, maximum: number | undefined): string {
  const left = current === undefined ? "—" : formatDeskTokens(current)
  const right = maximum === undefined || maximum <= 0 ? "—" : formatDeskTokens(maximum)
  return `${left}/${right}`
}

export function isCreationDeskNearBottom(thread: Readonly<{
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}>, thresholdPx = CREATION_DESK_NEAR_BOTTOM_PX): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= thresholdPx
}
