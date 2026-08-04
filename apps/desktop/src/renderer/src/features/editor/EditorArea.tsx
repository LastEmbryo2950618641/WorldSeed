import { Editor } from "@monaco-editor/react"
import { BookOpenText, Play, Save, Settings2 } from "lucide-react"

type Props = Readonly<{
  selectedPath: string | undefined
  content: string
  dirty: boolean
  readOnly: boolean
  running: boolean
  prompt: string
  descriptionRule: string
  proseRule: string
  descriptionRules: readonly string[]
  proseRules: readonly string[]
  onContentChange(value: string): void
  onPromptChange(value: string): void
  onDescriptionRuleChange(value: string): void
  onProseRuleChange(value: string): void
  onSave(): void
  onRun(): void
}>

export function EditorArea(props: Props): React.JSX.Element {
  return <section className="editor-area">
    <div className="editor-tabs">
      <button className={props.selectedPath === undefined ? "active" : ""}><BookOpenText size={15} /> 创作台</button>
      {props.selectedPath === undefined ? null : <button className="active"><span>{props.selectedPath.split("/").at(-1)}</span>{props.dirty ? <i /> : null}</button>}
      <div className="editor-tab-actions"><button title="保存" disabled={!props.dirty || props.readOnly} onClick={props.onSave}><Save size={15} /></button></div>
    </div>
    <div className="editor-document">
      {props.selectedPath === undefined ? <div className="chapter-preview">
        <p className="chapter-kicker">当前正文</p>
        <h1>等待下一轮世界推演</h1>
        <p>输入故事发展、人物行动或你的想法。系统会选择性读取适用规则、设定和持久化图，再生成并提交新的章节 Markdown。</p>
      </div> : <Editor
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
      />}
    </div>
    <div className="turn-composer">
      <div className="composer-heading"><span><Settings2 size={15} /> 本轮发展</span><span>规则以 Markdown 引用</span></div>
      <textarea value={props.prompt} onChange={(event) => { props.onPromptChange(event.target.value); }} placeholder="输入此事如何发展、某人的行动或想法。与世界背景矛盾的内容会作为意图处理，而非直接成为事实。" />
      <div className="composer-controls">
        <label>描写规则<select value={props.descriptionRule} onChange={(event) => { props.onDescriptionRuleChange(event.target.value); }}><option value="">自动</option>{props.descriptionRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}</select></label>
        <label>笔风规则<select value={props.proseRule} onChange={(event) => { props.onProseRuleChange(event.target.value); }}><option value="">保持当前笔风</option>{props.proseRules.map((rule) => <option key={rule} value={rule}>{rule.split("/").at(-1)}</option>)}</select></label>
        <button className="run-command" disabled={props.running || props.prompt.trim().length === 0} onClick={props.onRun}><Play size={16} fill="currentColor" />{props.running ? "推演中" : "开始推演"}</button>
      </div>
    </div>
  </section>
}
