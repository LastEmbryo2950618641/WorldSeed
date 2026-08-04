import type { TurnExecutionProfile, WorldEvolutionProfile } from "./profiles.js"

export function scaleInt(limit: number, factor: number): number {
  if (factor <= 0 || limit <= 0) {
    return 0
  }

  const autonomy = Math.min(1, factor)
  return Math.min(limit, Math.max(1, Math.ceil(limit * autonomy)))
}

export function scaleBudget(limit: number, factor: number): number {
  if (factor <= 0 || limit <= 0) {
    return 0
  }

  return Math.min(limit, Math.floor(limit * Math.min(1, factor)))
}

export type EffectiveWorldEvolutionLimits = Readonly<{
  frontierCandidates: number
  activeFrontiers: number
  backgroundStepsPerFrontier: number
  backgroundModelCalls: number
  backgroundContextTokenBudget: number
  backgroundTotalTokens: number
  backgroundWallTimeMs: number
  foregroundAutonomyCandidates: number
  foregroundAutonomyContextTokenBudget: number
  autonomousSignalsPerChapter: number
}>

export function calculateEffectiveWorldEvolutionLimits(
  evolution: WorldEvolutionProfile,
  turn: TurnExecutionProfile,
): EffectiveWorldEvolutionLimits {
  const autonomy = evolution.enabled ? evolution.worldAutonomy : 0

  return Object.freeze({
    frontierCandidates: scaleInt(evolution.maxFrontierCandidates, autonomy),
    activeFrontiers: scaleInt(evolution.maxActiveFrontiersPerTurn, autonomy),
    backgroundStepsPerFrontier: scaleInt(evolution.maxBackgroundStepsPerFrontier, autonomy),
    backgroundModelCalls: scaleInt(evolution.maxBackgroundModelCalls, autonomy),
    backgroundContextTokenBudget: scaleBudget(evolution.backgroundContextTokenBudget, autonomy),
    backgroundTotalTokens: scaleBudget(evolution.maxBackgroundTotalTokens, autonomy),
    backgroundWallTimeMs: scaleBudget(evolution.maxBackgroundWallTimeMs, autonomy),
    foregroundAutonomyCandidates: scaleInt(turn.maxForegroundAutonomyCandidates, autonomy),
    foregroundAutonomyContextTokenBudget: scaleBudget(turn.foregroundAutonomyContextTokenBudget, autonomy),
    autonomousSignalsPerChapter: scaleInt(evolution.targetAutonomousSignalsPerChapter, autonomy),
  })
}
