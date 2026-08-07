import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
} from "@worldseed/contracts"

import {
  emergencePlanningArtifactSchema,
  graphGovernanceArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

import type {
  AIModelPort,
  PhaseModelExecution,
  TurnPhaseInput,
} from "../../application/index.js"

export class FakeAiModelAdapter implements AIModelPort {
  public readonly info = {
    provider: "fake",
    model: "deterministic-contract-fixture",
    available: true,
    contextWindowTokens: 64_000,
  } as const

  public execute(request: PhaseRequestEnvelope): Promise<PhaseModelExecution> {
    const startedAt = Date.now()
    const input = request.input as TurnPhaseInput
    const artifact = this.createArtifact(request.phase, input)
    const result: PhaseResultEnvelope = {
      schemaVersion: 1,
      envelopeId: request.envelopeId,
      contextId: request.contextId,
      phase: request.phase,
      outcome: request.phase === "commit_review" ? "approve" : "continue",
      artifact,
      requestedReads: [],
      citedReadIds: [...request.committedReadIds],
      producedArtifactIds: [],
      decisionRecordIds: [],
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
        provider: this.info.provider,
        model: this.info.model,
      },
    })
  }

  private createArtifact(phase: AIPhase, input: TurnPhaseInput): unknown {
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
          selectedWorkspacePaths: input.readEvidence.map((evidence) => evidence.ownerId),
          selectionReasons: { base: "The platform base rules are mandatory" },
          unresolvedRuleConflicts: [],
        }
      case "source_retrieval":
        return { missingEvidence: [], nextExpansionHints: [] }
      case "emergence_planning":
        return {
          decisions: [{
            pressureEvidenceRefs: [],
            action: "create_new",
            existingAnchorRefs: [],
            timeAnchorRefs: [],
            locationAnchorRefs: [],
            informationBoundaryRefs: [],
            reason: "The first turn requires a minimal time, place, and occurrence structure",
          }],
        }
      case "emergence_review":
        return {
          approvedDecisionIndexes: input.artifacts.emergence_planning === undefined ? [] : [0],
          revisionRequests: [],
          identityRecallComplete: true,
          temporalEntryComplete: true,
          spatialEntryComplete: true,
          informationBoundaryComplete: true,
        }
      case "draft":
        return {
          contentMarkdown: [
            "最初没有宏大的宣告，只有一处尚未被命名的所在，在某个能够继续向前的时刻安静地显现。",
            input.userInput,
            "变化留下了可以再次返回的痕迹。此后发生的一切，都将从这些已经写下的依据继续生长。",
          ].join("\n\n"),
          adoptedDecisionIndexes: [0],
          currentTimeAnchorRefs: [],
          currentLocationAnchorRefs: [],
          detectedUnplannedContent: [],
        }
      case "chapter_naming":
        return {
          chapterNumberText: `第${chineseNumber(input.chapterSequence)}章`,
          heading: `第${chineseNumber(input.chapterSequence)}章 世界种子`,
          filename: `第${chineseNumber(input.chapterSequence)}章 世界种子.md`,
          continuityEvidenceRefs: [],
        }
      case "dependency_audit":
        return {
          missingDependencies: [],
          unplannedContent: [],
          sceneContinuity: [{
            sceneIndex: 0,
            sceneDescription: "The chapter's initial continuous scene",
            predecessorSceneIndexes: [],
            predecessorSceneRefs: [],
            predecessorRequired: false,
            predecessorReason: "The deterministic fixture starts a new world",
            correspondenceRequired: false,
            correspondenceReason: "The fixture uses one local temporal and spatial reference",
            timeContinuity: "pass",
            locationContinuity: "pass",
            crossReferenceContinuity: "pass",
            reason: "The scene has explicit local time and location anchors",
          }],
          informationBoundary: "pass",
        }
      case "response_review":
        return {
          evidenceClosed: true,
          leaksUnobservedInformation: false,
          requiresWorkflowUpgrade: false,
        }
      case "graph_governance":
        return this.createGraphGovernanceArtifact(input)
      case "semantic_review": {
        const governance = graphGovernanceArtifactSchema.parse(input.artifacts.graph_governance)
        const observedReadRefs = input.readEvidence.slice(0, 1).map((evidence) => evidence.readId)
        return {
          approvedMutationIndexes: governance.mutations.map((_, index) => index),
          rejectedMutationIndexes: [],
          approvedSpacetimeBindingIndexes: governance.sceneSpacetimeBindings.map((_, index) => index),
          rejectedSpacetimeBindingIndexes: [],
          approvedMutationSpacetimeSettlementIndexes: governance.mutationSpacetimeSettlements.map((_, index) => index),
          rejectedMutationSpacetimeSettlementIndexes: [],
          approvedAffectedFrontierRefs: governance.affectedFrontierRefs,
          rejectedAffectedFrontierRefs: [],
          verificationProbes: [
            {
              purpose: "scene_restore",
              sceneBindingIndexes: [0],
              mutationSpacetimeSettlementIndexes: [],
              query: "Restore the current scene from its local spacetime anchors",
              observedReadRefs,
              observedGraphRefs: ["local:occurrence"],
              verdict: "pass",
              reason: "The occurrence reaches both its time and location anchors",
            },
            {
              purpose: "source_return",
              sceneBindingIndexes: [0],
              mutationSpacetimeSettlementIndexes: [],
              query: "Return from the scene to its chapter source units",
              observedReadRefs,
              observedGraphRefs: ["local:occurrence"],
              verdict: "pass",
              reason: "Every source unit settles through the occurrence anchor",
            },
            {
              purpose: "current_state",
              sceneBindingIndexes: [],
              mutationSpacetimeSettlementIndexes: [0],
              query: "Recover the current result of the initial graph changes",
              observedReadRefs,
              observedGraphRefs: ["local:occurrence"],
              verdict: "pass",
              reason: "The initial occurrence is the current entry for each change",
            },
            {
              purpose: "history_return",
              sceneBindingIndexes: [],
              mutationSpacetimeSettlementIndexes: [0],
              query: "Return from each graph revision to the originating occurrence",
              observedReadRefs,
              observedGraphRefs: ["local:occurrence"],
              verdict: "pass",
              reason: "The initial occurrence preserves the historical return path",
            },
          ],
          sceneInventoryComplete: true,
          graphStillDiscoverable: true,
          graphStillConcise: true,
          continuityPreserved: true,
          spacetimeContinuityPreserved: true,
        }
      }
      case "settlement_review":
        return {
          settledSourceUnitIndexes: input.sourceUnitIds.map((_, index) => index),
          uncoveredSourceUnitIndexes: [],
          sourceReturnComplete: true,
          retrievalProjectionComplete: true,
          semanticCoverageComplete: true,
          spacetimeBindingsComplete: true,
          mutationSpacetimeSettlementsComplete: true,
        }
      case "frontier_settlement":
        return {
          frontiers: [{
            frontierAnchorRef: "local:occurrence",
            disposition: "active",
            lastSceneAnchorRefs: ["local:occurrence"],
            lastTimeAnchorRefs: ["local:time"],
            lastLocationAnchorRefs: ["local:location"],
            correspondenceRefs: [],
            reason: "The initial occurrence remains available for future evolution",
            revisitCondition: "Revisit when later input or world pressure refers to this local branch",
          }],
        }
      case "commit_review":
        return {
          recommendation: "commit",
          finalSelfReview: "All required Fake AI phase artifacts are present and the settlement is complete",
        }
    }
  }

  private createGraphGovernanceArtifact(input: TurnPhaseInput): GraphGovernanceArtifact {
    if (input.sourceId === undefined) throw new Error("Graph governance requires a persisted source")
    const planning = emergencePlanningArtifactSchema.parse(input.artifacts.emergence_planning)
    if (planning.decisions[0] === undefined) throw new Error("Graph governance requires an emergence decision")
    const mutations: GraphGovernanceArtifact["mutations"] = [
      {
        operation: "create_node",
        ref: "local:occurrence",
        data: {
          content: {
            text: input.userInput,
            timeRef: "local:time",
            locationRef: "local:location",
          },
        },
      },
      { operation: "create_node", ref: "local:time", data: { content: { anchor: "initial world time" } } },
      { operation: "create_node", ref: "local:location", data: { content: { anchor: "initial scene location" } } },
      { operation: "create_link", ref: "local:time-link", fromRef: "local:occurrence", toRef: "local:time", content: { note: "time entry" } },
      { operation: "create_link", ref: "local:location-link", fromRef: "local:occurrence", toRef: "local:location", content: { note: "space entry" } },
    ]
    return {
      mutations,
      retrievalProjections: [{
        ownerKind: "node",
        ownerMutationIndex: 0,
        exactKeys: [input.userInput, `第${chineseNumber(input.chapterSequence)}章 世界种子`],
        semanticText: `Initial chapter occurrence: ${input.userInput}`,
      }],
      settlementRecords: input.sourceUnitIds.map((_, sourceUnitIndex) => ({
        sourceUnitIndex,
        graphRefs: [{ targetKind: "node", targetRef: "local:occurrence", mutationIndex: 0 }],
        reason: "The source unit returns through the chapter occurrence anchor",
        status: "settled",
      })),
      mutationSpacetimeSettlements: [{
        mutationIndexes: mutations.map((_, index) => index),
        effectDisposition: "world_effect",
        effectiveSceneBindingIndexes: [0],
        effectiveExistingSceneAnchorRefs: [],
        currentEntryRefs: ["local:occurrence"],
        predecessorRevisionRequired: false,
        predecessorRevisionReadRefs: [],
        historicalReturnRefs: ["local:occurrence"],
        reason: "Every initial mutation becomes effective in the chapter's only scene",
        selfReview: "The settlement uses no system timestamp as world time",
      }],
      sceneSpacetimeBindings: [{
        sceneIndex: 0,
        sceneAnchorRef: "local:occurrence",
        sourceUnitIndexes: input.sourceUnitIds.map((_, index) => index),
        temporalReferenceRefs: ["local:time"],
        timeAnchorRefs: ["local:time"],
        spatialReferenceRefs: ["local:location"],
        locationAnchorRefs: ["local:location"],
        predecessorSceneIndexes: [],
        predecessorSceneAnchorRefs: [],
        transitionPathRefs: [],
        correspondenceRefs: [],
        explanation: "The occurrence, time, and location nodes form the initial scene binding",
        selfReview: "The binding covers every source unit without inventing a domain schema",
      }],
      affectedFrontierRefs: ["local:occurrence"],
      archiveOutletRefs: [],
      decisionRecords: [{
        decisionKind: "initial_graph_governance",
        mutationIndexes: mutations.map((_, index) => index),
        mutationSpacetimeSettlementIndexes: [0],
        reason: "Create the smallest reusable graph that can return to every source unit",
        payload: { proposalKind: "initial_turn" },
        selfReview: "The proposal reuses the approved time and place anchors and adds no domain-specific schema",
      }],
    }
  }
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function chineseNumber(value: number): string {
  const numbers = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
  return numbers[value] ?? String(value)
}
