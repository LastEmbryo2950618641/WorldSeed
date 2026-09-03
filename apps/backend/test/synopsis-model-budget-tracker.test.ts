import { describe, expect, it } from "vitest"

import {
  acknowledgeSynopsisModelBudget,
  peekSynopsisModelBudgetAdvisory,
  recordSynopsisModelCall,
} from "../src/application/chapters/synopsis-model-budget-tracker.js"

describe("synopsis model budget tracker", () => {
  it("warns when soft limit is reached and resets after acknowledge", () => {
    const projectId = "project-budget-test"
    expect(recordSynopsisModelCall(projectId, 3)).toBeUndefined()
    expect(recordSynopsisModelCall(projectId, 3)).toBeUndefined()
    const third = recordSynopsisModelCall(projectId, 3)
    expect(third?.callsUsed).toBe(3)
    expect(third?.softLimit).toBe(3)
    expect(peekSynopsisModelBudgetAdvisory(projectId)?.message).toContain("提醒阈值")
    acknowledgeSynopsisModelBudget(projectId)
    expect(peekSynopsisModelBudgetAdvisory(projectId)).toBeUndefined()
    expect(recordSynopsisModelCall(projectId, 3)).toBeUndefined()
    expect(recordSynopsisModelCall(projectId, 3)).toBeUndefined()
    const warnedAgain = recordSynopsisModelCall(projectId, 3)
    expect(warnedAgain?.callsUsed).toBe(3)
  })
})
