import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

function formatJson(value: unknown, fallback: string): string {
  return JSON.stringify(value, null, 2) || fallback
}

export function PhaseIoPending({
  latestStatus,
  visualKind,
}: {
  latestStatus: string | undefined
  visualKind?: "done" | "failed" | "running" | "idle" | undefined
}): React.JSX.Element {
  if (visualKind === "failed" || latestStatus === "failed") {
    return <p className="phase-empty">该阶段未能完成，可稍后重试或继续。</p>
  }
  if (latestStatus === "running" || visualKind === "running") {
    return <p className="phase-empty">已向模型发起请求，等待 AI 返回思考记录与正式输出。</p>
  }
  return <p className="phase-empty">尚未进入该阶段；进入后会先显示请求态，返回后再展开 AI 思考与 AI 输出。</p>
}

export function PhaseIoDetails({ result }: { result: unknown }): React.JSX.Element {
  const value = typeof result === "object" && result !== null ? result as Record<string, unknown> : {}
  const artifact = typeof value.artifact === "object" && value.artifact !== null
    ? value.artifact as Record<string, unknown>
    : undefined
  const continuityAdvice = Array.isArray(artifact?.continuityAdvice)
    ? artifact.continuityAdvice
    : []
  const modelReasoning = typeof value.modelReasoning === "string" && value.modelReasoning.trim().length > 0
    ? value.modelReasoning
    : "该模型未返回可展示的思考内容。"
  const reasoningLabel = value.modelReasoningKind === "provider_summary" ? "AI 思考摘要" : "AI 思考"
  const { modelReasoning: _modelReasoning, modelReasoningKind: _modelReasoningKind, ...structuredOutput } = value
  const output = value.rawModelOutput ?? (typeof result === "object" && result !== null ? structuredOutput : result)
  return <div className="phase-details">
    <p className="phase-note">展开后可查看该阶段的模型思考记录与正式输出，默认折叠，避免占满右侧面板。</p>
    {continuityAdvice.length === 0 ? null : <ContinuityAdvicePanel advice={continuityAdvice} />}
    <details>
      <summary className="sub-panel-summary">{reasoningLabel}</summary>
      <div className="phase-reasoning-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{modelReasoning}</ReactMarkdown></div>
    </details>
    <details>
      <summary className="sub-panel-summary">AI 输出</summary>
      <pre>{typeof output === "string" ? output : formatJson(output, "暂无输出")}</pre>
    </details>
  </div>
}

function ContinuityAdvicePanel({ advice }: { advice: readonly unknown[] }): React.JSX.Element {
  return <details className="continuity-advice">
    <summary className="sub-panel-summary">连续性建议</summary>
    <div className="continuity-advice-list">{advice.map((item, index) => {
      const value = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}
      const evidenceRefs = Array.isArray(value.evidenceRefs)
        ? value.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
        : []
      return <article className="continuity-advice-item" key={typeof value.claimRef === "string" ? value.claimRef : index}>
        {typeof value.proseExcerpt === "string" ? <blockquote>{value.proseExcerpt}</blockquote> : null}
        <p><strong>{continuityVerdictLabel(value.verdict)}</strong>{typeof value.summary === "string" ? ` · ${value.summary}` : ""}</p>
        {evidenceRefs.length === 0 ? null : <p><small>依据：{evidenceRefs.join("、")}</small></p>}
        {typeof value.suggestedDirection === "string" ? <p>建议：{value.suggestedDirection}</p> : null}
      </article>
    })}</div>
  </details>
}

function continuityVerdictLabel(verdict: unknown): string {
  if (verdict === "pass") return "一致"
  if (verdict === "conflict") return "冲突"
  return "不确定"
}
