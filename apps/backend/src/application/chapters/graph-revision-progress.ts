import type { GraphRevisionTask } from "@worldseed/contracts"
const revisionProgressStages = [
  { phase: "graph_governance", phases: ["graph_governance", "interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review"] },
  { phase: "dependency_audit", phases: ["dependency_audit"] },
  { phase: "graph_structure_plan", phases: ["graph_structure_plan", "graph_capacity_rewrite", "graph_spacetime_settlement", "graph_retrieval_design"] },
  { phase: "graph_governance_review", phases: ["graph_governance_review", "settlement_review"] },
  { phase: "frontier_settlement", phases: ["frontier_settlement"] },
  { phase: "commit_review", phases: ["commit_review"] },
] as const

export function graphRevisionProgress(
  runs: readonly { phase: string; status: string; attempt: number }[],
  completed: boolean,
): GraphRevisionTask["progress"] {
  const latest = new Map<string, { phase: string; status: string; attempt: number }>()
  for (const run of runs) {
    if ((latest.get(run.phase)?.attempt ?? 0) <= run.attempt) latest.set(run.phase, run)
  }
  const phases = revisionProgressStages.flatMap((stage) => {
    const stageRuns = stage.phases.flatMap((phase) => {
      const run = latest.get(phase)
      return run === undefined ? [] : [run]
    })
    if (stageRuns.length === 0) return []
    const active = stageRuns.find((run) => run.status === "running") ?? stageRuns.at(-1)
    if (active === undefined) return []
    return [{
      phase: stage.phase,
      status: stageRuns.some((run) => run.status === "running") ? "running" : active.status,
      attempt: Math.max(...stageRuns.map((run) => run.attempt)),
    }]
  })
  const routing = latest.size === 1 && latest.has("graph_governance")
  const total = completed ? phases.length : routing ? null : revisionProgressStages.length
  const active = phases.find((run) => run.status === "running") ?? phases.at(-1)
  return {
    completed: phases.filter((run) => run.status === "completed").length,
    total,
    ...(active === undefined ? {} : { phase: active.phase }),
    phases,
  }
}
