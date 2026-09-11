import { Editor, type Monaco } from "@monaco-editor/react"
import { useEffect, useRef, useState } from "react"
import type { editor } from "monaco-editor"
import type { ChapterNarrativeIntent, ChapterRevision, DiscussFocusKind, RevisionDraftVersion, SynopsisConversationMessage, SynopsisConversationSession, SynopsisConversationStreamSnapshot, SynopsisStagingPromoteProposal } from "@worldseed/contracts"
import { WORLDSEED_EDITOR_THEME, ensureWorldseedEditorTheme } from "../../monaco.js"
import { SynopsisConversationComposer } from "./SynopsisConversationComposer.js"
import { isChapterPlanningMarkdownPath, type DiscussFocusChapterOption } from "./synopsis-path.js"
import { AlertTriangle, BookOpenText, RotateCcw, Save, Sparkles } from "lucide-react"
import { ChapterDraftDiffView } from "./ChapterDraftDiffView.js"
import { ChapterDraftVersionsPrototype, type DraftDisplayMode } from "./ChapterDraftVersionsPrototype.js"
import { ChapterWorkspaceToolbar } from "./ChapterWorkspaceToolbar.js"
import { ChapterReadingToolbar } from "./ChapterReadingToolbar.js"
import { ChapterEditorChromePanel, ChapterEditorChromeToggle } from "./ChapterEditorChrome.js"
import { ChapterEditorStatusBar } from "./ChapterEditorStatusBar.js"
import {
  appendManualDraftVersion,
  buildPrototypeDraftVersions,
  COMMITTED_DRAFT_VERSION_ID,
  draftDisplayModeForSelection,
  fromPersistedDraftVersions,
  isCoveringDraft,
  mergeDraftVersionContent,
  preferredWorkingDraftId,
  splitChapterPickerVersions,
  type PrototypeDraftVersion,
} from "./chapter-draft-versions-prototype.js"
import { chapterBodyStyle, useChapterReadingPreferences } from "./chapter-reading-preferences.js"
import {
  isChapterGraphSyncBlocking,
  isChapterRevisionWritable,
  shouldAutoEnsureChapterRevision,
  type ChapterDocumentPane,
  type RevisionStage,
} from "./chapter-workspace-types.js"
import { UiTooltip } from "../../components/UiTooltip.js"

/** Space between text and scrollbar reserved for the floating toolbar (px). */
const CHAPTER_EDITOR_TOOLBAR_LANE = 52
/** Scrollbar width used to position the toolbar just left of it (px). */
const CHAPTER_EDITOR_SCROLLBAR_WIDTH = 6

function syncChapterEditorWrap(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  lastColumnsRef?: { current: number },
): void {
  const layout = editorInstance.getLayoutInfo()
  const fontInfo = editorInstance.getOption(monaco.editor.EditorOption.fontInfo)
  const usableWidth = layout.contentWidth - CHAPTER_EDITOR_TOOLBAR_LANE
  const columns = Math.max(24, Math.floor(usableWidth / fontInfo.typicalHalfwidthCharacterWidth))
  if (lastColumnsRef !== undefined && lastColumnsRef.current === columns) return
  if (lastColumnsRef !== undefined) lastColumnsRef.current = columns
  editorInstance.updateOptions({
    wordWrap: "bounded",
    wordWrapColumn: columns,
  })
}

type Props = Readonly<{
  selectedPath: string | undefined
  openedDocumentPath: string | undefined
  content: string
  dirty: boolean
  readOnly: boolean
  running: boolean
  prompt: string
  descriptionRule: string
  proseRule: string
  minimumWordCount: string
  maximumWordCount: string
  wordCountValid: boolean
  descriptionRules: readonly string[]
  proseRules: readonly string[]
  boundaryPace: ChapterNarrativeIntent["boundaryPace"]
  causalityFocus: ChapterNarrativeIntent["causalityFocus"]
  onContentChange(value: string): void
  onHome(): void
  onOpenDocument(): void
  onPromptChange(value: string): void
  onDescriptionRuleChange(value: string): void
  onProseRuleChange(value: string): void
  onMinimumWordCountChange(value: string): void
  onMaximumWordCountChange(value: string): void
  onBoundaryPaceChange(value: ChapterNarrativeIntent["boundaryPace"]): void
  onCausalityFocusChange(value: ChapterNarrativeIntent["causalityFocus"]): void
  modelProfiles: readonly Readonly<{
    id: string
    name: string
    model: string
    baseUrl: string
    credentialRef: string
    apiKey: string
    hasApiKey: boolean
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  }>[]
  activeModelProfileId: string
  onActiveModelIdChange(modelId: string): void
  onReasoningEffortChange(effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void
  onSave(): void
  onRun(): void
  chapter: Readonly<{ chapterId: string; sourceId: string }> | undefined
  chapterBody: string
  revision: ChapterRevision | undefined
  revisionContent: string | undefined
  persistedDraftVersions?: readonly RevisionDraftVersion[]
  onEnsureRevision(heading: string, body: string): Promise<ChapterRevision | undefined>
  onUpdateRevision(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision>
  onReviewRevision(revisionTaskId: string): Promise<ChapterRevision>
  onSubmitRevision(input: Readonly<{ revisionTaskId: string; mode: "direct" | "reviewed"; forced: boolean; reviewId?: string }>): Promise<ChapterRevision>
  onRetireRevision(revisionTaskId: string): Promise<ChapterRevision>
  onAppendPersistedDraft?(input: Readonly<{ heading: string; body: string }>): Promise<void>
  onRestorePersistedDraft?(versionId: string): Promise<void>
  projectId: string | undefined
  workspaceRootRef: string | undefined
  synopsisSession: SynopsisConversationSession | undefined
  synopsisMessages: readonly SynopsisConversationMessage[]
  synopsisBusy: boolean
  synopsisStream?: SynopsisConversationStreamSnapshot | undefined
  synopsisDraftRestore?: { text: string; token: number } | undefined
  pendingStagingPromotes?: readonly SynopsisStagingPromoteProposal[]
  onSynopsisSend(message: string): Promise<void>
  onSynopsisStop?(): Promise<void>
  onSynopsisRefreshChoices(messageId: string): Promise<void>
  onPromoteStaging(): Promise<void>
  onPromoteDraftToBody?(): Promise<void>
  onRejectStagingPromote?(proposalIds: readonly string[]): Promise<void>
  onOpenSynopsisFile(path: string): void
  onSetFocus?(sequence: number, focusKind: DiscussFocusKind): void
  focusChapters?: readonly DiscussFocusChapterOption[]
  onOpenSettingsLineage?(): void
  synopsisTokenMetrics?: Readonly<{
    kvRate?: number
    totalTokens?: number
    currentContextTokens?: number
    contextWindowTokens?: number
  }>
}>

export function EditorArea(props: Props): React.JSX.Element {
  const mode = props.selectedPath === undefined
    ? "home"
    : isChapterPlanningMarkdownPath(props.selectedPath)
      ? "synopsis"
    : props.selectedPath.startsWith("章节正文/")
      ? "chapter"
      : "markdown"
  const dockChapterToolbar = mode === "chapter"

  const documentPane = mode === "home"
    ? <SynopsisConversationComposer
        projectId={props.projectId}
        workspaceRootRef={props.workspaceRootRef}
        session={props.synopsisSession}
        messages={props.synopsisMessages}
        busy={props.synopsisBusy}
        stream={props.synopsisStream}
        {...(props.synopsisDraftRestore === undefined
          ? {}
          : { draftRestore: props.synopsisDraftRestore })}
        running={props.running}
        {...(props.pendingStagingPromotes === undefined
          ? {}
          : { pendingStagingPromotes: props.pendingStagingPromotes })}
        onSend={props.onSynopsisSend}
        {...(props.onSynopsisStop === undefined
          ? {}
          : { onStop: props.onSynopsisStop })}
        onRefreshChoices={props.onSynopsisRefreshChoices}
        onPromoteStaging={props.onPromoteStaging}
        {...(props.onPromoteDraftToBody === undefined
          ? {}
          : { onPromoteDraftToBody: props.onPromoteDraftToBody })}
        {...(props.onRejectStagingPromote === undefined
          ? {}
          : { onRejectStagingPromote: props.onRejectStagingPromote })}
        onStartTurn={props.onRun}
        onOpenSynopsisFile={props.onOpenSynopsisFile}
        {...(props.onSetFocus === undefined ? {} : { onSetFocus: props.onSetFocus })}
        {...(props.focusChapters === undefined ? {} : { focusChapters: props.focusChapters })}
        {...(props.onOpenSettingsLineage === undefined
          ? {}
          : { onOpenSettingsLineage: props.onOpenSettingsLineage })}
        {...(props.synopsisTokenMetrics === undefined
          ? {}
          : { tokenMetrics: props.synopsisTokenMetrics })}
        descriptionRule={props.descriptionRule}
        proseRule={props.proseRule}
        minimumWordCount={props.minimumWordCount}
        maximumWordCount={props.maximumWordCount}
        wordCountValid={props.wordCountValid}
        descriptionRules={props.descriptionRules}
        proseRules={props.proseRules}
        boundaryPace={props.boundaryPace}
        causalityFocus={props.causalityFocus}
        onDescriptionRuleChange={props.onDescriptionRuleChange}
        onProseRuleChange={props.onProseRuleChange}
        onMinimumWordCountChange={props.onMinimumWordCountChange}
        onMaximumWordCountChange={props.onMaximumWordCountChange}
        onBoundaryPaceChange={props.onBoundaryPaceChange}
        onCausalityFocusChange={props.onCausalityFocusChange}
        modelProfiles={props.modelProfiles}
        activeModelProfileId={props.activeModelProfileId}
        onActiveModelIdChange={props.onActiveModelIdChange}
        onReasoningEffortChange={props.onReasoningEffortChange}
      />
    : mode === "synopsis"
      ? <MarkdownEditor content={props.content} readOnly={false} onContentChange={props.onContentChange} />
    : mode === "chapter" ? <ChapterRevisionEditor
    path={props.selectedPath}
    content={props.content}
    body={props.chapterBody}
    chapter={props.chapter}
    revision={props.revision}
    revisionContent={props.revisionContent}
    {...(props.persistedDraftVersions === undefined ? {} : { persistedDraftVersions: props.persistedDraftVersions })}
    dockToolbar={dockChapterToolbar}
    onEnsureRevision={props.onEnsureRevision}
    onUpdateRevision={props.onUpdateRevision}
    onReviewRevision={props.onReviewRevision}
    onSubmitRevision={props.onSubmitRevision}
    onRetireRevision={props.onRetireRevision}
    {...(props.onAppendPersistedDraft === undefined ? {} : { onAppendPersistedDraft: props.onAppendPersistedDraft })}
    {...(props.onRestorePersistedDraft === undefined ? {} : { onRestorePersistedDraft: props.onRestorePersistedDraft })}
  /> : <MarkdownEditor
    content={props.content}
    readOnly={props.readOnly}
    onContentChange={props.onContentChange}
  />

  return <section className="editor-area">
    <div className="editor-tabs">
      <button type="button" className={props.selectedPath === undefined ? "active" : ""} onClick={props.onHome}><BookOpenText size={15} /> 创作台</button>
      {props.openedDocumentPath === undefined ? null : (
        <button
          type="button"
          className={props.selectedPath === props.openedDocumentPath ? "active" : ""}
          onClick={props.onOpenDocument}
        >
          <span>{props.openedDocumentPath.split("/").at(-1)}</span>
          {props.dirty ? <i /> : null}
        </button>
      )}
      <div className="editor-tab-actions"><UiTooltip label="保存"><button aria-label="保存" disabled={!props.dirty || props.readOnly || props.selectedPath === undefined} onClick={props.onSave}><Save size={15} /></button></UiTooltip></div>
    </div>
    <div className="editor-document">{documentPane}</div>
  </section>
}

function MarkdownEditor(props: {
  content: string
  readOnly: boolean
  onContentChange(value: string): void
}): React.JSX.Element {
  return <Editor
        height="100%"
        language="markdown"
        theme={WORLDSEED_EDITOR_THEME}
        value={props.content}
        beforeMount={(monaco) => { ensureWorldseedEditorTheme(monaco); }}
        onChange={(value: string | undefined) => { props.onContentChange(value ?? ""); }}
        options={{
          readOnly: props.readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          lineHeight: 23,
          fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
          wordWrap: "on",
          padding: { top: 20, bottom: 20 },
          scrollBeyondLastLine: false,
          renderLineHighlight: "gutter",
          overviewRulerBorder: false,
          // Novel Markdown uses fullwidth indent (U+3000) and CJK punctuation; Monaco's
          // unicodeHighlight draws yellow boxes that look like editor bugs.
          unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: false,
            nonBasicASCII: false,
          },
        }}
      />
}

type RevisionIssue = Readonly<{
  category: string
  severity: "建议" | "注意"
  location: string
  summary: string
  detail: string
  suggestion: string
}>

function toRevisionIssue(issue: NonNullable<ChapterRevision["review"]>["issues"][number]): RevisionIssue {
  return {
    category: issue.category,
    severity: issue.severity === "suggestion" ? "建议" : "注意",
    location: issue.location,
    summary: issue.description,
    detail: issue.impact,
    suggestion: issue.suggestion,
  }
}

function ChapterRevisionEditor(props: {
  path: string | undefined
  content: string
  body: string
  chapter: Readonly<{ chapterId: string; sourceId: string; heading?: string }> | undefined
  revision: ChapterRevision | undefined
  revisionContent: string | undefined
  persistedDraftVersions?: readonly RevisionDraftVersion[]
  dockToolbar: boolean
  onEnsureRevision(heading: string, body: string): Promise<ChapterRevision | undefined>
  onUpdateRevision(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision>
  onReviewRevision(revisionTaskId: string): Promise<ChapterRevision>
  onSubmitRevision(input: Readonly<{ revisionTaskId: string; mode: "direct" | "reviewed"; forced: boolean; reviewId?: string }>): Promise<ChapterRevision>
  onRetireRevision(revisionTaskId: string): Promise<ChapterRevision>
  onAppendPersistedDraft?(input: Readonly<{ heading: string; body: string }>): Promise<void>
  onRestorePersistedDraft?(versionId: string): Promise<void>
}): React.JSX.Element {
  const committedHeading = props.chapter?.heading ?? props.revision?.heading ?? "未命名章节"
  const initialDraft = resolveDraftBody(
    props.body,
    props.revisionContent,
    props.persistedDraftVersions,
  )
  const [heading, setHeading] = useState(committedHeading)
  const [draft, setDraft] = useState(initialDraft)
  const [revision, setRevision] = useState<ChapterRevision | undefined>(props.revision)
  const [pane, setPane] = useState<ChapterDocumentPane>(() => (
    isChapterGraphSyncBlocking(props.revision) ? "committed" : "draft"
  ))
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [reviewStage, setReviewStage] = useState<RevisionStage>(() => reviewStageFromRevision(props.revision))
  const [readingPreferences, updateReadingPreferences] = useChapterReadingPreferences()
  const [displayMode, setDisplayMode] = useState<DraftDisplayMode>(() => (
    resolveInitialDraftView({
      ...(props.persistedDraftVersions === undefined ? {} : { persisted: props.persistedDraftVersions }),
      committedHeading,
      committedBody: props.body,
    }).displayMode
  ))
  const [draftVersionChain, setDraftVersionChain] = useState<PrototypeDraftVersion[]>(() => (
    resolveInitialDraftView({
      ...(props.persistedDraftVersions === undefined ? {} : { persisted: props.persistedDraftVersions }),
      committedHeading,
      committedBody: props.body,
    }).versions
  ))
  const [selectedVersionId, setSelectedVersionId] = useState(() => (
    resolveInitialDraftView({
      ...(props.persistedDraftVersions === undefined ? {} : { persisted: props.persistedDraftVersions }),
      committedHeading,
      committedBody: props.body,
    }).selectedVersionId
  ))
  const [diffBaseVersionId, setDiffBaseVersionId] = useState(COMMITTED_DRAFT_VERSION_ID)
  const [diffHeadVersionId, setDiffHeadVersionId] = useState(COMMITTED_DRAFT_VERSION_ID)
  const [editorChromeOpen, setEditorChromeOpen] = useState(false)
  const [lastSavedAtMs, setLastSavedAtMs] = useState<number | undefined>(props.revision?.updatedAtMs)
  const [draftSaveState, setDraftSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const previousVersionCountRef = useRef(0)
  const ensuringRevisionRef = useRef(false)
  const chapterEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const chapterEditorLayoutCleanupRef = useRef<(() => void) | null>(null)
  const chapterEditorWrapColumnsRef = useRef(-1)
  const autosaveSnapshotRef = useRef<{ heading: string; body: string }>({ heading: committedHeading, body: initialDraft })
  const draftVersions = draftVersionChain
  const { official: officialVersions, drafts: draftOnlyVersions } = splitChapterPickerVersions(draftVersions)
  const pickerKind = pane === "committed" ? "official" : "draft"
  const pickerVersions = pickerKind === "official" ? officialVersions : draftOnlyVersions
  const latestWorkingDraftId = preferredWorkingDraftId(draftOnlyVersions)
  const latestVersionId = (pickerKind === "official"
    ? officialVersions.find((version) => version.isCurrentOfficial)?.versionId ?? officialVersions.at(-1)?.versionId
    : latestWorkingDraftId ?? draftOnlyVersions.at(-1)?.versionId)
    ?? draftVersions.at(-1)?.versionId
    ?? COMMITTED_DRAFT_VERSION_ID
  const pickerSelectedId = pickerVersions.some((version) => version.versionId === selectedVersionId)
    ? selectedVersionId
    : latestVersionId

  useEffect(() => {
    return () => {
      chapterEditorLayoutCleanupRef.current?.()
      chapterEditorLayoutCleanupRef.current = null
      chapterEditorRef.current = null
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!props.dockToolbar || chapterEditorRef.current === null || monacoRef.current === null) return
    chapterEditorWrapColumnsRef.current = -1
    syncChapterEditorWrap(chapterEditorRef.current, monacoRef.current, chapterEditorWrapColumnsRef)
  }, [props.dockToolbar, readingPreferences.fontSize])

  useEffect(() => {
    setDisplayMode("edit")
    previousVersionCountRef.current = 0
    setEditorChromeOpen(false)
    const initial = resolveInitialDraftView({
      ...(props.persistedDraftVersions === undefined ? {} : { persisted: props.persistedDraftVersions }),
      committedHeading,
      committedBody: props.body,
    })
    setDraftVersionChain(initial.versions)
    const latestId = initial.versions.at(-1)?.versionId ?? COMMITTED_DRAFT_VERSION_ID
    const baseId = baselineDraftVersionId(initial.versions)
    setSelectedVersionId(initial.selectedVersionId)
    setDisplayMode(initial.displayMode)
    setDiffBaseVersionId(baseId)
    setDiffHeadVersionId(latestId)
    const initialBody = resolveDraftBody(
      props.body,
      props.revisionContent,
      props.persistedDraftVersions,
    )
    autosaveSnapshotRef.current = { heading: committedHeading, body: initialBody }
    setLastSavedAtMs(props.revision?.updatedAtMs)
    setDraftSaveState("idle")
  }, [props.path])

  useEffect(() => {
    if (props.persistedDraftVersions === undefined || props.persistedDraftVersions.length === 0) return
    setDraftVersionChain(fromPersistedDraftVersions(props.persistedDraftVersions))
  }, [props.persistedDraftVersions])

  useEffect(() => {
    setHeading(props.revision?.heading ?? props.chapter?.heading ?? "未命名章节")
    const nextDraft = resolveDraftBody(
      props.body,
      props.revisionContent,
      props.persistedDraftVersions,
    )
    setDraft(nextDraft)
    setRevision(props.revision)
    setReviewStage(reviewStageFromRevision(props.revision))
    if (props.revision?.updatedAtMs !== undefined) {
      setLastSavedAtMs(props.revision.updatedAtMs)
    }
    autosaveSnapshotRef.current = {
      heading: props.revision?.heading ?? props.chapter?.heading ?? "未命名章节",
      body: nextDraft,
    }
  }, [props.body, props.chapter?.heading, props.revision, props.revisionContent, props.persistedDraftVersions])

  useEffect(() => {
    if (props.path === undefined) return
    previousVersionCountRef.current = draftVersions.length
  }, [props.path, draftVersions.length])

  useEffect(() => {
    if (draftVersions.length <= previousVersionCountRef.current) {
      previousVersionCountRef.current = draftVersions.length
      return
    }
    previousVersionCountRef.current = draftVersions.length
    if (draftVersions.length <= 1) return
    const latest = draftVersions.at(-1)
    if (latest === undefined || latest.source !== "agent" || isCoveringDraft(latest)) return
    setSelectedVersionId(latest.versionId)
    setDiffBaseVersionId(baselineDraftVersionId(draftVersions))
    setDiffHeadVersionId(latest.versionId)
    setDisplayMode("diff")
    setPane("draft")
  }, [draftVersions])

  useEffect(() => {
    if (props.chapter === undefined || ensuringRevisionRef.current) return
    if (!shouldAutoEnsureChapterRevision(props.revision)) return
    ensuringRevisionRef.current = true
    void props.onEnsureRevision(committedHeading, props.body)
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        ensuringRevisionRef.current = false
      })
  }, [committedHeading, props.body, props.chapter, props.onEnsureRevision, props.revision])

  const changed = draft !== props.body || heading !== committedHeading
  const activeWordCount = countChapterCharacters(pane === "draft" ? draft : props.body)
  const graphSyncPending = isChapterGraphSyncBlocking(revision)
  useEffect(() => {
    if (graphSyncPending) setPane("committed")
  }, [graphSyncPending])
  const revisionWritable = isChapterRevisionWritable(revision) && !graphSyncPending
  const latestWorkingDraft = draftOnlyVersions.find((version) => version.versionId === latestWorkingDraftId)
  const canReviseLatestDraft = pane === "draft"
    && revisionWritable
    && latestWorkingDraft !== undefined
    && !isCoveringDraft(latestWorkingDraft)
    && selectedVersionId === latestWorkingDraft.versionId
    && displayMode === "edit"
  const revisionStatusHint = pane === "draft" && revisionWritable && !canReviseLatestDraft
    ? displayMode === "view"
      ? "历史草稿仅可查看，请返回最新版本后再审核或提交"
      : "版本对比中，请返回编辑最新草稿后再审核或提交"
    : undefined

  useEffect(() => {
    if (!revisionWritable || displayMode !== "edit" || selectedVersionId !== latestVersionId) return
    if (draft === autosaveSnapshotRef.current.body && heading === autosaveSnapshotRef.current.heading) return

    setDraftSaveState("saving")
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const current = revision ?? await props.onEnsureRevision(committedHeading, props.body)
          if (current === undefined) return
          const next = await props.onUpdateRevision(current.revisionTaskId, heading, draft)
          setRevision(next)
          const savedAtMs = next.updatedAtMs ?? Date.now()
          setLastSavedAtMs(savedAtMs)
          setDraftSaveState("saved")
          autosaveSnapshotRef.current = { heading, body: draft }
          setDraftVersionChain((previous) => mergeDraftVersionContent(previous, latestVersionId, {
            heading,
            body: draft,
            updatedAtMs: savedAtMs,
          }))
        } catch {
          setDraftSaveState("error")
        }
      })()
    }, 800)
    return () => { window.clearTimeout(timer) }
  }, [
    committedHeading,
    displayMode,
    draft,
    heading,
    latestVersionId,
    props.body,
    props.onEnsureRevision,
    props.onUpdateRevision,
    revision,
    revisionWritable,
    selectedVersionId,
  ])

  const persistDraft = async (): Promise<ChapterRevision> => {
    if (revision !== undefined && !isChapterRevisionWritable(revision)) return revision
    const current = revision ?? await props.onEnsureRevision(committedHeading, props.body)
    if (current === undefined) throw new Error("无法创建章节修订草稿")
    const next = !changed ? current : await props.onUpdateRevision(current.revisionTaskId, heading, draft)
    setRevision(next)
    return next
  }

  const createNewDraftVersion = async (): Promise<void> => {
    if (busy || !revisionWritable || displayMode === "diff") return
    const sourceVersion = draftVersions.find((version) => version.versionId === pickerSelectedId)
      ?? draftOnlyVersions.at(-1)
    const editingLatestWorking = displayMode === "edit"
      && latestWorkingDraft !== undefined
      && selectedVersionId === latestWorkingDraft.versionId
    const nextHeading = editingLatestWorking ? heading : (sourceVersion?.heading ?? heading)
    const nextBody = editingLatestWorking ? draft : (sourceVersion?.body ?? draft)
    setBusy(true)
    setActionError(undefined)
    try {
      const current = await persistDraft()
      const savedAtMs = current.updatedAtMs ?? Date.now()
      if (props.onAppendPersistedDraft !== undefined) {
        await props.onAppendPersistedDraft({ heading: nextHeading, body: nextBody })
      } else {
        const nextChain = appendManualDraftVersion(draftVersionChain, {
          heading: nextHeading,
          body: nextBody,
          createdAtMs: savedAtMs,
        })
        const nextLatestId = nextChain.at(-1)?.versionId ?? latestVersionId
        setDraftVersionChain(nextChain)
        setSelectedVersionId(nextLatestId)
      }
      setDisplayMode("edit")
      setPane("draft")
      autosaveSnapshotRef.current = { heading, body: draft }
      setLastSavedAtMs(savedAtMs)
      setDraftSaveState("saved")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setDraftSaveState("error")
    } finally {
      setBusy(false)
    }
  }

  const review = async (): Promise<void> => {
    if (busy || graphSyncPending || !canReviseLatestDraft) return
    setBusy(true)
    setActionError(undefined)
    setReviewStage("reviewing")
    try {
      const current = await persistDraft()
      setRevision(await props.onReviewRevision(current.revisionTaskId))
      setReviewStage("reviewed")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setReviewStage("idle")
    } finally {
      setBusy(false)
    }
  }

  const submit = async (mode: "direct" | "reviewed"): Promise<void> => {
    if (busy || graphSyncPending || !canReviseLatestDraft) return
    setBusy(true)
    setActionError(undefined)
    try {
      const current = await persistDraft()
      const next = await props.onSubmitRevision({
        revisionTaskId: current.revisionTaskId,
        mode,
        forced: mode === "direct",
        ...(mode === "reviewed" && current.review !== undefined ? { reviewId: current.review.reviewId } : {}),
      })
      setRevision(next)
      setReviewStage("submitted")
      setPane("committed")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const retryGraphSync = async (): Promise<void> => {
    if (revision === undefined || busy) return
    setBusy(true)
    setActionError(undefined)
    try {
      const mode = revision.submissionMode ?? "direct"
      const next = await props.onSubmitRevision({
        revisionTaskId: revision.revisionTaskId,
        mode,
        forced: mode === "direct",
        ...(mode === "reviewed" && revision.review !== undefined ? { reviewId: revision.review.reviewId } : {}),
      })
      setRevision(next)
      setReviewStage("submitted")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const embeddedReadingToolbar = props.dockToolbar
    ? <ChapterReadingToolbar
        variant="composer"
        preferences={readingPreferences}
        onReadingChange={updateReadingPreferences}
      />
    : null

  const editorChromeToggle = props.dockToolbar
    ? <ChapterEditorChromeToggle open={editorChromeOpen} onToggle={() => { setEditorChromeOpen((value) => !value); }} />
    : null

  const toolbar = props.dockToolbar ? null : <ChapterWorkspaceToolbar
    preferences={readingPreferences}
    paneLabel={graphSyncPending || pane === "committed" ? "正文" : "草稿"}
    wordCount={graphSyncPending || pane === "committed" ? countChapterCharacters(props.body) : activeWordCount}
    onReadingChange={updateReadingPreferences}
    showActions={canReviseLatestDraft}
    statusHint={revisionStatusHint}
    stage={reviewStage}
    changed={changed}
    busy={busy}
    error={actionError}
    onReview={() => { void review(); }}
    onDirectSubmit={() => { void submit("direct"); }}
    onReviewedSubmit={() => { void submit("reviewed"); }}
  />
  const revisionErrorBanner = props.dockToolbar && actionError !== undefined
    ? <div className="chapter-revision-error" role="alert">{actionError}</div>
    : null

  const restorePrototypeVersion = async (version: PrototypeDraftVersion): Promise<void> => {
    if (busy || !revisionWritable) return
    setBusy(true)
    setActionError(undefined)
    try {
      if (props.onRestorePersistedDraft !== undefined) {
        await props.onRestorePersistedDraft(version.versionId)
        setHeading(version.heading)
        setDraft(version.body)
        setPane("draft")
        setReviewStage("idle")
        setDisplayMode("edit")
        return
      }
      const current = revision ?? await props.onEnsureRevision(committedHeading, props.body)
      if (current === undefined) throw new Error("无法创建章节修订草稿")
      const next = await props.onUpdateRevision(current.revisionTaskId, version.heading, version.body)
      setRevision(next)
      setHeading(version.heading)
      setDraft(version.body)
      setPane("draft")
      setReviewStage("idle")
      setSelectedVersionId(version.versionId)
      setDisplayMode("edit")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const selectDraftVersion = (versionId: string): void => {
    const version = draftVersions.find((item) => item.versionId === versionId)
    if (version === undefined) return
    setSelectedVersionId(versionId)
    if (pane === "committed") return
    const nextMode = draftDisplayModeForSelection(draftOnlyVersions, versionId)
    setDisplayMode(nextMode)
    if (nextMode === "edit") setDraft(version.body)
  }

  const enterDiffMode = (): void => {
    const head = draftVersions.find((version) => version.versionId === selectedVersionId) ?? draftVersions.at(-1)
    const baselineId = baselineDraftVersionId(draftVersions)
    const headId = head?.versionId === baselineId
      ? latestVersionId
      : (head?.versionId ?? latestVersionId)
    setDiffBaseVersionId(baselineId)
    setDiffHeadVersionId(headId)
    setDisplayMode("diff")
    setPane("draft")
  }

  const viewingVersion = pickerVersions.find((version) => version.versionId === pickerSelectedId)
    ?? pickerVersions.find((version) => version.versionId === selectedVersionId)
    ?? draftVersions.find((version) => version.versionId === selectedVersionId)
    ?? draftVersions.at(-1)
  const officialView = officialVersions.find((version) => version.versionId === pickerSelectedId)
    ?? officialVersions.find((version) => version.isCurrentOfficial === true)
    ?? officialVersions.at(-1)
  const committedBodyText = officialView?.body ?? props.body

  const versionsPanel = <ChapterDraftVersionsPrototype
    versions={pickerVersions}
    latestVersionId={latestVersionId}
    selectedVersionId={pickerSelectedId}
    displayMode={displayMode}
    busy={busy}
    mutable={revisionWritable}
    kind={pickerKind}
    showRevisionActions={canReviseLatestDraft}
    revisionStage={reviewStage}
    draftChanged={changed}
    onReview={() => { void review(); }}
    onDirectSubmit={() => { void submit("direct"); }}
    onReviewedSubmit={() => { void submit("reviewed"); }}
    onSelectVersion={selectDraftVersion}
    onEnterDiff={enterDiffMode}
    onReturnEdit={() => {
      setSelectedVersionId(latestVersionId)
      setDisplayMode(draftDisplayModeForSelection(draftOnlyVersions, latestVersionId))
      setPane("draft")
    }}
    onRestore={restorePrototypeVersion}
    onCreateDraft={() => { void createNewDraftVersion() }}
  />

  const statusBarTitle = pane === "committed"
    ? committedHeading
    : displayMode === "view"
      ? (viewingVersion?.heading ?? heading)
      : displayMode === "diff"
        ? (draftVersions.find((version) => version.versionId === diffHeadVersionId)?.heading ?? heading)
        : heading
  const statusBarWordCount = pane === "committed"
    ? countChapterCharacters(props.body)
    : displayMode === "view"
      ? countChapterCharacters(viewingVersion?.body ?? draft)
      : displayMode === "diff"
        ? countChapterCharacters(draftVersions.find((version) => version.versionId === diffHeadVersionId)?.body ?? draft)
        : countChapterCharacters(draft)
  const editorStatusBar = props.dockToolbar
    ? <ChapterEditorStatusBar
        title={statusBarTitle}
        wordCount={statusBarWordCount}
        preferences={readingPreferences}
        showSaveTime={pane === "draft" && displayMode !== "diff"}
        saveState={draftSaveState}
        lastSavedAtMs={lastSavedAtMs}
      />
    : null

  const graphSyncAction = graphSyncPending
    ? <button
        type="button"
        className="chapter-edit-command"
        data-testid="chapter-graph-sync-action"
        disabled={busy || revision?.graphSyncStatus === "running"}
        onClick={() => { void retryGraphSync(); }}
      >
        <RotateCcw className={revision?.graphSyncStatus === "running" ? "revision-spin" : ""} size={14} />
        {revision?.graphSyncStatus === "failed" ? "重试图同步" : revision?.graphSyncStatus === "pending" ? "继续图同步" : "图同步中"}
      </button>
    : null

  return <article className="chapter-reader chapter-workspace">
    <header className="chapter-reader-header chapter-reader-header-compact">
      <div className="chapter-reader-topline">
        <span className={`mode-pill chapter-status-${pane}`}>
          {pane === "draft" ? <Sparkles size={12} /> : <BookOpenText size={12} />}
          {pane === "draft" ? "章节草稿" : "已提交章节"}
        </span>
        {versionsPanel !== null
          ? <div className="chapter-draft-versions-inline" data-testid="chapter-draft-versions-host">{versionsPanel}</div>
          : null}
        <div className="chapter-document-switch" data-testid="chapter-document-switch" role="tablist" aria-label="章节文档视图">
          <button
            type="button"
            role="tab"
            className={pane === "committed" ? "active" : ""}
            aria-selected={pane === "committed"}
            data-testid="chapter-document-committed"
            onClick={() => {
              setPane("committed")
              if (!officialVersions.some((version) => version.versionId === selectedVersionId)) {
                const current = officialVersions.find((version) => version.isCurrentOfficial === true)
                  ?? officialVersions.at(-1)
                if (current !== undefined) setSelectedVersionId(current.versionId)
              }
            }}
          >
            正文
          </button>
          <button
            type="button"
            role="tab"
            className={pane === "draft" ? "active" : ""}
            aria-selected={pane === "draft"}
            data-testid="chapter-document-draft"
            onClick={() => {
              setPane("draft")
              const preferredId = preferredWorkingDraftId(draftOnlyVersions)
              if (preferredId === undefined) return
              const preferred = draftOnlyVersions.find((version) => version.versionId === preferredId)
              if (preferred === undefined) return
              setSelectedVersionId(preferred.versionId)
              const nextMode = draftDisplayModeForSelection(draftOnlyVersions, preferred.versionId)
              setDisplayMode(nextMode)
              if (nextMode === "edit") setDraft(preferred.body)
            }}
          >
            草稿
          </button>
        </div>
        {graphSyncAction}
      </div>
    </header>
    {revisionErrorBanner}
    {pane === "committed"
      ? <div className="chapter-document-pane-committed-shell" data-testid="chapter-document-pane-committed" role="tabpanel">
          <div className={`chapter-committed-body-shell${props.dockToolbar ? " chapter-editor-surface" : ""}`}>
            {props.dockToolbar
              ? <>
                  {editorChromeToggle}
                  <ChapterEditorChromePanel open={editorChromeOpen}>{embeddedReadingToolbar}</ChapterEditorChromePanel>
                </>
              : embeddedReadingToolbar}
            <div
              className="chapter-body chapter-workspace-pane"
              style={{
                ...chapterBodyStyle(readingPreferences),
                ...(props.dockToolbar ? { paddingRight: CHAPTER_EDITOR_TOOLBAR_LANE + CHAPTER_EDITOR_SCROLLBAR_WIDTH + 16 } : {}),
              }}
            >
              {committedBodyText.length === 0
                ? <p className="empty-paragraph">当前章节没有正文内容。</p>
                : committedBodyText.split(/\n{2,}/u).map((paragraph, index) => (
                  <p key={`${String(index)}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
                ))}
            </div>
          </div>
        </div>
      : <div className="chapter-draft-pane" data-testid="chapter-document-pane-draft" role="tabpanel">
          {displayMode === "diff"
            ? <ChapterDraftDiffView
                versions={draftVersions}
                baseVersionId={diffBaseVersionId}
                headVersionId={diffHeadVersionId}
                onBaseVersionChange={setDiffBaseVersionId}
                onHeadVersionChange={setDiffHeadVersionId}
              />
            : <>
                {displayMode === "view"
                  ? <div className="chapter-draft-view-banner" data-testid="chapter-draft-view-banner">
                      {viewingVersion !== undefined && isCoveringDraft(viewingVersion)
                        ? "此草稿已覆盖为当前正文（只读）。创建新草稿可继续修改。"
                        : `正在查看 ${viewingVersion?.label ?? "历史版本"}（只读）。选择最新未覆盖草稿可继续编辑。`}
                    </div>
                  : null}
                <div className={`chapter-draft-editor-shell${props.dockToolbar ? " chapter-editor-surface" : ""}`}>
                  {props.dockToolbar
                    ? <>
                        {editorChromeToggle}
                        <ChapterEditorChromePanel open={editorChromeOpen}>
                          <label className="chapter-editor-chrome-title">
                            <span className="sr-only">章节标题</span>
                            <input
                              placeholder="章节标题"
                              value={displayMode === "view" ? (viewingVersion?.heading ?? heading) : heading}
                              maxLength={180}
                              readOnly={displayMode === "view"}
                              onChange={(event) => {
                                setHeading(event.target.value)
                                if (reviewStage === "reviewed") setReviewStage("idle")
                              }}
                            />
                          </label>
                          {embeddedReadingToolbar}
                        </ChapterEditorChromePanel>
                      </>
                    : <>
                        <label className="revision-title-field chapter-draft-title-field">
                          <span>章节标题</span>
                          <input
                            value={displayMode === "view" ? (viewingVersion?.heading ?? heading) : heading}
                            maxLength={180}
                            readOnly={displayMode === "view"}
                            onChange={(event) => {
                              setHeading(event.target.value)
                              if (reviewStage === "reviewed") setReviewStage("idle")
                            }}
                          />
                        </label>
                        {embeddedReadingToolbar}
                      </>}
                  <Editor
                    height="100%"
                    language="markdown"
                    theme={WORLDSEED_EDITOR_THEME}
                    value={displayMode === "view" ? (viewingVersion?.body ?? draft) : draft}
                    onChange={(value: string | undefined) => {
                      if (displayMode === "view") return
                      setDraft(value ?? "")
                      if (reviewStage === "reviewed") setReviewStage("idle")
                    }}
                    beforeMount={(monaco) => { ensureWorldseedEditorTheme(monaco); }}
                    onMount={(editorInstance, monaco) => {
                      chapterEditorLayoutCleanupRef.current?.()
                      chapterEditorRef.current = editorInstance
                      monacoRef.current = monaco
                      if (!props.dockToolbar) return
                      let raf = 0
                      const apply = (): void => {
                        if (raf !== 0) return
                        raf = window.requestAnimationFrame(() => {
                          raf = 0
                          syncChapterEditorWrap(editorInstance, monaco, chapterEditorWrapColumnsRef)
                        })
                      }
                      chapterEditorWrapColumnsRef.current = -1
                      apply()
                      const disposeLayout = editorInstance.onDidLayoutChange(apply).dispose
                      chapterEditorLayoutCleanupRef.current = () => {
                        if (raf !== 0) window.cancelAnimationFrame(raf)
                        disposeLayout()
                      }
                    }}
                    options={{
                      readOnly: displayMode === "view",
                      minimap: { enabled: false },
                      fontSize: readingPreferences.fontSize,
                      lineHeight: Math.round(readingPreferences.fontSize * 1.65),
                      fontFamily: chapterBodyStyle(readingPreferences).fontFamily ?? "JetBrains Mono, Consolas, monospace",
                      wordWrap: props.dockToolbar ? "bounded" : "on",
                      padding: { top: 12, bottom: 12 },
                      scrollBeyondLastLine: false,
                      renderLineHighlight: "gutter",
                      overviewRulerBorder: false,
                      unicodeHighlight: {
                        ambiguousCharacters: false,
                        invisibleCharacters: false,
                        nonBasicASCII: false,
                      },
                      ...(props.dockToolbar
                        ? {
                            scrollbar: {
                              verticalScrollbarSize: CHAPTER_EDITOR_SCROLLBAR_WIDTH,
                              horizontalScrollbarSize: 6,
                              verticalSliderSize: 4,
                              horizontalSliderSize: 4,
                              useShadows: false,
                            },
                          }
                        : {}),
                    }}
                  />
                </div>
              </>}
        </div>}
    {revisionErrorBanner}
    {editorStatusBar}
    {toolbar}
    {pane === "draft" && reviewStage === "reviewed" && canReviseLatestDraft
      ? <ChapterReviewResults issues={(revision?.review?.issues ?? []).map(toRevisionIssue)} />
      : null}
  </article>
}

function ChapterReviewResults(props: { issues: readonly RevisionIssue[] }): React.JSX.Element {
  return <aside className="chapter-review-results" data-testid="chapter-review-results">
    <div className="revision-advisory-callout">
      <AlertTriangle size={14} />
      <div>
        <strong>审核完成 · 发现 {String(props.issues.length)} 条建议</strong>
        <p>建议仅供参考，不会阻止提交。你可以继续改草稿，或直接提交。</p>
      </div>
    </div>
    {props.issues.length === 0
      ? null
      : props.issues.map((issue) => (
        <article className="revision-issue" key={issue.location}>
          <div className="revision-issue-title">
            <span className="revision-issue-severity"><AlertTriangle size={12} /> {issue.severity}</span>
            <strong>{issue.category}</strong>
            <small>{issue.location}</small>
          </div>
          <p>{issue.summary}</p>
        </article>
      ))}
  </aside>
}

function resolveEditorDraftVersions(input: Readonly<{
  persisted?: readonly RevisionDraftVersion[]
  committedHeading: string
  committedBody: string
}>): PrototypeDraftVersion[] {
  if (input.persisted !== undefined && input.persisted.length > 0) {
    return fromPersistedDraftVersions(input.persisted)
  }
  return buildPrototypeDraftVersions({
    committedHeading: input.committedHeading,
    committedBody: input.committedBody,
  })
}

function resolveInitialDraftView(input: Readonly<{
  persisted?: readonly RevisionDraftVersion[]
  committedHeading: string
  committedBody: string
}>): Readonly<{
  versions: PrototypeDraftVersion[]
  selectedVersionId: string
  displayMode: DraftDisplayMode
}> {
  const versions = resolveEditorDraftVersions(input)
  const drafts = versions.filter((version) => version.source !== "baseline")
  const selectedVersionId = preferredWorkingDraftId(drafts)
    ?? versions.at(-1)?.versionId
    ?? COMMITTED_DRAFT_VERSION_ID
  return {
    versions,
    selectedVersionId,
    displayMode: draftDisplayModeForSelection(drafts, selectedVersionId),
  }
}

function baselineDraftVersionId(versions: readonly PrototypeDraftVersion[]): string {
  return versions.find((version) => version.source === "baseline")?.versionId
    ?? versions[0]?.versionId
    ?? COMMITTED_DRAFT_VERSION_ID
}

function resolveDraftBody(
  body: string,
  revisionContent: string | undefined,
  persisted?: readonly RevisionDraftVersion[],
): string {
  const latestPersisted = persisted?.find((version) => version.isLatest) ?? persisted?.at(-1)
  if (latestPersisted !== undefined && latestPersisted.body.length > 0) return latestPersisted.body
  if (revisionContent !== undefined && revisionContent.length > 0) return revisionContent
  return body
}

function reviewStageFromRevision(revision: ChapterRevision | undefined): RevisionStage {
  if (revision === undefined) return "idle"
  if (revision.status === "ready_to_submit" && revision.review !== undefined) return "reviewed"
  if (revision.decision === "submit") return "submitted"
  return "idle"
}

function countChapterCharacters(text: string): number {
  return text.replace(/\s+/gu, "").length
}
