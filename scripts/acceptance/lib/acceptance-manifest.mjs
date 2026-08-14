export function environmentAcceptanceState(executionSteps, reports) {
  const steps = new Map(executionSteps.map((step) => [step.id, step]))
  const baseline = steps.get("baseline")?.status ?? reports.baseline?.status ?? "insufficient"
  const electron = steps.get("electron")?.status ?? (reports.ui?.passed === true ? "pass" : reportStatus(reports.ui))
  return combine(baseline, electron)
}

function reportStatus(report) {
  if (report?.status === "fail" || report?.passed === false) return "fail"
  if (report?.status === "paused") return "paused"
  return "insufficient"
}

function combine(...statuses) {
  const values = statuses.filter(Boolean)
  if (values.includes("fail")) return "fail"
  if (values.includes("paused")) return "paused"
  if (values.includes("not_implemented")) return "not_implemented"
  if (values.includes("insufficient") || values.length === 0) return "insufficient"
  return "pass"
}
