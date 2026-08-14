import { describe, expect, it } from "vitest"

import {
  calculateEffectiveWorldEvolutionLimits,
  deepSeekRuntimeConfigSchema,
  defaultDeepSeekRuntimeConfig,
  defaultGraphCapacityProfile,
  defaultProjectSettings,
  defaultTurnExecutionProfile,
  defaultWorldEvolutionProfile,
  graphCapacityProfileSchema,
  runtimeDiagnosticsConfigFromEnvironment,
} from "../src/index.js"

describe("current configuration", () => {
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
    expect(defaultProjectSettings.graph).toMatchObject({
      maxDirectOutDegree: 12,
      maxDirectInDegree: 12,
      mergeWarningThreshold: 10,
      layoutMode: "layered_collision_avoidance",
    })
    expect(defaultProjectSettings.execution).toMatchObject({
      maxModelCalls: 400,
      contextCompactionThresholdRatio: 0.97,
      contextCompressionTargetRatio: 0.5,
      outputTokenLimitMode: "model",
      maxWallTimeMs: 7_200_000,
      maxModelRequestTimeMs: 3_600_000,
      maxRetrievalRounds: 10,
    })
    expect(defaultProjectSettings.history.retentionLimit).toBeNull()
  })

  it("matches the documented autonomy scaling at the default value", () => {
    expect(calculateEffectiveWorldEvolutionLimits(
      defaultWorldEvolutionProfile,
      defaultTurnExecutionProfile,
    )).toEqual({
      frontierCandidates: 15,
      activeFrontiers: 3,
      backgroundStepsPerFrontier: 2,
      backgroundModelCalls: 48,
      backgroundContextTokenBudget: 19200,
      backgroundTotalTokens: 240000,
      backgroundWallTimeMs: 2160000,
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

  it("accepts the centralized DeepSeek protocol configuration", () => {
    expect(deepSeekRuntimeConfigSchema.parse(defaultDeepSeekRuntimeConfig)).toEqual(defaultDeepSeekRuntimeConfig)
    expect(defaultDeepSeekRuntimeConfig.contextWindowTokens).toBe(1_000_000)
    expect(defaultDeepSeekRuntimeConfig.jsonModeEnabled).toBe(false)
    expect(defaultDeepSeekRuntimeConfig.thinkingModeEnabled).toBe(true)
    expect(defaultDeepSeekRuntimeConfig.reasoningEffort).toBe("high")
    expect(defaultDeepSeekRuntimeConfig.timeoutMs).toBe(7_200_000)
    expect(deepSeekRuntimeConfigSchema.safeParse({
      ...defaultDeepSeekRuntimeConfig,
      model: "deepseek-v4-flash",
    }).success).toBe(true)
    expect(deepSeekRuntimeConfigSchema.safeParse({
      ...defaultDeepSeekRuntimeConfig,
      baseUrl: "http://api.example.com",
    }).success).toBe(false)
  })

  it("centralizes development diagnostics at debug level", () => {
    expect(runtimeDiagnosticsConfigFromEnvironment({}, "C:\\logs\\worldseed.log", true)).toEqual({
      level: "debug",
      consoleEnabled: true,
      fileEnabled: true,
      filePath: "C:\\logs\\worldseed.log",
    })
    expect(runtimeDiagnosticsConfigFromEnvironment({
      WORLDSEED_LOG_LEVEL: "warn",
      WORLDSEED_LOG_CONSOLE: "false",
      WORLDSEED_LOG_FILE_ENABLED: "false",
    }, "C:\\logs\\worldseed.log", true)).toEqual({
      level: "warn",
      consoleEnabled: false,
      fileEnabled: false,
      filePath: "C:\\logs\\worldseed.log",
    })
  })
})
