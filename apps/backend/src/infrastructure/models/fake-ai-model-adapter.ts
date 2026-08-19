import { randomUUID } from "node:crypto"

import {
  ModelContextAppender,
  type AIModelPort,
  type ModelExecutionOptions,
  type PhaseModelExecution,
  type TurnPhaseInput,
} from "../../application/index.js"
import type {
  AIPhase,
  PhaseRequestEnvelope,
  PhaseResultEnvelope,
} from "@worldseed/contracts"

import {
  dependencyAuditArtifactSchema,
  graphGovernanceArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

export class FakeAiModelAdapter implements AIModelPort {
  public readonly info = {
    provider: "fake",
    model: "deterministic-contract-fixture",
    available: true,
    contextWindowTokens: 64_000,
  } as const
  private readonly contextAppender = new ModelContextAppender()

  public constructor(private readonly createId: () => string = randomUUID) {}

  public execute(request: PhaseRequestEnvelope, options?: ModelExecutionOptions): Promise<PhaseModelExecution> {
    if (options?.signal?.aborted) return Promise.reject(executionCancellationReason(options.signal))
    const startedAt = Date.now()
    const input = request.input as TurnPhaseInput
    const artifact = this.createArtifact(request.phase, input)
    const requestedReads = (request.phase === "semantic_review" || request.phase === "graph_governance_review")
      && (input.verificationProbeExecutions?.length ?? 0) === 0
      ? this.createVerificationProbeReads(input)
      : []
    const result: PhaseResultEnvelope = {
      schemaVersion: 1,
      envelopeId: request.envelopeId,
      contextId: request.contextId,
      phase: request.phase,
      outcome: requestedReads.length > 0 ? "request_read" : request.phase === "commit_review" ? "approve" : "continue",
      artifact,
      requestedReads,
      citedReadIds: [...request.committedReadIds],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: `Fake AI completed ${request.phase} using only the supplied turn state`,
      selfReview: "The result contains no hidden reasoning and cites no unreturned reads",
    }
    const inputTokens = estimateTokens(request)
    const outputTokens = estimateTokens(result)
    const modelRequest = this.contextAppender.createDelta(request, request, options?.contextMessages ?? [])
    return Promise.resolve({
      result,
      contextExchange: {
        requestMessages: [{
          role: "user",
          kind: "phase_request",
          taskId: request.taskId,
          turnId: request.turnId,
          phase: request.phase,
          content: this.contextAppender.formatDelta(modelRequest),
        }],
        responseMessage: {
          role: "assistant",
          kind: "phase_response",
          taskId: request.taskId,
          turnId: request.turnId,
          phase: request.phase,
          content: JSON.stringify(result),
        },
      },
      usage: {
        inputTokens,
        lastRequestInputTokens: inputTokens,
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
          workflow: input.workflow,
          userIntent: input.userInput,
          worldIntent: input.userInput,
          presentationIntent: "Use the selected project presentation rules",
          userClaims: [{ text: input.userInput, treatment: "proposal", truthStatus: "current_turn_new" }],
          requiredTimeAnchor: true,
          requiredLocationAnchor: true,
          initialReadHypotheses: [],
        }
      case "rule_assembly":
        {
          const selectedWorkspacePaths = [...new Set(input.readEvidence
            .filter((evidence) => evidence.ownerKind.startsWith("workspace:"))
            .map((evidence) => evidence.ownerId))]
          return {
            selectedWorkspacePaths,
            selectionReasons: Object.fromEntries(selectedWorkspacePaths.map((path) => [
              path,
              "The workspace source was read and applies to this turn",
            ])),
            unresolvedRuleConflicts: [],
          }
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
          approvedDecisionIndexes: phaseArtifacts(input).emergence_planning === undefined ? [] : [0],
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
          temporalClaims: input.workflow === "turn" ? [{
            claimRef: "claim:scene:1",
            sceneIndex: 0,
            sourceUnitIndexes: input.sourceUnitIds.length === 0 ? [] : [0],
            proseExcerpt: "此后发生的一切，都将从这些已经写下的依据继续生长。",
            referenceDescription: "相对于本章当前场景已经发生的变化",
            referenceRefs: [],
            evidenceRefs: input.readEvidence.slice(0, 1).map((evidence) => evidence.readId),
            timelineRefs: [],
            relationDescription: "此后指向当前场景变化之后的开放未来",
            verdict: "pass",
            reason: "该表达只依赖本章场景内部的先后关系",
            missingEvidence: [],
          }] : [],
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
      case "graph_structure_plan": {
        const governance = this.createGraphGovernanceArtifact(input)
        return {
          proposals: governance.mutations.map((mutation, index) => ({
            proposalRef: `proposal:mutation:${String(index + 1)}`,
            mutation,
            reason: "The deterministic fixture proposes one minimal graph change",
            selfReview: "The proposal introduces no fixed domain schema",
          })),
          affectedFrontierRefs: governance.affectedFrontierRefs,
          archiveOutletRefs: governance.archiveOutletRefs,
          decisionRecords: [{
            decisionKind: "initial_graph_structure",
            proposalRefs: governance.mutations.map((_, index) => `proposal:mutation:${String(index + 1)}`),
            reason: "Create the minimum connected structure for the generated world",
            payload: {},
            selfReview: "Every proposal remains reusable by later staged phases",
          }],
        }
      }
      case "graph_capacity_rewrite":
        return {
          hotspotRefs: input.graphCapacity?.candidateAssessment?.violations.map((violation) => violation.nodeId) ?? ["local:occurrence"],
          affectedProposalRefs: ["proposal:mutation:1"],
          removeProposalRefs: [],
          upsertProposals: [],
          reason: "The deterministic fixture requires no semantic capacity rewrite",
          selfReview: "No proposal is changed outside the declared local scope",
        }
      case "graph_spacetime_settlement": {
        const governance = this.createGraphGovernanceArtifact(input)
        const dependency = dependencyAuditArtifactSchema.parse(phaseArtifacts(input).dependency_audit)
        return {
          sceneSpacetimeBindings: governance.sceneSpacetimeBindings,
          proposalSettlements: governance.mutationSpacetimeSettlements.map((settlement) => ({
            effectDisposition: settlement.effectDisposition,
            effectiveSceneBindingIndexes: settlement.effectiveSceneBindingIndexes,
            effectiveExistingSceneAnchorRefs: settlement.effectiveExistingSceneAnchorRefs,
            currentEntryRefs: settlement.currentEntryRefs,
            predecessorRevisionRequired: settlement.predecessorRevisionRequired,
            predecessorRevisionReadRefs: settlement.predecessorRevisionReadRefs,
            historicalReturnRefs: settlement.historicalReturnRefs,
            reason: settlement.reason,
            selfReview: settlement.selfReview,
            proposalRefs: settlement.mutationIndexes.map((index) => `proposal:mutation:${String(index + 1)}`),
          })),
          temporalClaimSettlements: dependency.temporalClaims.map((claim) => ({
            claimRef: claim.claimRef,
            sceneIndex: claim.sceneIndex,
            referenceRefs: ["local:occurrence"],
            timeAnchorRefs: ["local:time"],
            timelineRefs: ["local:time"],
            correspondenceRefs: [],
            historicalReturnRefs: ["local:occurrence"],
            confidence: "certain" as const,
            explanation: "The deterministic claim is bound to the generated scene and time entry",
            selfReview: "The fixture does not infer an unavailable numeric duration",
          })),
        }
      }
      case "graph_retrieval_design": {
        const governance = this.createGraphGovernanceArtifact(input)
        return {
          projections: governance.retrievalProjections.map((projection) => ({
            ...(projection.ownerMutationIndex === undefined
              ? {}
              : { ownerProposalRef: `proposal:mutation:${String(projection.ownerMutationIndex + 1)}` }),
            ...(projection.ownerRef === undefined ? {} : { ownerRef: projection.ownerRef }),
            exactKeys: projection.exactKeys,
            semanticText: projection.semanticText,
          })),
          sourceSettlements: governance.settlementRecords.map((record) => ({
            ...record,
            graphRefs: record.graphRefs.map((reference) => ({
              targetKind: reference.targetKind,
              targetRef: reference.targetRef,
              ...(reference.mutationIndex === undefined
                ? {}
                : { proposalRef: `proposal:mutation:${String(reference.mutationIndex + 1)}` }),
            })),
          })),
        }
      }
      case "graph_governance_review": {
        const dependency = dependencyAuditArtifactSchema.parse(phaseArtifacts(input).dependency_audit)
        return {
          recommendation: "pass",
          issues: [],
          graphStillDiscoverable: true,
          graphStillConcise: true,
          continuityPreserved: true,
          spacetimeContinuityPreserved: true,
          sourceReturnComplete: true,
          verificationProbeAssessments: (input.verificationProbeExecutions ?? []).map((execution) => ({
            probeIndex: execution.probeIndex,
            verdict: execution.returnedReadRefs.length > 0
              || execution.returnedGraphRefs.length > 0
              || execution.returnedProposalRefs.length > 0
              ? "pass" as const
              : "uncertain" as const,
            reason: "The application-executed staged governance probe was assessed",
          })),
          temporalClaimAssessments: dependency.temporalClaims.map((claim) => ({
            claimRef: claim.claimRef,
            evidenceSufficient: true,
            verdict: "pass" as const,
            narrativeContext: "The prose describes a direct within-scene temporal relation",
            evidenceRefs: claim.evidenceRefs,
            responsibility: "spacetime" as const,
            reason: "The claim is bound to the current scene and generated time entry",
          })),
          selfReview: "The staged deterministic graph is complete and selectively discoverable",
        }
      }
      case "semantic_review": {
        const governance = graphGovernanceArtifactSchema.parse(phaseArtifacts(input).graph_governance)
        return {
          approvedMutationIndexes: governance.mutations.map((_, index) => index),
          rejectedMutationIndexes: [],
          approvedSpacetimeBindingIndexes: governance.sceneSpacetimeBindings.map((_, index) => index),
          rejectedSpacetimeBindingIndexes: [],
          approvedMutationSpacetimeSettlementIndexes: governance.mutationSpacetimeSettlements.map((_, index) => index),
          rejectedMutationSpacetimeSettlementIndexes: [],
          approvedAffectedFrontierRefs: governance.affectedFrontierRefs,
          rejectedAffectedFrontierRefs: [],
          verificationProbeAssessments: (input.verificationProbeExecutions ?? []).map((execution) => ({
            probeIndex: execution.probeIndex,
            verdict: execution.returnedReadRefs.length > 0
              || execution.returnedGraphRefs.length > 0
              || execution.returnedProposalRefs.length > 0
              ? "pass" as const
              : "uncertain" as const,
            reason: execution.returnedReadRefs.length > 0
              || execution.returnedGraphRefs.length > 0
              || execution.returnedProposalRefs.length > 0
              ? "The application-executed query returned evidence"
              : "The application-executed query returned no existing evidence for this new world structure",
          })),
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
      case "commit_review": {
        const dependency = dependencyAuditArtifactSchema.parse(phaseArtifacts(input).dependency_audit)
        return {
          recommendation: "commit",
          continuityAdvice: dependency.temporalClaims.map((claim) => ({
            claimRef: claim.claimRef,
            proseExcerpt: claim.proseExcerpt,
            verdict: "pass" as const,
            summary: "The deterministic temporal expression is consistent with its current scene reference",
            evidenceRefs: claim.evidenceRefs,
          })),
          finalSelfReview: "All required Fake AI phase artifacts are present and the settlement is complete",
        }
      }
    }
  }

  private createVerificationProbeReads(input: TurnPhaseInput): PhaseResultEnvelope["requestedReads"] {
    const probes = [
      { purpose: "scene_restore" as const, sceneBindingIndexes: [0], mutationSpacetimeSettlementIndexes: [] },
      { purpose: "source_return" as const, sceneBindingIndexes: [0], mutationSpacetimeSettlementIndexes: [] },
      { purpose: "current_state" as const, sceneBindingIndexes: [], mutationSpacetimeSettlementIndexes: [0] },
      { purpose: "history_return" as const, sceneBindingIndexes: [], mutationSpacetimeSettlementIndexes: [0] },
    ]
    return probes.map((verificationProbe) => ({
      requestId: this.createId(),
      reason: `Execute ${verificationProbe.purpose} against the persisted local world view`,
      expectedEvidence: `Evidence for ${verificationProbe.purpose}`,
      query: {
        exactKeys: [input.userInput],
        semanticTexts: [input.userInput],
        anchorIds: verificationProbe.purpose === "source_return" ? [] : ["local:occurrence"],
        directions: ["both"],
        maxCandidates: 8,
        maxDepth: 2,
        sourceKinds: ["graph", "revision", "source"],
      },
      verificationProbe,
    }))
  }

  private createGraphGovernanceArtifact(input: TurnPhaseInput): GraphGovernanceArtifact {
    if (input.sourceId === undefined) throw new Error("Graph governance requires a persisted source")
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

function phaseArtifacts(input: TurnPhaseInput): Partial<Record<AIPhase, unknown>> {
  return input.validationArtifacts ?? input.artifacts
}

function executionCancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Model execution cancelled")
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
}

function chineseNumber(value: number): string {
  const numbers = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
  return numbers[value] ?? String(value)
}
