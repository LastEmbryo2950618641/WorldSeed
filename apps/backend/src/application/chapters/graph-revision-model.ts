import type { GraphRevisionModelActivity } from "@worldseed/contracts"
import type { AIModelPort } from "../turns/ports/ai-model-port.js"

export function createGraphRevisionModel(
  model: AIModelPort,
  onActivity: (activity: GraphRevisionModelActivity | undefined) => void,
  config: { idleTimeoutMs?: number } = {},
): AIModelPort {
  const idleTimeoutMs = config.idleTimeoutMs ?? 120_000
  return {
    ...(model.info === undefined ? {} : { info: model.info }),
    execute: async (request, options) => {
      options?.signal?.throwIfAborted()
      const idleController = new AbortController()
      const signal = options?.signal === undefined ? idleController.signal : AbortSignal.any([options.signal, idleController.signal])
      let active = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let activity: GraphRevisionModelActivity = {
        phase: request.phase, stage: "waiting", attempt: 1, startedAtMs: Date.now(), lastActivityAtMs: Date.now(),
        reasoningCharacters: 0, contentCharacters: 0,
      }
      const heartbeat = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          idleController.abort(new Error(`模型连续 ${String(Math.round(idleTimeoutMs / 1000))} 秒未返回数据，已停止本次图同步，可重试。`))
        }, idleTimeoutMs)
      }
      let rejectAborted!: (reason: unknown) => void
      const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
      const abort = (): void => { rejectAborted(signal.reason) }
      signal.addEventListener("abort", abort, { once: true })
      // Keep authoritative prose and this sync's exchanges. The request delta will
      // resend visible evidence that was only present in omitted historical calls.
      const contextMessages = options?.contextMessages?.filter((message) => (
        message.kind === "system_rules" || message.kind === "canonical_chapter" || message.kind === "chapter_revision"
        || message.taskId === request.taskId
      ))
      onActivity(activity)
      heartbeat()
      try {
        return await Promise.race([aborted, model.execute(request, {
          ...options,
          signal,
          ...(contextMessages === undefined ? {} : { contextMessages }),
          contextChainId: `${options?.contextChainId ?? request.projectId}:graph-revision:${request.taskId}`,
          onPartial: (partial) => {
            if (!active) return
            if (!partial.reasoningDelta && !partial.contentDelta) return
            heartbeat()
            activity = {
              ...activity, stage: partial.contentDelta ? "responding" : "thinking", lastActivityAtMs: Date.now(),
              reasoningCharacters: activity.reasoningCharacters + (partial.reasoningDelta?.length ?? 0),
              contentCharacters: activity.contentCharacters + (partial.contentDelta?.length ?? 0),
            }
            onActivity(activity)
            options?.onPartial?.(partial)
          },
          onSchemaRepair: () => {
            if (!active) return
            heartbeat()
            activity = { ...activity, stage: "repairing", attempt: activity.attempt + 1, lastActivityAtMs: Date.now(), reasoningCharacters: 0, contentCharacters: 0 }
            onActivity(activity)
            options?.onSchemaRepair?.()
          },
        })])
      } finally {
        active = false
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        onActivity(undefined)
      }
    },
  }
}
