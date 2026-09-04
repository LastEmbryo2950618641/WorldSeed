import { randomUUID } from "node:crypto"

import {
  ModelContextAppender,
  type AIModelPort,
  type ModelExecutionOptions,
  type PhaseModelExecution,
  type TurnPhaseInput,
} from "../../application/index.js"
import { formatChapterSequenceLabel } from "../../core/index.js"
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
    const synopsisReads = request.phase === "synopsis_discuss"
      ? this.createSynopsisBootstrapReads(input)
      : []
    const requestedReads = synopsisReads.length > 0
      ? synopsisReads
      : (request.phase === "semantic_review" || request.phase === "graph_governance_review")
        && (input.verificationProbeExecutions?.length ?? 0) === 0
        ? this.createVerificationProbeReads(input)
        : []
    const artifact = requestedReads.length > 0 ? undefined : this.createArtifact(request.phase, input)
    const result: PhaseResultEnvelope = {
      schemaVersion: 1,
      envelopeId: request.envelopeId,
      contextId: request.contextId,
      phase: request.phase,
      outcome: requestedReads.length > 0 ? "request_read" : request.phase === "commit_review" ? "approve" : "continue",
      ...(artifact === undefined ? {} : { artifact }),
      requestedReads,
      citedReadIds: [...request.committedReadIds],
      producedArtifactIds: [],
      decisionRecordIds: [],
      unresolvedDependencies: [],
      reason: requestedReads.length > 0
        ? `Fake AI requested reads for ${request.phase}`
        : `Fake AI completed ${request.phase} using only the supplied turn state`,
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
          volumeFolderName: "第一卷 世界种子",
          continuityEvidenceRefs: [],
        }
      case "work_naming": {
        const current = typeof input.workNaming?.currentDisplayName === "string"
          ? input.workNaming.currentDisplayName.trim()
          : "新建作品"
        const avoid = new Set((input.workNaming?.avoidNames ?? []).map((entry) => entry.trim()))
        const seed = input.workNaming?.volumeNames?.[0]
          ?? input.workNaming?.chapterHeadings?.[0]
          ?? "潮声纪"
        let displayName = seed.slice(0, 200)
        if (displayName === current || avoid.has(displayName) || displayName.length === 0) {
          displayName = `${seed}录`.slice(0, 200)
        }
        if (displayName === current || avoid.has(displayName)) {
          displayName = `新${seed}`.slice(0, 200)
        }
        return {
          displayName,
          alternatives: [`${displayName}外传`, `${displayName}前传`].filter((entry) => entry !== displayName).slice(0, 5),
          finalSelfReview: "The deterministic fixture returns a fresh work title distinct from the current name.",
        }
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
      case "settings_extraction":
        if (process.env.WORLDSEED_FAKE_SETTINGS_EXTRACTION?.trim() === "1") {
          return {
            summary: "The acceptance fixture proposes one settings file for DOM review.",
            proposals: [{
              payload: {
                kind: "create",
                relativePath: "设定集/人物/验收旅人.md",
                markdown: "# 验收旅人\n\n> 适用范围：DOM 回归测试\n\n## 身份摘要\n旧站台尽头的无名持灯者。\n",
                readmeEntry: "`设定集/人物/验收旅人.md` · 验收旅人 · DOM",
              },
              reason: "正文首次出现该人物，适合沉淀为设定。",
            }],
            finalSelfReview: "One create proposal is emitted for settings extraction review.",
          }
        }
        return {
          summary: "The deterministic fixture found no new settings to persist for this turn.",
          proposals: [],
          finalSelfReview: "No settings proposals were required for the fixture chapter.",
        }
      case "response_review":
        return {
          evidenceClosed: true,
          leaksUnobservedInformation: false,
          requiresWorkflowUpgrade: false,
        }
      case "revision_review":
        return {
          issues: [],
          recommendation: "no_issue",
          finalSelfReview: "The proposed revision was checked for continuity using only the supplied revision context.",
        }
      case "revision_assist":
        return this.createRevisionAssistArtifact(input)
      case "synopsis_discuss":
        return this.createSynopsisDiscussArtifact(input)
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
        const goalCompliance = (input.deductionGoalBundle?.activeGoals ?? []).map((goal) => {
          const progress = input.deductionGoalBundle?.chapterProgress.find((item) => item.goalId === goal.goalId)
          return {
            goalId: goal.goalId,
            verdict: "satisfied" as const,
            reason: progress === undefined
              ? "No chapter progress was locked; treated as unconstrained for this fixture"
              : `Fixture treats locked progress「${progress.summary}」as satisfied`,
          }
        })
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
          ...(goalCompliance.length === 0 ? {} : { goalCompliance }),
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

  private createSynopsisBootstrapReads(input: TurnPhaseInput): PhaseResultEnvelope["requestedReads"] {
    const hasSettingsCatalog = (input.workspaceCatalog?.entries ?? [])
      .some((entry) => entry.entryKind === "file" && entry.role === "settings")
    if (!hasSettingsCatalog) return []
    const alreadyReadSettings = input.readEvidence.some((item) => item.ownerKind === "workspace:settings")
    if (alreadyReadSettings) return []
    return [{
      requestId: this.createId(),
      reason: "Read the settings index before drafting the chapter synopsis",
      expectedEvidence: "设定集索引与目录说明",
      query: {
        exactKeys: ["设定集/readme.md"],
        semanticTexts: ["设定集索引"],
        anchorIds: [],
        directions: ["both"],
        maxCandidates: 4,
        maxDepth: 1,
        sourceKinds: ["reference"],
      },
    }]
  }

  private createGraphGovernanceArtifact(input: TurnPhaseInput): GraphGovernanceArtifact {
    if (input.sourceId === undefined) throw new Error("Graph governance requires a persisted source")
    const isRevision = input.workflow === "revision"
    const requestedMode = input.userInput.includes("[no-change]")
      ? "no_change" as const
      : input.userInput.includes("[full-governance]")
        ? "full_governance" as const
        : isRevision
          ? "local_governance" as const
          : "full_governance" as const
    if (requestedMode === "no_change") {
      return {
        executionMode: requestedMode,
        mutations: [],
        retrievalProjections: [],
        settlementRecords: [],
        mutationSpacetimeSettlements: [],
        sceneSpacetimeBindings: [],
        affectedFrontierRefs: [],
        archiveOutletRefs: [],
        decisionRecords: [],
      }
    }
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
      executionMode: requestedMode,
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
      affectedFrontierRefs: isRevision ? [] : ["local:occurrence"],
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

  private createRevisionAssistArtifact(input: TurnPhaseInput): {
    assistantMessage: string
    proposedHeading?: string
    proposedBody: string
    finalSelfReview: string
  } {
    const assist = input.revisionAssist
    const userMessage = input.userInput.trim()
    const heading = assist?.heading ?? "未命名章节"
    const workingBody = assist?.workingBody ?? assist?.committedBody ?? ""
    const countChars = (text: string): number => text.replace(/\s+/gu, "").length
    const currentCount = countChars(workingBody)

    if (/2000|字数|太短|扩充|扩写|加长/u.test(userMessage)) {
      const target = Number.parseInt(userMessage.match(/(\d{3,5})/u)?.[1] ?? "2000", 10)
      const safeTarget = Number.isFinite(target) ? target : 2000
      const expansion = buildExpansionParagraphs(Math.max(200, safeTarget - currentCount), userMessage)
      const proposedBody = `${workingBody.trim()}\n\n${expansion}`.trim()
      const nextCount = countChars(proposedBody)
      return {
        assistantMessage: `我已把正文从约 ${String(currentCount)} 字扩展到约 ${String(nextCount)} 字，补充了场景细节、人物动作与环境描写。请预览修订建议，满意后再点击「应用到修订稿」。`,
        proposedHeading: heading,
        proposedBody,
        finalSelfReview: "Expanded the chapter body toward the requested length without replacing unrelated paragraphs.",
      }
    }

    if (/悬疑|悬念|紧张|惊悚/u.test(userMessage)) {
      const paragraphs = workingBody.trim().split(/\n{2,}/u).filter((part) => part.length > 0)
      const suspenseLead = "风先停了一瞬，像是有人在暗处屏住了呼吸。旅人还没看清那盏灯，就先听见了比雨更轻、却更靠近的脚步。"
      const proposedBody = [suspenseLead, ...paragraphs.slice(1)].join("\n\n")
      return {
        assistantMessage: "我重写了开头，把悬疑感前置：先写异常氛围与未现身的威胁，再接入原有情节。若方向合适，可应用到修订稿继续微调。",
        proposedHeading: heading,
        proposedBody,
        finalSelfReview: "Rewrote the opening for suspense while preserving the remaining committed paragraphs.",
      }
    }

    const addition = `（按你的要求「${userMessage.slice(0, 48)}${userMessage.length > 48 ? "…" : ""}」补充：这里展开了相关情节，并与上文自然衔接。）`
    const proposedBody = `${workingBody.trim()}\n\n${addition}`.trim()
    return {
      assistantMessage: `我根据「${userMessage.slice(0, 40)}${userMessage.length > 40 ? "…" : ""}」在工作稿末尾增补了一段，并保留原有正文。请查看修订建议后决定是否应用。`,
      proposedHeading: heading,
      proposedBody,
      finalSelfReview: "Appended a targeted paragraph responding to the latest user instruction.",
    }
  }

  private createSynopsisDiscussArtifact(input: TurnPhaseInput): {
    assistantMessage: string
    chapterTitle?: string
    workDisplayName?: string
    synopsisBody?: string
    choices?: Array<{
      label: string
      action: "start_turn" | "continue_discuss" | "promote_staging" | "confirm_arc_plan" | "confirm_synopsis"
    }>
    goalProposals?: Array<{ payload: { kind: string; [key: string]: unknown }; reason?: string }>
    outlineBody?: string
    bodyEdits?: {
      target: "outline"
      baseDigest?: string
      ops: Array<{ oldText: string; newText: string }>
    }
    stagingDelta?: {
      notes?: Array<{
        entryId?: string
        title: string
        body: string
        promoteTargetPath?: string
        status?: "open" | "pending_promote" | "settled"
      }>
      promoteHints?: Array<{
        entryId?: string
        title: string
        body: string
        promoteTargetPath?: string
        status?: "open" | "pending_promote" | "settled"
      }>
    }
    stagingPromote?: {
      settingsWrites: Array<{
        entryId: string
        relativePath: string
        markdown: string
        readmeEntry?: string
        mode: "create" | "update"
      }>
      goalProposals?: Array<{ payload: { kind: string; [key: string]: unknown }; reason?: string }>
      reason?: string
    }
    arcPlan?: {
      markdown: string
      estimatedChapterCount?: number
      estimatedWordRange?: string
    }
    finalSelfReview: string
  } {
    const discuss = input.synopsisDiscuss
    const userMessage = input.userInput.trim()
    const wantsRefreshChoices = /换一批决策选项|静默刷新/u.test(userMessage)
    const wantsPromote = !wantsRefreshChoices && /确认落盘|落盘到设定集|把草案写入设定集/u.test(userMessage)
    const wantsArcPlan = !wantsRefreshChoices && /先落大纲|弧线规划|分几章|多章/u.test(userMessage)
    const isHandoff = discuss?.discussTrigger === "turn_handoff"
    const chapterSequence = discuss?.chapterSequence ?? 1
    const chapterLabel = formatChapterSequenceLabel(chapterSequence)
    const heading = discuss?.heading ?? chapterLabel
    const chapterTitle = heading.replace(/^第(?:\d+|[零一二三四五六七八九十百]+)章(?:\s+)?/u, "").trim() || "世界种子"
    const existing = discuss?.synopsisMarkdown.trim() ?? ""
    const synopsisHeading = `${chapterLabel} ${chapterTitle}`
    const settingsIndexEvidence = input.readEvidence.find((item) => (
      item.ownerKind === "workspace:settings"
      && item.ownerId.toLocaleLowerCase().includes("readme")
    ))
    const synopsisBody = existing.length > 0
      ? `${existing.trim()}\n\n- ${userMessage.slice(0, 120)}${userMessage.length > 120 ? "…" : ""}`
      : `# ${synopsisHeading} 剧情梗概\n\n${userMessage}\n\n（Agent 已根据讨论整理梗概要点。）`
    const activeGoals = discuss?.activeGoals?.filter((goal) => goal.lifecycle === "active") ?? []
    const goalProposals = activeGoals.length === 0
      ? [{
          payload: {
            kind: "create" as const,
            content: `推进：${userMessage.slice(0, 80)}${userMessage.length > 80 ? "…" : ""}`,
          },
          reason: "根据讨论建议新增推演目标",
        }]
      : activeGoals.slice(0, 1).map((goal) => ({
          payload: {
            kind: "set_chapter_progress" as const,
            goalId: goal.goalId,
            chapterSequence,
            summary: `本章围绕「${userMessage.slice(0, 60)}${userMessage.length > 60 ? "…" : ""}」推进该目标`,
          },
          reason: "根据讨论建议本章 planned 进展",
        }))
    const wantsRename = /作品名|书名|改名|起名|换个(?:作品)?名/u.test(userMessage)
    const currentWorkName = discuss?.currentWorkDisplayName?.trim() || "新建作品"
    const shouldNameWork = wantsRename || currentWorkName === "新建作品"
    const workDisplayName = shouldNameWork
      ? (chapterTitle === "世界种子" ? "潮声纪" : chapterTitle.slice(0, 200))
      : undefined
    const synopsisConfirmed = discuss?.synopsisConfirmed === true
      || /用这份梗概写细纲|确认(?:本章)?梗概|开始写细纲/u.test(userMessage)
    const existingOutline = discuss?.outlineMarkdown?.trim() ?? ""
    const hasExistingOutline = existingOutline.length > 0
    const wantsFullOutlineRewrite = /整篇重写细纲|重写整份细纲|全量重写细纲/u.test(userMessage)
    const useBodyEdits = synopsisConfirmed
      && hasExistingOutline
      && !wantsFullOutlineRewrite
      && !wantsPromote
      && !isHandoff
      && !wantsArcPlan
    const outlineAnchor = "### 场 2 推进"
    const outlineBody = [
      `# ${synopsisHeading}（剧情细纲）`,
      "",
      "## 章定位",
      "承接上一章余波；本章必须改变主角对局势的判断；结束时留下可推进的行动线索。推演从本章落点写起，不重述梗概场景链。",
      "",
      "## 人物与关系",
      `- 主角：沿用既有性格；围绕「${userMessage.slice(0, 40)}」的选择须体现其动机与恐惧，台词不可与配角互换。`,
      "",
      "## 格局",
      "本节：无外部势力；当场力量=谁掌握关键信息/承诺即可推进。",
      "",
      "## 分场节拍",
      "### 场 1 开场",
      "地点：关键场景；在场：主角；张力：处境压力；信息进出：只揭示必要边界；场末：被迫表态。",
      "### 场 2 推进",
      "地点：冲突升级处；在场：对立方；张力：利益碰撞；信息进出：放出一条可控情报；场末：代价显现。",
      "### 场 3 落点",
      "地点：收束场；在场：核心人物；张力：选择落地；信息进出：守住未可揭示部分；场末：通向下一章。",
      "",
      "## 信息边界",
      "可揭示：局面压力与人物选择；不可揭示：最终真相与远期伏笔答案。",
      "",
      "## 与推演目标",
      "本章无已登记目标则不新造高潮/伏笔账；有 activeGoals 时仅引用其 goalId。",
      "",
      "## 风险与待决",
      "若用户未确认设定写入，人物档案仍以暂存为准。",
    ].join("\n")
    const bodyEdits = useBodyEdits
      ? {
          target: "outline" as const,
          ...(discuss?.outlineDigest === undefined ? {} : { baseDigest: discuss.outlineDigest }),
          ops: [{
            oldText: existingOutline.includes(outlineAnchor)
              ? `${outlineAnchor}\n地点：冲突升级处；在场：对立方；张力：利益碰撞；信息进出：放出一条可控情报；场末：代价显现。`
              : existingOutline.slice(0, Math.min(80, existingOutline.length)),
            newText: existingOutline.includes(outlineAnchor)
              ? `${outlineAnchor}\n地点：冲突升级处；在场：对立方；张力：利益碰撞（按用户要求收紧）；信息进出：放出一条可控情报；场末：代价显现且立场更清晰。`
              : `${existingOutline.slice(0, Math.min(80, existingOutline.length))}（局部修订）`,
          }],
        }
      : undefined
    const stagingEntryId = "staging-note-1"
    return {
      assistantMessage: isHandoff
        ? "已收到推演交接。我已对照正文摘要更新弧大纲与下一章建议，不会自动开始正式推演。"
        : wantsPromote
        ? "我已整理待写入设定草案。请点击「把草案写入设定集」完成写入；推演目标仍会以提案形式等待你二次采纳。"
        : wantsArcPlan
          ? "这段更适合先落弧大纲。我已写入弧线规划，并给出本章目的；完整梗概仍按当前下一章处理。"
        : useBodyEdits
          ? `已按讨论局部更新「${synopsisHeading}」的剧情细纲（未整篇重写）。`
        : synopsisConfirmed
          ? `梗概已确认。我已写入「${synopsisHeading}」的剧情细纲（分场节拍与信息边界），可继续改细纲或开始推演。`
        : discuss?.userEditedSinceAgent === true
          ? "我看到你手工调整过梗概，本轮我只在对话里回应，没有覆盖文件。若需要我重写梗概，请明确说明。"
          : settingsIndexEvidence === undefined
            ? `我已更新「${synopsisHeading}」的剧情梗概。这是定本章方向，不是写入设定集；可选用这份梗概写细纲，或跳过细纲按梗概开推。`
            : `我已对照设定集索引整理「${synopsisHeading}」的剧情梗概。这是定本章方向，不是写入设定集；可选用这份梗概写细纲，或跳过细纲按梗概开推。`,
      ...(discuss?.userEditedSinceAgent === true || wantsPromote || isHandoff || synopsisConfirmed
        ? {}
        : { chapterTitle, synopsisBody }),
      ...(synopsisConfirmed && !wantsPromote && !isHandoff && !wantsArcPlan && !useBodyEdits
        ? { outlineBody }
        : {}),
      ...(bodyEdits === undefined ? {} : { bodyEdits }),
      ...(workDisplayName === undefined || workDisplayName === currentWorkName ? {} : { workDisplayName }),
      choices: wantsPromote
        ? [
            { label: "把草案写入设定集", action: "promote_staging" as const },
            { label: "再修改梗概", action: "continue_discuss" as const },
          ]
        : wantsArcPlan
          ? [
              { label: "已确认弧大纲", action: "confirm_arc_plan" as const },
              { label: "继续改本章梗概", action: "continue_discuss" as const },
            ]
        : isHandoff
          ? [{ label: "继续讨论下一章", action: "continue_discuss" as const }]
          : wantsRefreshChoices
            ? [
              { label: "权谋暗斗：卷入站台派系冲突", action: "continue_discuss" as const },
              { label: "命运偶遇：陌生人递来一把钥匙", action: "continue_discuss" as const },
              { label: "先落一个三章大纲再定基调", action: "confirm_arc_plan" as const },
            ]
          : synopsisConfirmed
            ? [
              { label: "按当前细纲开始正式推演", action: "start_turn" as const },
              { label: "再修改细纲", action: "continue_discuss" as const },
            ]
            : [
              { label: "用这份梗概写细纲", action: "confirm_synopsis" as const },
              { label: "跳过细纲，按梗概开推", action: "start_turn" as const },
              { label: "再修改梗概", action: "continue_discuss" as const },
            ],
      ...(wantsPromote || isHandoff ? {} : { goalProposals }),
      ...(wantsArcPlan || isHandoff
        ? {
            arcPlan: {
              markdown: [
                "# 弧线规划",
                "",
                "## 目标",
                userMessage.slice(0, 200),
                "",
                "## 建议章数",
                "约 2–3 章",
                "",
                "## 章目的",
                `- 第${String(chapterSequence)}章：开篇蓄势`,
                `- 第${String(chapterSequence + 1)}章：行动推进`,
                `- 第${String(chapterSequence + 2)}章：阶段性落点`,
              ].join("\n"),
              estimatedChapterCount: 3,
              estimatedWordRange: "6000-9000",
            },
          }
        : {}),
      stagingDelta: {
        notes: [{
          title: isHandoff ? "推演交接笔记" : "讨论要点",
          body: userMessage.slice(0, 200),
          entryId: stagingEntryId,
        }],
        ...(wantsPromote
          ? {
              promoteHints: [{
                entryId: stagingEntryId,
                title: "讨论要点",
                body: userMessage.slice(0, 200),
                promoteTargetPath: "设定集/讨论沉淀.md",
                status: "pending_promote" as const,
              }],
            }
          : {}),
      },
      ...(wantsPromote
        ? {
            stagingPromote: {
              settingsWrites: [{
                entryId: stagingEntryId,
                relativePath: "设定集/讨论沉淀.md",
                markdown: `# 讨论沉淀\n\n${userMessage.slice(0, 400)}\n`,
                readmeEntry: "讨论沉淀",
                mode: "create" as const,
              }],
              reason: "将讨论确认点写入设定集",
              goalProposals,
            },
          }
        : {}),
      finalSelfReview: useBodyEdits
        ? "Applied local bodyEdits against the existing outline instead of rewriting outlineBody."
        : synopsisConfirmed
        ? "Confirmed synopsis gate passed; returned a structured outlineBody."
        : wantsPromote
        ? "Prepared staging promote proposal for user confirmation; did not write settings yet."
        : isHandoff
          ? "Completed turn handoff analysis without beginTurn."
        : "Returned synopsis-level draft and confirm_synopsis choice without outlineBody.",
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

function buildExpansionParagraphs(minChars: number, userMessage: string): string {
  const seeds = [
    "雨丝在站台铁架上汇成细流，灯光把每一滴水都照成短暂坠落的星。",
    "旅人注意到轨道尽头的阴影里，似乎有人刚刚离开，却来不及留下脚印。",
    "旧广播喇叭偶尔嘶鸣，像是从另一个年代借来的回声，提醒这里并非完全无人。",
    "风从隧道口涌出，带着潮湿金属与远火的气息，把人的呼吸也吹得发紧。",
    "站台的时钟停在某一刻，指针的阴影却仍在缓慢移动，仿佛时间本身也在犹豫。",
  ]
  const chunks: string[] = []
  let total = 0
  let index = 0
  while (total < minChars && index < 24) {
    const paragraph = seeds[index % seeds.length] ?? seeds[0] ?? ""
    chunks.push(paragraph)
    total += paragraph.replace(/\s+/gu, "").length
    index += 1
  }
  if (userMessage.length > 0) {
    chunks.push(`以上增补围绕你的要求：${userMessage.slice(0, 60)}${userMessage.length > 60 ? "…" : ""}`)
  }
  return chunks.join("\n\n")
}
