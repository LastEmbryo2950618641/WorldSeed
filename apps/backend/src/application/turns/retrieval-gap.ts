import type { PhaseResultEnvelope } from "@worldseed/contracts"

import type { TurnRetrievalGap } from "./ports/index.js"

export function createRetrievalGaps(
  requests: PhaseResultEnvelope["requestedReads"],
): TurnRetrievalGap[] {
  return requests.map((request) => ({
    typeId: "system:retrieval-gap",
    requestId: request.requestId,
    expectedEvidence: request.expectedEvidence,
    reason: request.reason,
    query: request.query,
  }))
}
