import { Editor } from "@monaco-editor/react"
import { BookOpenText, Eye, FileText, GitBranch, Play, Save, Settings2, Sparkles } from "lucide-react"

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
      {mode === "home" ? <WorkbenchHome /> : mode === "chapter" ? <ChapterReader path={props.selectedPath} content={props.content} /> : <MarkdownEditor
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

function ChapterReader({ path, content }: { path: string | undefined; content: string }): React.JSX.Element {
  const lines = content.split(/\r?\n/u)
  const heading = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/u, "") || path?.split("/").at(-1)?.replace(/\.md$/u, "") || "未命名章节"
  const body = lines.filter((line) => !line.startsWith("# ")).join("\n").trim()
  return <article className="chapter-reader">
    <header>
      <span className="mode-pill"><BookOpenText size={14} /> 已提交章节</span>
      <h1>{heading}</h1>
      <p>{path}</p>
    </header>
    <div className="chapter-body">
      {body.length === 0 ? <p className="empty-paragraph">当前章节没有正文内容。</p> : body.split(/\n{2,}/u).map((paragraph, index) => (
        <p key={`${String(index)}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
      ))}
    </div>
  </article>
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
