import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { PROTOCOL_VERSION, type DeductionGoalsSnapshot, type TurnDeductionGoalBundle } from "@worldseed/contracts"

import { openChapterHarness, type ChapterHarness } from "./helpers/chapter-coordination-harness.js"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function withHarness(run: (harness: ChapterHarness) => Promise<void>): Promise<void> {
  const harness = await openChapterHarness("Deduction Goals Test")
  temporaryRoots.push(harness.root)
  try {
    await run(harness)
  } finally {
    await harness.container.close()
  }
}

async function invoke<T>(harness: ChapterHarness, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await harness.facade.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    payload,
  })
  if (!response.ok) expect.fail(JSON.stringify(response.error))
  return response.data as T
}

describe("deduction goals", () => {
  it("creates, edits, sets progress, completes and removes goals", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const created = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清名单来源",
      })
      expect(created.goals).toHaveLength(1)
      expect(created.goals[0]?.lifecycle).toBe("active")

      const goalId = created.goals[0]!.goalId
      const updated = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.update", {
        ...base,
        goalId,
        action: "update_content",
        content: "林序查清雾港站夜班名单来源",
      })
      expect(updated.goals[0]?.content).toContain("雾港站")

      const withProgress = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "planned",
      })
      expect(withProgress.progress).toHaveLength(1)
      expect(withProgress.progress[0]?.summary).toBe("获得登记簿副本")

      const completed = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.update", {
        ...base,
        goalId,
        action: "complete",
      })
      expect(completed.goals[0]?.lifecycle).toBe("completed")

      const removed = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.create", {
        ...base,
        content: "东侧渡口势力坐大",
      }).then(async (snapshot) => {
        const nextId = snapshot.goals.find((goal) => goal.lifecycle === "active")!.goalId
        return invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.update", {
          ...base,
          goalId: nextId,
          action: "remove",
        })
      })
      expect(removed.goals.some((goal) => goal.lifecycle === "removed")).toBe(true)
    })
  })

  it("imports legacy localStorage-shaped goals once with taxonomy defaults", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const imported = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.importLegacy", {
        ...base,
        goals: [
          {
            goalId: "legacy-1",
            content: "活跃目标",
            source: "user",
            status: "active",
            createdAtMs: 1,
          },
          {
            goalId: "legacy-2",
            content: "Agent 建议",
            source: "agent",
            status: "pending",
            createdAtMs: 2,
          },
        ],
      })
      const active = imported.goals.find((goal) => goal.content === "活跃目标")
      expect(active?.narrativeKind).toBe("general")
      expect(active?.scale).toBe("short")
      expect(imported.pendingProposals.some((proposal) => proposal.kind === "create")).toBe(true)

      const again = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.importLegacy", {
        ...base,
        goals: [{
          goalId: "legacy-3",
          content: "不应再导入",
          source: "user",
          status: "active",
          createdAtMs: 3,
        }],
      })
      expect(again.goals.some((goal) => goal.content === "不应再导入")).toBe(false)
    })
  })

  it("creates foreshadow goals with chapter window and filters turn bundle", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const foreshadow = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.create", {
        ...base,
        content: "潮纹徽章再出现",
        narrativeKind: "foreshadow",
        scale: "long",
        plantChapterSequence: 10,
        payoffChapterSequence: 40,
      })
      expect(foreshadow.goals[0]?.narrativeKind).toBe("foreshadow")
      expect(foreshadow.goals[0]?.scale).toBe("long")
      expect(foreshadow.goals[0]?.plantChapterSequence).toBe(10)
      expect(foreshadow.goals[0]?.payoffChapterSequence).toBe(40)

      await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.create", {
        ...base,
        content: "本章冲突：码头对峙",
        narrativeKind: "climax",
        scale: "short",
      })

      const goalsService = (await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef))
        .createDeductionGoalsService()
      const early = await goalsService.buildTurnBundle({
        projectId: harness.projectId,
        chapterSequence: 5,
      }) as TurnDeductionGoalBundle
      expect(early.activeGoals.some((goal) => goal.content === "潮纹徽章再出现")).toBe(false)
      expect(early.activeGoals.some((goal) => goal.content === "本章冲突：码头对峙")).toBe(true)

      const mid = await goalsService.buildTurnBundle({
        projectId: harness.projectId,
        chapterSequence: 20,
      })
      expect(mid.activeGoals.some((goal) => goal.content === "潮纹徽章再出现")).toBe(true)
    })
  })

  it("rejects plant after payoff on create", async () => {
    await withHarness(async (harness) => {
      const response = await harness.facade.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method: "deduction.goals.create",
        payload: {
          projectId: harness.projectId,
          workspaceRootRef: harness.workspaceRootRef,
          content: "坏窗口",
          plantChapterSequence: 40,
          payoffChapterSequence: 10,
        },
      })
      expect(response.ok).toBe(false)
    })
  })

  it("approves and rejects agent proposals", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const imported = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.importLegacy", {
        ...base,
        goals: [
          {
            goalId: "p1",
            content: "新势力崛起",
            source: "agent",
            status: "pending",
            createdAtMs: 10,
          },
          {
            goalId: "p2",
            content: "应被拒绝的提案",
            source: "agent",
            status: "pending",
            createdAtMs: 11,
          },
        ],
      })
      const [approveId, rejectId] = imported.pendingProposals.map((proposal) => proposal.proposalId)
      const approved = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.proposal.approve", {
        ...base,
        proposalIds: [approveId!],
      })
      expect(approved.pendingProposals).toHaveLength(1)
      expect(approved.goals.some((goal) => goal.content === "新势力崛起" && goal.lifecycle === "active")).toBe(true)

      const rejected = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.proposal.reject", {
        ...base,
        proposalIds: [rejectId!],
      })
      expect(rejected.pendingProposals).toHaveLength(0)
      expect(rejected.goals.some((goal) => goal.content === "应被拒绝的提案")).toBe(false)
    })
  })

  it("reviews locked planned progress as achieved/partial/missed", async () => {
    await withHarness(async (harness) => {
      const base = {
        projectId: harness.projectId,
        workspaceRootRef: harness.workspaceRootRef,
      }
      const created = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.create", {
        ...base,
        content: "林序查清名单来源",
      })
      const goalId = created.goals[0]!.goalId
      await invoke(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "planned",
      })
      const goalsService = (await harness.container.getRuntime(harness.projectId, harness.workspaceRootRef))
        .createDeductionGoalsService()
      await goalsService.lockForTurn({ projectId: harness.projectId, chapterSequence: 1 })

      const reviewed = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "获得登记簿副本",
        status: "partial",
      })
      const current = reviewed.progress.find((item) => item.goalId === goalId && item.status !== "superseded")
      expect(current?.status).toBe("partial")
      expect(current?.summary).toBe("获得登记簿副本")
      expect(current?.lockedAtMs).toBeUndefined()
      expect(current?.source).toBe("turn_review")

      const missed = await invoke<DeductionGoalsSnapshot>(harness, "deduction.goals.progress.set", {
        ...base,
        goalId,
        chapterSequence: 1,
        summary: "未拿到登记簿",
        status: "missed",
      })
      const missedCurrent = missed.progress.find((item) => item.goalId === goalId && item.status !== "superseded")
      expect(missedCurrent?.status).toBe("missed")
      expect(missedCurrent?.summary).toBe("未拿到登记簿")
    })
  })
})
