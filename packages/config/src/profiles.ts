import { z } from "zod"
import { projectSettingsSchema } from "@worldseed/contracts"

const positiveInteger = z.number().int().positive()
const nonnegativeInteger = z.number().int().nonnegative()
const unitInterval = z.number().min(0).max(1)

export const graphCapacityProfileSchema = z.object({
  maxDirectOutDegree: positiveInteger,
  maxDirectInDegree: positiveInteger,
  mergeWarningThreshold: positiveInteger,
  preferredExpansionDepth: nonnegativeInteger,
  maxExpansionDepth: nonnegativeInteger,
  maxVisitedNodes: positiveInteger,
  maxVisitedLinks: positiveInteger,
  maxNeighborhoodAnchors: positiveInteger,
  maxNodeContentTokens: positiveInteger,
  contextTokenBudget: positiveInteger,
  recallTopKPerExpression: positiveInteger,
  maxRecallCandidates: positiveInteger,
  maxRecallRounds: positiveInteger,
  maxSearchExpressionsPerRound: positiveInteger,
  targetMechanicalRecallP95Ms: positiveInteger,
  targetContextAssemblyP95Ms: positiveInteger,
}).superRefine((profile, context) => {
  if (profile.mergeWarningThreshold > Math.min(profile.maxDirectOutDegree, profile.maxDirectInDegree)) {
    context.addIssue({
      code: "custom",
      message: "mergeWarningThreshold cannot exceed either direct degree limit",
      path: ["mergeWarningThreshold"],
    })
  }

  if (profile.preferredExpansionDepth > profile.maxExpansionDepth) {
    context.addIssue({
      code: "custom",
      message: "preferredExpansionDepth cannot exceed maxExpansionDepth",
      path: ["preferredExpansionDepth"],
    })
  }

  if (profile.recallTopKPerExpression > profile.maxRecallCandidates) {
    context.addIssue({
      code: "custom",
      message: "recallTopKPerExpression cannot exceed maxRecallCandidates",
      path: ["recallTopKPerExpression"],
    })
  }
})
export type GraphCapacityProfile = z.infer<typeof graphCapacityProfileSchema>

export const turnExecutionProfileSchema = z.object({
  maxTurnModelCalls: positiveInteger,
  maxTurnWallTimeMs: positiveInteger,
  maxDraftAuditRounds: positiveInteger,
  maxGraphGovernanceRounds: positiveInteger,
  maxSettlementReviewRounds: positiveInteger,
  maxForegroundAutonomyCandidates: nonnegativeInteger,
  foregroundAutonomyContextTokenBudget: nonnegativeInteger,
})
export type TurnExecutionProfile = z.infer<typeof turnExecutionProfileSchema>

export const worldEmergenceProfileSchema = z.object({
  worldNovelty: unitInterval,
  maxEmergenceCandidatesPerTurn: positiveInteger,
  maxCurrentDraftEmergencesPerTurn: nonnegativeInteger,
  maxBackgroundEmergencesPerTurn: nonnegativeInteger,
  maxNewGraphAnchorsPerDecision: positiveInteger,
  emergenceContextTokenBudget: nonnegativeInteger,
  maxEmergenceReviewRounds: positiveInteger,
  maxRetrospectiveSupportAnchors: nonnegativeInteger,
  maxEmergenceNarrativeShare: unitInterval,
}).superRefine((profile, context) => {
  const usedCandidates = profile.maxCurrentDraftEmergencesPerTurn + profile.maxBackgroundEmergencesPerTurn
  if (usedCandidates > profile.maxEmergenceCandidatesPerTurn) {
    context.addIssue({
      code: "custom",
      message: "foreground and background emergence limits cannot exceed the total candidate limit",
      path: ["maxEmergenceCandidatesPerTurn"],
    })
  }
})
export type WorldEmergenceProfile = z.infer<typeof worldEmergenceProfileSchema>

export const worldEvolutionProfileSchema = z.object({
  evolutionFrontierRootId: z.string().min(1),
  currentWorldTimeAnchorId: z.string().min(1),
  narrativeSignalHistoryRootId: z.string().min(1),
  enabled: z.boolean(),
  worldAutonomy: unitInterval,
  maxFrontierCandidates: positiveInteger,
  maxActiveFrontiersPerTurn: positiveInteger,
  maxConsecutiveFrontierDeferrals: positiveInteger,
  minOverdueFrontierShare: unitInterval,
  maxBackgroundStepsPerFrontier: positiveInteger,
  backgroundContextTokenBudget: nonnegativeInteger,
  maxBackgroundModelCalls: nonnegativeInteger,
  maxBackgroundWallTimeMs: nonnegativeInteger,
  maxBackgroundTotalTokens: nonnegativeInteger,
  lazyCatchUpTokenBudget: nonnegativeInteger,
  maxJointFrontiersPerTurn: nonnegativeInteger,
  maxJointParticipants: positiveInteger,
  maxCrossImpactRounds: positiveInteger,
  targetAutonomousSignalsPerChapter: nonnegativeInteger,
  maxAutonomousNarrativeShare: unitInterval,
  recentSignalWindowChapters: positiveInteger,
  maxRepeatedSignalsPerAnchor: nonnegativeInteger,
  targetDistinctSignalAnchorsPerWindow: nonnegativeInteger,
}).superRefine((profile, context) => {
  if (profile.maxActiveFrontiersPerTurn > profile.maxFrontierCandidates) {
    context.addIssue({
      code: "custom",
      message: "maxActiveFrontiersPerTurn cannot exceed maxFrontierCandidates",
      path: ["maxActiveFrontiersPerTurn"],
    })
  }

  if (profile.maxJointFrontiersPerTurn > profile.maxActiveFrontiersPerTurn) {
    context.addIssue({
      code: "custom",
      message: "maxJointFrontiersPerTurn cannot exceed maxActiveFrontiersPerTurn",
      path: ["maxJointFrontiersPerTurn"],
    })
  }
})
export type WorldEvolutionProfile = z.infer<typeof worldEvolutionProfileSchema>

export const defaultGraphCapacityProfile = Object.freeze(graphCapacityProfileSchema.parse({
  maxDirectOutDegree: 12,
  maxDirectInDegree: 12,
  mergeWarningThreshold: 10,
  preferredExpansionDepth: 2,
  maxExpansionDepth: 4,
  maxVisitedNodes: 96,
  maxVisitedLinks: 192,
  maxNeighborhoodAnchors: 32,
  maxNodeContentTokens: 512,
  contextTokenBudget: 12000,
  recallTopKPerExpression: 20,
  maxRecallCandidates: 80,
  maxRecallRounds: 3,
  maxSearchExpressionsPerRound: 6,
  targetMechanicalRecallP95Ms: 500,
  targetContextAssemblyP95Ms: 3000,
}))

export const defaultTurnExecutionProfile = Object.freeze(turnExecutionProfileSchema.parse({
  maxTurnModelCalls: 400,
  maxTurnWallTimeMs: 7_200_000,
  maxDraftAuditRounds: 3,
  maxGraphGovernanceRounds: 3,
  maxSettlementReviewRounds: 2,
  maxForegroundAutonomyCandidates: 6,
  foregroundAutonomyContextTokenBudget: 6000,
}))

export const defaultTurnWallTimeMs = defaultTurnExecutionProfile.maxTurnWallTimeMs

export const defaultProjectSettings = Object.freeze(projectSettingsSchema.parse({
  version: 2,
  execution: {
    maxModelCalls: defaultTurnExecutionProfile.maxTurnModelCalls,
    contextCompactionThresholdRatio: 0.97,
    contextCompressionTargetRatio: 0.5,
    outputTokenLimitMode: "model",
    maxWallTimeMs: defaultTurnExecutionProfile.maxTurnWallTimeMs,
    maxModelRequestTimeMs: 3_600_000,
    backendRequestWaitTimeoutMs: 600_000,
    maxRetrievalRounds: 30,
    worldDivergenceMode: "world_consistent",
  },
  retrieval: {
    maxRequestsPerRound: 10,
    maxCandidates: defaultGraphCapacityProfile.recallTopKPerExpression,
    maxDepth: defaultGraphCapacityProfile.preferredExpansionDepth,
    maxEvidenceTokens: defaultGraphCapacityProfile.contextTokenBudget,
    webResearchEnabled: true,
    maxWebResults: 5,
  },
  graph: {
    maxDirectOutDegree: defaultGraphCapacityProfile.maxDirectOutDegree,
    maxDirectInDegree: defaultGraphCapacityProfile.maxDirectInDegree,
    mergeWarningThreshold: defaultGraphCapacityProfile.mergeWarningThreshold,
    preferredExpansionDepth: defaultGraphCapacityProfile.preferredExpansionDepth,
    maxExpansionDepth: defaultGraphCapacityProfile.maxExpansionDepth,
    maxVisitedNodes: defaultGraphCapacityProfile.maxVisitedNodes,
    maxVisitedLinks: defaultGraphCapacityProfile.maxVisitedLinks,
    maxNeighborhoodAnchors: defaultGraphCapacityProfile.maxNeighborhoodAnchors,
    layoutMode: "layered_collision_avoidance",
  },
  history: {
    retentionLimit: null,
  },
  staging: {
    maxChars: 80_000,
  },
  creationDesk: {
    autoApproveGoalProposals: true,
  },
}))

export const defaultWorldEmergenceProfile = Object.freeze(worldEmergenceProfileSchema.parse({
  worldNovelty: 0.5,
  maxEmergenceCandidatesPerTurn: 12,
  maxCurrentDraftEmergencesPerTurn: 3,
  maxBackgroundEmergencesPerTurn: 4,
  maxNewGraphAnchorsPerDecision: 6,
  emergenceContextTokenBudget: 6000,
  maxEmergenceReviewRounds: 2,
  maxRetrospectiveSupportAnchors: 4,
  maxEmergenceNarrativeShare: 0.2,
}))

export const defaultWorldEvolutionProfile = Object.freeze(worldEvolutionProfileSchema.parse({
  evolutionFrontierRootId: "world-evolution-frontier",
  currentWorldTimeAnchorId: "current-world-time",
  narrativeSignalHistoryRootId: "narrative-signal-history",
  enabled: true,
  worldAutonomy: 0.6,
  maxFrontierCandidates: 24,
  maxActiveFrontiersPerTurn: 4,
  maxConsecutiveFrontierDeferrals: 6,
  minOverdueFrontierShare: 0.25,
  maxBackgroundStepsPerFrontier: 3,
  backgroundContextTokenBudget: 32000,
  maxBackgroundModelCalls: 80,
  maxBackgroundWallTimeMs: 3_600_000,
  maxBackgroundTotalTokens: 400000,
  lazyCatchUpTokenBudget: 48000,
  maxJointFrontiersPerTurn: 2,
  maxJointParticipants: 8,
  maxCrossImpactRounds: 2,
  targetAutonomousSignalsPerChapter: 2,
  maxAutonomousNarrativeShare: 0.25,
  recentSignalWindowChapters: 6,
  maxRepeatedSignalsPerAnchor: 2,
  targetDistinctSignalAnchorsPerWindow: 4,
}))
