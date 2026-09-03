import type { ProjectId } from "@worldseed/contracts"

export type SynopsisModelBudgetAdvisory = Readonly<{
  message: string
  callsUsed: number
  softLimit: number
}>

type BudgetEntry = {
  callsSinceAck: number
  softLimit: number
  warningActive: boolean
}

const byProject = new Map<string, BudgetEntry>()

export function configureSynopsisModelBudget(projectId: ProjectId, softLimit: number): void {
  const safeLimit = Math.max(1, softLimit)
  const current = byProject.get(projectId)
  if (current === undefined) {
    byProject.set(projectId, { callsSinceAck: 0, softLimit: safeLimit, warningActive: false })
    return
  }
  current.softLimit = safeLimit
}

export function recordSynopsisModelCall(
  projectId: ProjectId,
  softLimit: number,
): SynopsisModelBudgetAdvisory | undefined {
  configureSynopsisModelBudget(projectId, softLimit)
  const entry = byProject.get(projectId)!
  entry.callsSinceAck += 1
  if (entry.callsSinceAck >= entry.softLimit) {
    entry.warningActive = true
  }
  return entry.warningActive ? buildAdvisory(entry) : undefined
}

export function peekSynopsisModelBudgetAdvisory(projectId: ProjectId): SynopsisModelBudgetAdvisory | undefined {
  const entry = byProject.get(projectId)
  if (entry === undefined || !entry.warningActive) return undefined
  return buildAdvisory(entry)
}

export function acknowledgeSynopsisModelBudget(projectId: ProjectId): void {
  const entry = byProject.get(projectId)
  if (entry === undefined) return
  entry.callsSinceAck = 0
  entry.warningActive = false
}

function buildAdvisory(entry: BudgetEntry): SynopsisModelBudgetAdvisory {
  return {
    message: `梗概讨论模型调用已达提醒阈值（${String(entry.callsSinceAck)} / ${String(entry.softLimit)} 次）。`
      + " 可在右侧查看 KV 缓存、Token 与上下文占用；点击「已知晓」后将重置计数，再次达到阈值时会重新提醒。",
    callsUsed: entry.callsSinceAck,
    softLimit: entry.softLimit,
  }
}
