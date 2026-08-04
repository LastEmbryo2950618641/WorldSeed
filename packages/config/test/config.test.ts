import { describe, expect, it } from "vitest"

import {
  calculateEffectiveWorldEvolutionLimits,
  deepSeekRuntimeConfigSchema,
  defaultDeepSeekRuntimeConfig,
  defaultGraphCapacityProfile,
  defaultTurnExecutionProfile,
  defaultWorldEvolutionProfile,
  graphCapacityProfileSchema,
} from "../src/index.js"

describe("frozen V1 configuration", () => {
  it("keeps graph warning and expansion limits internally consistent", () => {
    expect(defaultGraphCapacityProfile.maxDirectOutDegree).toBe(12)
    expect(defaultGraphCapacityProfile.maxDirectInDegree).toBe(12)
    expect(defaultGraphCapacityProfile.mergeWarningThreshold).toBe(10)

    expect(graphCapacityProfileSchema.safeParse({
      ...defaultGraphCapacityProfile,
      mergeWarningThreshold: 13,
    }).success).toBe(false)
    expect(graphCapacityProfileSchema.safeParse({
      ...defaultGraphCapacityProfile,
      preferredExpansionDepth: 5,
    }).success).toBe(false)
  })

  it("matches the documented autonomy scaling at the default value", () => {
    expect(calculateEffectiveWorldEvolutionLimits(
      defaultWorldEvolutionProfile,
      defaultTurnExecutionProfile,
    )).toEqual({
      frontierCandidates: 15,
      activeFrontiers: 3,
      backgroundStepsPerFrontier: 2,
      backgroundModelCalls: 5,
      backgroundContextTokenBudget: 4800,
      backgroundTotalTokens: 14400,
      backgroundWallTimeMs: 9000,
      foregroundAutonomyCandidates: 4,
      foregroundAutonomyContextTokenBudget: 3600,
      autonomousSignalsPerChapter: 2,
    })
  })

  it("disables optional autonomous work without disabling the world model", () => {
    expect(calculateEffectiveWorldEvolutionLimits(
      { ...defaultWorldEvolutionProfile, enabled: false },
      defaultTurnExecutionProfile,
    )).toEqual({
      frontierCandidates: 0,
      activeFrontiers: 0,
      backgroundStepsPerFrontier: 0,
      backgroundModelCalls: 0,
      backgroundContextTokenBudget: 0,
      backgroundTotalTokens: 0,
      backgroundWallTimeMs: 0,
      foregroundAutonomyCandidates: 0,
      foregroundAutonomyContextTokenBudget: 0,
      autonomousSignalsPerChapter: 0,
    })
  })

  it("accepts the frozen DeepSeek JSON Mode configuration", () => {
    expect(deepSeekRuntimeConfigSchema.parse(defaultDeepSeekRuntimeConfig)).toEqual(defaultDeepSeekRuntimeConfig)
    expect(deepSeekRuntimeConfigSchema.safeParse({
      ...defaultDeepSeekRuntimeConfig,
      baseUrl: "http://api.example.com",
    }).success).toBe(false)
  })
})
