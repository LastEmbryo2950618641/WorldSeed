import type { DeductionTask } from "@worldseed/contracts"

const draftProgressStages = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "emergence_planning",
  "draft",
  "chapter_naming",
] as const

export function deductionTaskProgress(
  runs: readonly { phase: string; status: string; attempt: number }[],
  completed: boolean,
): DeductionTask["progress"] {
  const latest = new Map<string, { phase: string; status: string; attempt: number }>()
  for (const run of runs) {
    if ((latest.get(run.phase)?.attempt ?? 0) <= run.attempt) latest.set(run.phase, run)
  }
  const ordered = [
    ...draftProgressStages.filter((phase) => latest.has(phase)),
    ...[...latest.keys()].filter((phase) => !(draftProgressStages as readonly string[]).includes(phase)),
  ]
  const phases = ordered.flatMap((phase) => {
    const run = latest.get(phase)
    return run === undefined ? [] : [run]
  })
  const active = phases.find((run) => run.status === "running") ?? phases.at(-1)
  return {
    completed: phases.filter((run) => run.status === "completed").length,
    total: completed ? phases.length : draftProgressStages.length,
    ...(active === undefined ? {} : { phase: active.phase }),
    phases,
  }
}
