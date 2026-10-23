import type { ModelContextMessage, ModelContextMessageDraft } from "@worldseed/contracts"

import { digest } from "../../core/index.js"

const OUTPUT_CONTRACT_PREFIX = "MANDATORY OUTPUT CONTRACT"

/**
 * Static tail messages re-attached on every model call for the wire format.
 * Persisting every copy into the durable chain causes exact-duplicate bloat.
 */
export function isStaticRedundantContextContent(
  kind: ModelContextMessageDraft["kind"] | ModelContextMessage["kind"],
  content: string | undefined,
): boolean {
  if (content === undefined || content.length === 0) return false
  if (kind === "phase_instruction" || kind === "phase_protocol") return true
  if (kind === "phase_request" && content.startsWith(OUTPUT_CONTRACT_PREFIX)) return true
  return false
}

/**
 * Keep only novel exchange drafts for durable persistence.
 * Always keeps phase deltas, responses, and first-seen static instruction/protocol/contract.
 */
export function filterNovelContextExchangeMessages(
  existing: readonly Pick<ModelContextMessage, "kind" | "content" | "contentDigest">[],
  drafts: readonly ModelContextMessageDraft[],
): ModelContextMessageDraft[] {
  const seen = new Set<string>()
  for (const message of existing) {
    const content = message.content
    if (content === undefined) continue
    if (!isStaticRedundantContextContent(message.kind, content)) continue
    seen.add(staticContentKey(message.kind, content, message.contentDigest))
  }

  const kept: ModelContextMessageDraft[] = []
  for (const draft of drafts) {
    const content = draft.content
    if (content === undefined) {
      kept.push(draft)
      continue
    }
    if (!isStaticRedundantContextContent(draft.kind, content)) {
      kept.push(draft)
      continue
    }
    const key = staticContentKey(draft.kind, content)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(draft)
  }
  return kept
}

/**
 * Ids of later exact duplicates of static instruction/protocol/output-contract messages.
 * Keeps the earliest sequence for each digest so existing chains can be cleaned.
 */
export function findExactDuplicateStaticMessageIds(
  messages: readonly ModelContextMessage[],
): readonly string[] {
  const seen = new Set<string>()
  const hide: string[] = []
  const sorted = [...messages].sort((left, right) => left.sequence - right.sequence)
  for (const message of sorted) {
    const content = message.content
    if (content === undefined) continue
    if (!isStaticRedundantContextContent(message.kind, content)) continue
    const key = staticContentKey(message.kind, content, message.contentDigest)
    if (seen.has(key)) hide.push(message.messageId)
    else seen.add(key)
  }
  return hide
}

function staticContentKey(
  kind: string,
  content: string,
  contentDigest?: string,
): string {
  return `${kind}:${contentDigest !== undefined && contentDigest.length > 0 ? contentDigest : digest(content)}`
}
