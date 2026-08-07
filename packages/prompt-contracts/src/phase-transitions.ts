import type { AIPhase } from "@worldseed/contracts"

export type PhaseTransition = {
  readonly next: readonly AIPhase[]
  readonly returnsTo: readonly AIPhase[]
}

export const phaseTransitions: Record<AIPhase, PhaseTransition> = {
  interpret: { next: ["rule_assembly"], returnsTo: [] },
  rule_assembly: { next: ["source_retrieval", "emergence_planning"], returnsTo: ["interpret"] },
  source_retrieval: {
    next: ["emergence_planning", "emergence_review", "draft", "dependency_audit", "response_review", "graph_governance", "semantic_review", "commit_review"],
    returnsTo: ["source_retrieval"],
  },
  emergence_planning: { next: ["emergence_review"], returnsTo: ["source_retrieval"] },
  emergence_review: { next: ["draft"], returnsTo: ["source_retrieval", "emergence_planning"] },
  draft: { next: ["chapter_naming", "dependency_audit"], returnsTo: ["source_retrieval", "emergence_planning"] },
  chapter_naming: { next: ["dependency_audit"], returnsTo: ["draft"] },
  dependency_audit: { next: ["graph_governance", "response_review"], returnsTo: ["source_retrieval", "emergence_planning", "draft"] },
  response_review: { next: [], returnsTo: ["source_retrieval", "draft"] },
  graph_governance: { next: ["semantic_review"], returnsTo: ["source_retrieval"] },
  semantic_review: { next: ["settlement_review", "frontier_settlement"], returnsTo: ["source_retrieval", "graph_governance"] },
  settlement_review: { next: ["frontier_settlement"], returnsTo: ["graph_governance"] },
  frontier_settlement: { next: ["commit_review"], returnsTo: ["graph_governance"] },
  commit_review: { next: [], returnsTo: ["source_retrieval", "graph_governance", "settlement_review", "frontier_settlement"] },
  context_compaction: { next: ["context_compaction_review"], returnsTo: [] },
  context_compaction_review: {
    next: ["source_retrieval", "emergence_planning", "draft", "dependency_audit", "graph_governance"],
    returnsTo: ["context_compaction"],
  },
}

export function isAllowedPhaseTransition(from: AIPhase, to: AIPhase): boolean {
  const transition = phaseTransitions[from]
  return transition.next.includes(to) || transition.returnsTo.includes(to)
}
