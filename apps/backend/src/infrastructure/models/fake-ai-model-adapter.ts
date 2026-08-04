import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
} from "@worldseed/contracts"

import {
  chapterNamingArtifactSchema,
  emergencePlanningArtifactSchema,
  graphGovernanceArtifactSchema,
  internalDraftArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

import type {
  AIModelPort,
  PhaseModelExecution,
  TurnPhaseInput,
} from "../../application/index.js"

export class FakeAiModelAdapter implements AIModelPort {
  public constructor(private readonly createId: () => string) {}

  public execute(request: PhaseRequestEnvelope): Promise<PhaseModelExecution> {
    const startedAt = Date.now()
    const input = request.input as TurnPhaseInput
    const artifact = this.createArtifact(request.phase, request, input)
    const producedArtifactIds = artifactIds(request.phase, artifact)
    const decisionRecordIds = request.phase === "graph_governance"
      ? graphGovernanceArtifactSchema.parse(artifact).decisionRecords.map((record) => record.decisionRecordId)
      : []
    const result: PhaseResultEnvelope = {
      schemaVersion: 1,
      envelopeId: request.envelopeId,
      contextId: request.contextId,
      phase: request.phase,
      outcome: request.phase === "commit_review" ? "approve" : "continue",
      artifact,
      requestedReads: [],
      citedReadIds: [...request.committedReadIds],
      producedArtifactIds,
      decisionRecordIds,
      unresolvedDependencies: [],
      reason: `Fake AI completed ${request.phase} using only the supplied turn state`,
      selfReview: "The result contains no hidden reasoning and cites no unreturned reads",
    }
    const inputTokens = estimateTokens(request)
    const outputTokens = estimateTokens(result)
    return Promise.resolve({
      result,
      usage: {
        inputTokens,
        outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
        cacheHitInputTokens: Math.floor(inputTokens / 2),
        cacheMissInputTokens: inputTokens - Math.floor(inputTokens / 2),
      },
    })
  }

  private createArtifact(phase: AIPhase, request: PhaseRequestEnvelope, input: TurnPhaseInput): unknown {
    switch (phase) {
      case "interpret":
        return {
          workflow: "turn",
          userIntent: input.userInput,
          worldIntent: input.userInput,
          presentationIntent: "Use the selected project presentation rules",
          userClaims: [{ text: input.userInput, treatment: "proposal", truthStatus: "current_turn_new" }],
          requiredTimeAnchor: true,
          requiredLocationAnchor: true,
          initialReadHypotheses: [],
        }
      case "rule_assembly":
        return {
          ruleSnapshotId: this.createId(),
          baseRuleVersion: "v1",
          userRuleVersionIds: [],
          settingSkillVersionIds: [],
          referenceSkillVersionIds: [],
          presentationRuleVersionIds: [],
          selectionReasons: { base: "The platform base rules are mandatory" },
          unresolvedRuleConflicts: [],
        }
      case "source_retrieval":
        return {
          executedRequestIds: [],
          returnedReadIds: [],
          rejectedCandidateIds: [],
          missingEvidence: [],
          nextExpansionHints: [],
        }
      case "emergence_planning": {
        const decisionId = this.createId()
        return {
          decisions: [{
            decisionId,
            pressureEvidenceIds: [],
            action: "create_new",
            existingAnchorIds: [],
            proposedAnchorCount: 3,
            timeAnchorIds: [this.createId()],
            locationAnchorIds: [this.createId()],
            informationBoundaryIds: [this.createId()],
            reason: "The first turn requires a minimal time, place, and occurrence structure",
          }],
        }
      }
      case "emergence_review": {
        const planning = emergencePlanningArtifactSchema.parse(input.artifacts.emergence_planning)
        const decisionIds = planning.decisions.map((decision) => decision.decisionId)
        return {
          reviewedDecisionIds: decisionIds,
          approvedDecisionIds: decisionIds,
          revisionRequests: [],
          identityRecallComplete: true,
          temporalEntryComplete: true,
          spatialEntryComplete: true,
          informationBoundaryComplete: true,
        }
      }
      case "draft": {
        const planning = emergencePlanningArtifactSchema.parse(input.artifacts.emergence_planning)
        const decision = planning.decisions[0]
        if (decision === undefined) {
          throw new Error("Fake draft requires one approved emergence decision")
        }
        return {
          draftId: this.createId(),
          contentMarkdown: [
            "最初没有宏大的宣告，只有一处尚未被命名的所在，在某个能够继续向前的时刻安静地显现。",
            input.userInput,
            "变化留下了可以再次返回的痕迹。此后发生的一切，都将从这些已经写下的依据继续生长。",
          ].join("\n\n"),
          adoptedEmergenceDecisionIds: [decision.decisionId],
          citedReadIds: [],
          currentTimeAnchorIds: decision.timeAnchorIds,
          currentLocationAnchorIds: decision.locationAnchorIds,
          detectedUnplannedContent: [],
        }
      }
      case "chapter_naming":
        return {
          chapterId: this.createId(),
          chapterNumberText: `第${chineseNumber(input.chapterSequence)}章`,
          heading: `第${chineseNumber(input.chapterSequence)}章 世界种子`,
          filename: `第${chineseNumber(input.chapterSequence)}章 世界种子.md`,
          continuityEvidenceIds: [],
        }
      case "dependency_audit": {
        const draft = internalDraftArtifactSchema.parse(input.artifacts.draft)
        return {
          auditedDraftId: draft.draftId,
          resolvedDependencyIds: [],
          missingDependencies: [],
          unplannedContent: [],
          timeContinuity: "pass",
          locationContinuity: "pass",
          informationBoundary: "pass",
        }
      }
      case "response_review":
        return {
          responseArtifactId: this.createId(),
          evidenceClosed: true,
          leaksUnobservedInformation: false,
          requiresWorkflowUpgrade: false,
        }
      case "graph_governance":
        return this.createGraphGovernanceArtifact(input)
      case "semantic_review": {
        const governance = graphGovernanceArtifactSchema.parse(input.artifacts.graph_governance)
        return {
          proposalId: governance.proposalId,
          approvedMutationIndexes: governance.mutations.map((_, index) => index),
          rejectedMutationIndexes: [],
          graphStillDiscoverable: true,
          graphStillConcise: true,
          continuityPreserved: true,
        }
      }
      case "settlement_review":
        return {
          sourceUnitIds: [...input.sourceUnitIds],
          settledSourceUnitIds: [...input.sourceUnitIds],
          uncoveredSourceUnitIds: [],
          sourceReturnComplete: true,
          retrievalProjectionComplete: true,
          semanticCoverageComplete: true,
        }
      case "frontier_settlement": {
        const governance = graphGovernanceArtifactSchema.parse(input.artifacts.graph_governance)
        const affectedAnchorIds = governance.mutations.flatMap((mutation) => mutation.operation === "create_node"
          ? [mutation.node.id]
          : [])
        return {
          affectedAnchorIds,
          activeFrontierIds: affectedAnchorIds.slice(0, 1),
          deferredFrontierIds: [],
          archivedFrontierIds: [],
          lastWorldTimeAnchorIds: affectedAnchorIds.slice(1, 2),
          deferralReasons: {},
        }
      }
      case "commit_review":
        return {
          decision: "commit",
          scopeId: request.scopeId,
          requiredPhaseRunIds: [...input.phaseRunIds],
          approvedArtifactIds: Object.values(input.artifacts).flatMap((value) => value === undefined ? [] : artifactIdsFromValue(value)),
          unresolvedDependencyIds: [],
          finalSelfReview: "All required Fake AI phase artifacts are present and the settlement is complete",
        }
    }
  }

  private createGraphGovernanceArtifact(input: TurnPhaseInput): GraphGovernanceArtifact {
    if (input.sourceId === undefined) {
      throw new Error("Graph governance requires a persisted source")
    }
    const planning = emergencePlanningArtifactSchema.parse(input.artifacts.emergence_planning)
    const naming = chapterNamingArtifactSchema.parse(input.artifacts.chapter_naming)
    const decision = planning.decisions[0]
    if (decision === undefined) {
      throw new Error("Graph governance requires an emergence decision")
    }
    const occurrenceId = this.createId()
    const timeId = decision.timeAnchorIds[0] ?? this.createId()
    const locationId = decision.locationAnchorIds[0] ?? this.createId()
    const timeLinkId = this.createId()
    const locationLinkId = this.createId()
    const sourceRefs = [{ sourceId: input.sourceId, locator: { chapterId: naming.chapterId } }]
    const mutations: GraphGovernanceArtifact["mutations"] = [
      { operation: "create_node", node: { id: occurrenceId, content: { text: input.userInput }, sourceRefs } },
      { operation: "create_node", node: { id: timeId, content: { anchor: "initial world time" }, sourceRefs } },
      { operation: "create_node", node: { id: locationId, content: { anchor: "initial scene location" }, sourceRefs } },
      { operation: "create_link", link: { id: timeLinkId, fromNodeId: occurrenceId, toNodeId: timeId, content: { note: "time entry" }, sourceRefs } },
      { operation: "create_link", link: { id: locationLinkId, fromNodeId: occurrenceId, toNodeId: locationId, content: { note: "space entry" }, sourceRefs } },
    ]
    const decisionRecordId = this.createId()
    return {
      proposalId: this.createId(),
      sourceUnitIds: [...input.sourceUnitIds],
      mutations,
      retrievalProjections: [{
        projectionId: this.createId(),
        ownerKind: "node",
        ownerId: occurrenceId,
        ownerMutationIndex: 0,
        exactKeys: [naming.heading, input.userInput],
        semanticText: `Initial chapter occurrence: ${input.userInput}`,
        sourceRefs,
      }],
      settlementRecords: input.sourceUnitIds.map((sourceUnitId) => ({
        settlementRecordId: this.createId(),
        sourceUnitId,
        graphRefs: [{ targetKind: "node", targetId: occurrenceId, mutationIndex: 0 }],
        reason: "The source unit returns through the chapter occurrence anchor",
        status: "settled",
      })),
      continuityProofs: [{
        continuityProofId: this.createId(),
        payload: { timeAnchorIds: [timeId], locationAnchorIds: [locationId], predecessorRevisionIds: [] },
      }],
      archiveOutletIds: [],
      decisionRecords: [{
        decisionRecordId,
        decisionKind: "initial_graph_governance",
        mutationIndexes: mutations.map((_, index) => index),
        reason: "Create the smallest reusable graph that can return to every source unit",
        evidenceIds: [...input.sourceUnitIds],
        payload: { proposalKind: "initial_turn" },
        selfReview: "The proposal reuses the approved time and place anchors and adds no domain-specific schema",
      }],
    }
  }
}

function artifactIds(phase: AIPhase, artifact: unknown): string[] {
  switch (phase) {
    case "rule_assembly":
      return [(artifact as { ruleSnapshotId: string }).ruleSnapshotId]
    case "emergence_planning":
      return emergencePlanningArtifactSchema.parse(artifact).decisions.map((decision) => decision.decisionId)
    case "draft":
      return [internalDraftArtifactSchema.parse(artifact).draftId]
    case "chapter_naming":
      return [chapterNamingArtifactSchema.parse(artifact).chapterId]
    case "graph_governance": {
      const governance = graphGovernanceArtifactSchema.parse(artifact)
      return [
        governance.proposalId,
        ...governance.retrievalProjections.map((projection) => projection.projectionId),
        ...governance.settlementRecords.map((record) => record.settlementRecordId),
        ...governance.continuityProofs.map((proof) => proof.continuityProofId),
        ...governance.decisionRecords.map((record) => record.decisionRecordId),
      ]
    }
    default:
      return []
  }
}

function artifactIdsFromValue(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return []
  }
  return Object.entries(value).flatMap(([key, entry]) => key.endsWith("Id") && typeof entry === "string" ? [entry] : [])
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function chineseNumber(value: number): string {
  const numbers = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
  return numbers[value] ?? String(value)
}
