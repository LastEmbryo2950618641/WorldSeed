import { useState } from "react"
import { Bot, Send, Sparkles, UserRound } from "lucide-react"
import type { ChapterRevisionConversationMessage } from "@worldseed/contracts"

type Props = Readonly<{
  variant?: "default" | "rail"
  messages: readonly ChapterRevisionConversationMessage[]
  revisionTaskId: string | undefined
  busy: boolean
  onSend(message: string): Promise<void>
  onInspectDiff?(messageId: string): void
}>

export function ChapterConversationComposer(props: Props): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const variant = props.variant ?? "default"
  const submit = async (): Promise<void> => {
    const message = draft.trim()
    if (message.length === 0 || props.busy) return
    setDraft("")
    await props.onSend(message)
  }

  return <div className={`chapter-conversation${variant === "rail" ? " chapter-conversation--rail" : ""}`} data-testid="chapter-conversation">
    <div className="composer-heading">
      <span>{variant === "rail" ? "Agent 对话" : "Agent 对话修订"}</span>
      {variant === "rail"
        ? null
        : <span>描述你想如何改这一章，Agent 会给出修订建议</span>}
    </div>
    <div className="chapter-conversation-thread" aria-live="polite">
      {props.messages.length === 0
        ? <p className="chapter-conversation-empty">
            <Sparkles size={16} aria-hidden="true" />
            {variant === "rail"
              ? "描述修订意图，例如「把开头写得更悬疑」"
              : "还没有对话。在下方输入修订意图，例如「把开头写得更悬疑一些」。"}
          </p>
        : props.messages.map((message) => <article className={`chapter-conversation-message ${message.role}`} key={message.messageId}>
          <header>
            {message.role === "user"
              ? <><UserRound size={12} aria-hidden="true" /> 你</>
              : <><Bot size={12} aria-hidden="true" /> Agent</>}
          </header>
          <p>{message.content}</p>
          {message.role === "assistant" && message.proposal !== undefined && props.revisionTaskId !== undefined
            ? <div className="chapter-conversation-message-actions">
                <span className="chapter-conversation-applied">已自动写入草稿</span>
                {props.onInspectDiff === undefined
                  ? null
                  : <button
                      className="chapter-conversation-inspect-diff"
                      type="button"
                      onClick={() => { props.onInspectDiff?.(message.messageId); }}
                    >
                      {variant === "rail" ? "查看对比" : "在编辑区查看对比"}
                    </button>}
              </div>
            : null}
        </article>)}
    </div>
    <div className="chapter-conversation-input">
      <textarea
        value={draft}
        disabled={props.busy}
        placeholder={variant === "rail" ? "告诉 Agent 如何改这一章…" : "告诉 Agent 你想如何修订这一章…"}
        onChange={(event) => { setDraft(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <button className="run-command" disabled={props.busy || draft.trim().length === 0} onClick={() => { void submit(); }}>
        <Send size={15} aria-hidden="true" />{props.busy ? "处理中" : "发送"}
      </button>
    </div>
  </div>
}
