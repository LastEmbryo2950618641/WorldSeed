import { describe, expect, it } from "vitest"

import type { ProjectId } from "@worldseed/contracts"

import { DeductionGoalsService } from "../src/application/chapters/deduction-goals-service.js"

function createService(requireComplete: boolean): DeductionGoalsService {
  const goals = {
    findGoal: async () => ({
      goalId: "g1",
      projectId: "p1",
      content: "仇恨党伏笔",
      source: "agent",
      lifecycle: "active",
      narrativeKind: "foreshadow",
      scale: "long",
      plantChapterSequence: 3,
      createdAtMs: 0,
      updatedAtMs: 0,
    }),
  }
  return new DeductionGoalsService({
    goals: goals as never,
    createId: () => "id",
    now: () => 0,
    readRequireCompleteHookSchedules: async () => requireComplete,
  })
}

describe("goal proposal schedule audit", () => {
  const projectId = "p1" as ProjectId

  it("flags foreshadow proposals missing a payoff chapter so discuss can self-repair", async () => {
    const issues = await createService(true).auditProposalSchedules(projectId, [
      { payload: { kind: "create", content: "女主三党伏笔", narrativeKind: "foreshadow", plantChapterSequence: 2 } },
      { payload: { kind: "update_content", goalId: "g1", content: "仇恨党伏笔" } },
      { payload: { kind: "create", content: "普通目标" } },
    ] as never)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain("兑现章")
    expect(issues[1]).toContain("goalId=g1")
  })

  it("passes complete schedules and skips the check when the setting allows incomplete hooks", async () => {
    const complete = await createService(true).auditProposalSchedules(projectId, [
      { payload: { kind: "create", content: "女主三党伏笔", narrativeKind: "foreshadow", plantChapterSequence: 2, payoffChapterSequence: 9 } },
    ] as never)
    expect(complete).toEqual([])
    const lenient = await createService(false).auditProposalSchedules(projectId, [
      { payload: { kind: "create", content: "女主三党伏笔", narrativeKind: "foreshadow", plantChapterSequence: 2 } },
    ] as never)
    expect(lenient).toEqual([])
  })
})
