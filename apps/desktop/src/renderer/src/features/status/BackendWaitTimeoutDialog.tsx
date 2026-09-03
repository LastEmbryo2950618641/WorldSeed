type Props = Readonly<{
  waitTimeoutMs: number
  elapsedMs: number
  method: string
  onContinue(): void
  onStop(): void
}>

export function BackendWaitTimeoutDialog(props: Props): React.JSX.Element {
  const waitMinutes = Math.max(1, Math.round(props.waitTimeoutMs / 60_000))
  const elapsedMinutes = Math.max(1, Math.round(props.elapsedMs / 60_000))
  return <div className="dialog-backdrop" role="presentation">
    <section
      className="work-name-prompt-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backend-wait-timeout-title"
      data-testid="backend-wait-timeout-dialog"
    >
      <header>
        <div>
          <strong id="backend-wait-timeout-title">仍在等待 Agent 响应</strong>
          <small>已等待约 {elapsedMinutes} 分钟</small>
        </div>
      </header>
      <div className="work-name-prompt-body">
        <p>
          当前请求尚未返回。可以选择再等待 {waitMinutes} 分钟，或停止本次对话。
          停止后，你的输入会回到输入框，且本轮对话会从上下文中移除。
        </p>
        <p className="backend-wait-timeout-method"><code>{props.method}</code></p>
      </div>
      <footer>
        <button type="button" data-testid="backend-wait-timeout-stop" onClick={props.onStop}>
          停止对话
        </button>
        <button
          type="button"
          className="dialog-primary-command"
          data-testid="backend-wait-timeout-continue"
          onClick={props.onContinue}
        >
          继续等待
        </button>
      </footer>
    </section>
  </div>
}
