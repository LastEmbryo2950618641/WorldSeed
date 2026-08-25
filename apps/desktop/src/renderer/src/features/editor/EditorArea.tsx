import { Editor } from "@monaco-editor/react"
import { useEffect, useState } from "react"
import type { ChapterRevision } from "@worldseed/contracts"
import { AlertTriangle, BookOpenText, Check, CheckCircle2, Eye, FileDiff, FileText, GitBranch, GitCompare, Play, RotateCcw, Save, Send, Settings2, ShieldCheck, Sparkles, X } from "lucide-react"

type Props = Readonly<{
  selectedPath: string | undefined
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
  onContentChange(value: string): void
  onHome(): void
  onPromptChange(value: string): void
  onDescriptionRuleChange(value: string): void
  onProseRuleChange(value: string): void
  onMinimumWordCountChange(value: string): void
  onMaximumWordCountChange(value: string): void
  onSave(): void
  onRun(): void
  chapter: Readonly<{ chapterId: string; sourceId: string }> | undefined
  chapterBody: string
  revision: ChapterRevision | undefined
  revisionContent: string | undefined
  onStartRevision(heading: string, body: string): Promise<ChapterRevision>
  onUpdateRevision(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision>
  onReviewRevision(revisionTaskId: string): Promise<ChapterRevision>
  onSubmitRevision(input: Readonly<{ revisionTaskId: string; mode: "direct" | "reviewed"; forced: boolean; reviewId?: string }>): Promise<ChapterRevision>
  onRetireRevision(revisionTaskId: string): Promise<ChapterRevision>
}>

export function EditorArea(props: Props): React.JSX.Element {
  const mode = props.selectedPath === undefined
    ? "home"
    : props.selectedPath.startsWith("章节正文/")
      ? "chapter"
      : "markdown"

  return <section className="editor-area">
    <div className="editor-tabs">
      <button className={props.selectedPath === undefined ? "active" : ""} onClick={props.onHome}><BookOpenText size={15} /> 创作台</button>
      {props.selectedPath === undefined ? null : <button className="active"><span>{props.selectedPath.split("/").at(-1)}</span>{props.dirty ? <i /> : null}</button>}
      <div className="editor-tab-actions"><button title="保存" disabled={!props.dirty || props.readOnly} onClick={props.onSave}><Save size={15} /></button></div>
    </div>
    <div className="editor-document">
      {mode === "home" ? <WorkbenchHome /> : mode === "chapter" ? <ChapterRevisionEditor
        path={props.selectedPath}
        content={props.content}
        body={props.chapterBody}
        chapter={props.chapter}
        revision={props.revision}
        revisionContent={props.revisionContent}
        onStartRevision={props.onStartRevision}
        onUpdateRevision={props.onUpdateRevision}
        onReviewRevision={props.onReviewRevision}
        onSubmitRevision={props.onSubmitRevision}
        onRetireRevision={props.onRetireRevision}
      /> : <MarkdownEditor
        content={props.content}
        readOnly={props.readOnly}
        onContentChange={props.onContentChange}
      />}
    </div>
    <TurnComposer {...props} />
  </section>
}

function WorkbenchHome(): React.JSX.Element {
  return <div className="workbench-home">
    <section className="hero-panel">
      <span className="mode-pill"><Sparkles size={14} /> 创作台首页</span>
      <h1>从本轮输入开始，让世界按已读取依据继续生长</h1>
      <p>这里不是聊天框。每次推演都会先装配规则、选择性读取设定与参考文件，再召回局部世界图，最后才生成章节正文并回写持久图。</p>
    </section>
    <section className="home-cards">
      <article>
        <FileText size={18} />
        <strong>Markdown 材料</strong>
        <p>左侧维护用户规则、设定集、参考文件和表现输出；基础规则只读。</p>
      </article>
      <article>
        <GitBranch size={18} />
        <strong>动态图召回</strong>
        <p>正式正文只依赖本轮实际读取的旧图、资料和用户输入，不一次塞入整张图。</p>
      </article>
      <article>
        <Eye size={18} />
        <strong>表现控制</strong>
        <p>描写规则、笔风规则和字数约束作为本轮强调提示，不自动成为世界事实。</p>
      </article>
    </section>
  </div>
}

function MarkdownEditor(props: {
  content: string
  readOnly: boolean
  onContentChange(value: string): void
}): React.JSX.Element {
  return <Editor
        height="100%"
        language="markdown"
        value={props.content}
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
        }}
      />
}

type RevisionStage = "idle" | "editing" | "reviewing" | "reviewed" | "submitted"

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
  onStartRevision(heading: string, body: string): Promise<ChapterRevision>
  onUpdateRevision(revisionTaskId: string, heading: string, body: string): Promise<ChapterRevision>
  onReviewRevision(revisionTaskId: string): Promise<ChapterRevision>
  onSubmitRevision(input: Readonly<{ revisionTaskId: string; mode: "direct" | "reviewed"; forced: boolean; reviewId?: string }>): Promise<ChapterRevision>
  onRetireRevision(revisionTaskId: string): Promise<ChapterRevision>
}): React.JSX.Element {
  const [stage, setStage] = useState<RevisionStage>(() => stageFromRevision(props.revision))
  const [heading, setHeading] = useState(props.revision?.heading ?? props.chapter?.heading ?? "未命名章节")
  const [draft, setDraft] = useState(props.revisionContent ?? props.body)
  const [committedHeading, setCommittedHeading] = useState(props.chapter?.heading ?? "未命名章节")
  const [committedContent, setCommittedContent] = useState(props.body)
  const [revision, setRevision] = useState<ChapterRevision | undefined>(props.revision)
  const [busy, setBusy] = useState(false)
  const [submittedMode, setSubmittedMode] = useState<"direct" | "reviewed">(() => props.revision?.submissionMode ?? "direct")
  const [actionError, setActionError] = useState<string>()
  useEffect(() => {
    setHeading(props.revision?.heading ?? props.chapter?.heading ?? "未命名章节")
    setDraft(props.revisionContent ?? props.body)
    setCommittedHeading(props.chapter?.heading ?? "未命名章节")
    setCommittedContent(props.body)
    setRevision(props.revision)
    setSubmittedMode(props.revision?.submissionMode ?? "direct")
    setStage(stageFromRevision(props.revision))
  }, [props.path, props.body, props.chapter?.heading, props.revision, props.revisionContent])

  const changed = heading !== committedHeading || draft !== committedContent
  const handleDraftChange = (value: string): void => {
    setDraft(value)
    if (stage === "reviewed") setStage("editing")
  }
  const startEditing = async (): Promise<void> => {
    if (props.chapter === undefined || busy) return
    setBusy(true)
    setActionError(undefined)
    try {
      const next = revision ?? await props.onStartRevision(committedHeading, committedContent)
      setRevision(next)
      setStage("editing")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const persistDraft = async (): Promise<ChapterRevision> => {
    const current = revision ?? await props.onStartRevision(committedHeading, committedContent)
    const next = !changed ? current : await props.onUpdateRevision(current.revisionTaskId, heading, draft)
    setRevision(next)
    return next
  }
  const review = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionError(undefined)
    setStage("reviewing")
    try {
      const current = await persistDraft()
      setRevision(await props.onReviewRevision(current.revisionTaskId))
      setStage("reviewed")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setStage("editing")
    } finally {
      setBusy(false)
    }
  }
  const submit = async (mode: "direct" | "reviewed"): Promise<void> => {
    if (busy) return
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
      setCommittedHeading(heading)
      setCommittedContent(draft)
      setSubmittedMode(mode)
      setStage("submitted")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const stopEditing = async (): Promise<void> => {
    if (revision !== undefined) await props.onRetireRevision(revision.revisionTaskId)
    setDraft(committedContent)
    setHeading(committedHeading)
    setRevision(undefined)
    setStage("idle")
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
      setStage("submitted")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (stage === "editing" || stage === "reviewing" || stage === "reviewed") {
    return <article className="chapter-reader chapter-revision-editor">
      <RevisionHeader heading={heading} path={props.path} stage={stage} changed={changed} compact />
      <div className="revision-workspace">
        <div className="revision-source-pane">
          <div className="revision-pane-heading"><span><FileDiff size={14} /> 修订正文</span><small>{changed ? "未提交修改" : "基于当前正式版本"}</small></div>
          <label className="revision-title-field">
            <span>章节标题</span>
            <input value={heading} maxLength={180} onChange={(event) => { setHeading(event.target.value); if (stage === "reviewed") setStage("editing"); }} />
          </label>
          <Editor
            height="100%"
            language="markdown"
            value={draft}
            onChange={(value: string | undefined) => { handleDraftChange(value ?? ""); }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 22,
              fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
              wordWrap: "on",
              padding: { top: 14, bottom: 14 },
              scrollBeyondLastLine: false,
              renderLineHighlight: "gutter",
              overviewRulerBorder: false,
            }}
          />
        </div>
        <RevisionReviewPane
          stage={stage}
          changed={changed}
          issues={(revision?.review?.issues ?? []).map(toRevisionIssue)}
          reviewRound={revision?.review === undefined ? 0 : 1}
          onReview={() => { void review(); }}
          onDirectSubmit={() => { void submit("direct"); }}
          onReviewedSubmit={() => { void submit("reviewed"); }}
          onCancel={() => { void stopEditing(); }}
          busy={busy}
          error={actionError}
        />
      </div>
    </article>
  }

  return <article className="chapter-reader">
    <header>
      <RevisionHeader heading={heading} path={props.path} stage={stage} changed={false} />
      <div className="chapter-reader-actions">
        <span><ShieldCheck size={13} /> 正式版本 · {submittedMode === "direct" ? "用户直接提交" : "审核后提交"} · 历史已保留</span>
        {revision?.decision === "submit" && revision.graphSyncStatus !== "completed"
          ? <button className="chapter-edit-command" title={revision.graphSyncStatus === "pending" ? "图同步尚未运行，点击继续" : undefined} disabled={busy || revision.graphSyncStatus === "running"} onClick={() => { void retryGraphSync(); }}><RotateCcw className={revision.graphSyncStatus === "running" ? "revision-spin" : ""} size={14} />{revision.graphSyncStatus === "failed" ? "重试图同步" : revision.graphSyncStatus === "pending" ? "继续图同步" : "图同步中"}</button>
          : <button className="chapter-edit-command" disabled={busy || props.chapter === undefined} onClick={() => { void startEditing(); }}><GitCompare size={14} /> 编辑章节</button>}
      </div>
      {actionError === undefined ? null : <div className="revision-error" role="alert"><AlertTriangle size={14} /><span>{actionError}</span></div>}
    </header>
    <div className="chapter-body">
      {props.body.length === 0 ? <p className="empty-paragraph">当前章节没有正文内容。</p> : props.body.split(/\n{2,}/u).map((paragraph, index) => (
        <p key={`${String(index)}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
      ))}
    </div>
  </article>
}

function RevisionHeader({ heading, path, stage, changed, compact = false }: { heading: string; path: string | undefined; stage: RevisionStage; changed: boolean; compact?: boolean }): React.JSX.Element {
  const status = stage === "submitted" ? "已提交修订" : stage === "reviewed" ? "审核建议已生成" : stage === "reviewing" ? "AI审核中" : stage === "editing" ? "正在修订" : "已提交章节"
  const icon = stage === "reviewed" ? <CheckCircle2 size={14} /> : stage === "reviewing" ? <RotateCcw className="revision-spin" size={14} /> : stage === "editing" ? <GitCompare size={14} /> : <BookOpenText size={14} />
  return <div className="revision-heading">
    <div className="revision-heading-main">
      <span className={`mode-pill revision-status-${stage}`}>{icon}{status}</span>
      {compact ? null : <>
        <h1>{heading}</h1>
        <p>{path} · {changed ? "存在未提交修订" : "当前正式版本"}</p>
      </>}
    </div>
    {stage === "reviewed" ? <span className="revision-advisory-label"><AlertTriangle size={13} /> 建议，不是门禁</span> : null}
  </div>
}

function RevisionReviewPane(props: {
  stage: RevisionStage
  changed: boolean
  issues: readonly RevisionIssue[]
  error: string | undefined
  reviewRound: number
  onReview(): void
  onDirectSubmit(): void
  onReviewedSubmit(): void
  onCancel(): void
  busy: boolean
}): React.JSX.Element {
  const reviewing = props.stage === "reviewing"
  return <aside className="revision-review-pane">
    <div className="revision-pane-heading"><span><ShieldCheck size={14} /> 修订检查</span><small>{props.reviewRound > 0 ? `第 ${String(props.reviewRound)} 次` : "尚未执行"}</small></div>
    <div className="revision-review-overview">
      <div className="revision-authority-note"><CheckCircle2 size={14} /><span><strong>用户拥有最终决定权</strong><small>AI只提示可能的问题，不会拒绝正文。</small></span></div>
      <div className="revision-review-summary">
        <span><small>当前版本</small><strong>{props.changed ? "有修改" : "未修改"}</strong></span>
        <span><small>原文历史</small><strong>已保留</strong></span>
        <span><small>图同步</small><strong>{props.stage === "reviewed" ? "待提交" : "未开始"}</strong></span>
      </div>
    </div>
    <div className="revision-issue-list">
      {props.stage === "reviewed" ? <div className="revision-advisory-callout"><AlertTriangle size={14} /><div><strong>发现 {String(props.issues.length)} 条建议</strong><p>请结合正文判断是否采纳。你可以继续修改、重新审核，或直接提交当前版本。</p></div></div> : null}
      {props.error === undefined ? null : <div className="revision-error" role="alert"><AlertTriangle size={14} /><span>{props.error}</span></div>}
      {props.stage === "reviewed" && props.issues.length > 0 ? props.issues.map((issue) => <article className="revision-issue" key={issue.location}>
        <div className="revision-issue-title"><span className="revision-issue-severity"><AlertTriangle size={12} /> {issue.severity}</span><strong>{issue.category}</strong><small>{issue.location}</small></div>
        <p>{issue.summary}</p>
        <details><summary>查看依据与建议</summary><p>{issue.detail}</p><p className="revision-suggestion">建议：{issue.suggestion}</p></details>
      </article>) : null}
      {props.stage === "reviewing" ? <div className="revision-reviewing"><RotateCcw className="revision-spin" size={16} /><span>正在读取正文、当前图状态和相关时空锚点…</span></div> : null}
      {props.stage === "editing" ? <p className="revision-empty"><FileDiff size={18} />{props.changed ? "修改正文后，可以选择直接提交或先执行审核。" : "当前没有检测到正文修改。"}</p> : null}
    </div>
    <div className="revision-pane-actions">
      <div className="revision-primary-actions">
        <button className="revision-secondary-command" disabled={!props.changed || reviewing || props.busy} onClick={props.onReview}><ShieldCheck size={14} />{reviewing ? "审核中" : "审核后提交"}</button>
        <button className="revision-primary-command" disabled={!props.changed || reviewing || props.busy} onClick={props.onDirectSubmit}><Send size={14} />直接提交</button>
      </div>
      {props.stage === "reviewed" ? <button className="revision-reviewed-submit" disabled={props.busy} onClick={props.onReviewedSubmit}><Check size={14} />按审核结果提交</button> : null}
      <button className="revision-cancel-command" onClick={props.onCancel}><X size={13} />放弃修订</button>
    </div>
  </aside>
}

function stageFromRevision(revision: ChapterRevision | undefined): RevisionStage {
  if (revision === undefined) return "idle"
  if (revision.status === "ready_to_submit" && revision.review !== undefined) return "reviewed"
  if (revision.status === "editing" || revision.status === "reviewing") return "editing"
  if (revision.decision === "submit") return "submitted"
  if (revision.status === "content_committed"
    || revision.status === "chapter_published"
    || revision.status === "chapter_registered"
    || revision.status === "graph_sync_pending"
    || revision.status === "graph_sync_running") return "submitted"
  return "editing"
}

function TurnComposer(props: Props): React.JSX.Element {
  return <div className="turn-composer">
    <div className="composer-heading"><span><Settings2 size={15} /> 本轮推演输入</span><span>用户输入 + 表现规则 + 字数会作为本轮强调提示</span></div>
    <textarea value={props.prompt} onChange={(event) => { props.onPromptChange(event.target.value); }} placeholder="输入此事如何发展、某人的行动或想法。与世界背景矛盾的内容会作为意图处理，而非直接成为事实。" />
    <div className="composer-controls">
      <label>描写规则<select value={props.descriptionRule} onChange={(event) => { props.onDescriptionRuleChange(event.target.value); }}><option value="">自动选择</option>{props.descriptionRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}</select></label>
      <label>笔风规则<select value={props.proseRule} onChange={(event) => { props.onProseRuleChange(event.target.value); }}><option value="">保持当前笔风</option>{props.proseRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}</select></label>
      <label className={`word-count-control${props.wordCountValid ? "" : " invalid"}`} title="正文主体字数范围，标题不计入">
        <span>字数</span>
        <input aria-label="正文最少字数" type="number" min="1" step="100" value={props.minimumWordCount} onChange={(event) => { props.onMinimumWordCountChange(event.target.value); }} />
        <span>—</span>
        <input aria-label="正文最多字数" type="number" min="1" step="100" value={props.maximumWordCount} onChange={(event) => { props.onMaximumWordCountChange(event.target.value); }} />
        <span>字</span>
      </label>
      <button className="run-command" disabled={props.running || props.prompt.trim().length === 0 || !props.wordCountValid} onClick={props.onRun}><Play size={16} fill="currentColor" />{props.running ? "推演中" : "开始推演"}</button>
    </div>
  </div>
}
