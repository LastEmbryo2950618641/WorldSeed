import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  phaseRequestEnvelopeSchema,
  phaseResultEnvelopeSchema,
  type AIPhase,
  type GraphMutation,
  type ModelCallBudget,
  type PersistentIdPrefix,
  type PhaseRequestEnvelope,
  type PhaseResultEnvelope,
  type ProjectId,
  type ProjectSettings,
  type TurnContext,
  type TurnDeductionGoalBundle,
  type ChapterNarrativeIntent,
  type WorkspaceCatalogEntry,
  type WorkspaceCatalogSnapshot,
} from "@worldseed/contracts"
import { defaultProjectSettings, defaultTurnExecutionProfile } from "@worldseed/config"
import {
  assertGraphGovernanceReferenceContract,
  assertGraphSpacetimeSettlementCoverage,
  assertPhaseReferenceContract,
  assertSpacetimeGovernanceCoverage,
  assertSemanticReviewCoversGovernance,
  chapterNamingArtifactSchema,
  dependencyAuditArtifactSchema,
  emergencePlanningArtifactSchema,
  emergenceReviewArtifactSchema,
  frontierSettlementArtifactSchema,
  graphCapacityRewriteArtifactSchema,
  graphGovernanceArtifactSchema,
  graphGovernanceReviewArtifactSchema,
  graphRetrievalDesignArtifactSchema,
  graphSpacetimeSettlementArtifactSchema,
  graphStructurePlanArtifactSchema,
  internalDraftArtifactSchema,
  parsePhaseArtifact,
  ruleAssemblyArtifactSchema,
  semanticReviewArtifactSchema,
  settlementReviewArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

import {
  appendContextSegments,
  assembleChapterDocument,
  assertCitationsWereRead,
  assertUniqueVolumeSequence,
  createTurnContext,
  deriveChapterPublishPath,
  digest,
  inheritContextReads,
  recordContextRead,
  normalizeChapterHeading,
  type GraphRevision,
} from "../../core/index.js"
import type {
  AIModelPort,
  DecisionRecord,
  DocumentRepository,
  GraphRepository,
  GraphDegreeProfile,
  CurrentGraphOwnerRevision,
  PhaseModelExecution,
  PromptResourcePort,
  RetrievalProjection,
  RetrievalRepository,
  ScopeCommitRepository,
  GraphRevisionSpacetimeRecord,
  SceneSpacetimeBindingRecord,
  SettlementRecord,
  TaskScopeRepository,
  TurnPersistencePort,
  TurnPhaseInput,
  TurnFinalizationRecord,
  TurnRetrievalGap,
  TurnReadEvidence,
  VerificationProbeExecution,
  VerificationProbeCheckpoint,
  RelatedOwnerRef,
} from "./ports/index.js"
import type { InternalProjectStore, InternalStorePort, WorkspacePort } from "../workspace/index.js"
import type { ProjectIdAllocatorPort } from "../ids/index.js"
import type {
  EvidenceStore,
  WebResearchPort,
  WorkspaceCatalogPort,
  WorkspaceCatalogSnapshotRepository,
} from "../retrieval/index.js"
import { buildSourceUnitExactKeys } from "../retrieval/index.js"
import { createRetrievalGaps, mergeRetrievalGaps } from "./retrieval-gap.js"
import { VerificationProbeCoordinator, type ReadExecutionRecord } from "./verification-probe-coordinator.js"
import {
  collectReadableEvidenceIds,
  ContextWindowManager,
  estimateModelMessageTokens,
  mergeEvidenceVersions,
} from "../context/index.js"
import {
  assessGraphStructureCapacity,
  findGraphCapacityViolations,
  type GraphCapacityAssessment,
} from "./graph-capacity-policy.js"
import { applyGraphCapacityRewrite, assembleGraphGovernanceArtifact, replayGraphCapacityRewrites } from "./graph-governance-assembler.js"
import { buildStageProjection, readPriorFrontierStates } from "./graph-governance-stage-projection.js"
import { canonicalizeRetrievalProjections } from "./retrieval-projection-canonicalizer.js"
import { decideAdaptiveGraphGovernance } from "./adaptive-graph-governance-coordinator.js"
import { ChapterContextResolver } from "../chapters/chapter-context-resolver.js"
import type { ChapterSynopsisService } from "../chapters/chapter-synopsis-service.js"
import type { SynopsisConversationService } from "../chapters/synopsis-conversation-service.js"
import type { SettingsExtractionService } from "../settings/settings-extraction-service.js"
import { SettingsExtractionReviewPendingError } from "../settings/settings-extraction-review-pending-error.js"
import {
  resolveWorldDivergenceMode,
  worldDivergencePhaseAppendix,
} from "../settings/world-divergence-policy.js"
import { chapterNarrativeIntentPhaseAppendix } from "../settings/chapter-narrative-intent-policy.js"
import { truncateChapterBodyDigest } from "../chapters/turn-handoff.js"
import type { SettingsLineageService } from "../settings/settings-lineage-service.js"
import type { ChapterTemporalSourceResolver } from "../chapters/chapter-temporal-source-resolver.js"
import type { SqliteChapterIndexRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import {
  executeSynopsisTemporalReads,
  isTemporalReadRequest,
  MAX_TEMPORAL_READS_PER_ROUND,
} from "../chapters/synopsis-temporal-reads.js"
import { settingsExtractionArtifactSchema } from "@worldseed/prompt-contracts"

const turnModelPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "emergence_planning",
  "emergence_review",
  "draft",
  "chapter_naming",
  "dependency_audit",
  "settings_extraction",
  "graph_structure_plan",
  "graph_capacity_rewrite",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
]

const turnExecutionPhases: readonly AIPhase[] = [
  ...turnModelPhases.slice(0, 2),
  "source_retrieval",
  ...turnModelPhases.slice(2),
]

const queryExecutionPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "draft",
  "response_review",
]

const evolutionExecutionPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "emergence_planning",
  "emergence_review",
  "dependency_audit",
  "graph_structure_plan",
  "graph_capacity_rewrite",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
]

const revisionExecutionPhases: readonly AIPhase[] = [
  "interpret",
  "rule_assembly",
  "source_retrieval",
  "emergence_planning",
  "emergence_review",
  "dependency_audit",
  "graph_structure_plan",
  "graph_capacity_rewrite",
  "graph_spacetime_settlement",
  "graph_retrieval_design",
  "graph_governance_review",
  "settlement_review",
  "frontier_settlement",
  "commit_review",
]

const phaseInternalArtifactDependencies = {
  interpret: [],
  rule_assembly: ["interpret"],
  source_retrieval: ["interpret", "rule_assembly"],
  emergence_planning: ["interpret", "rule_assembly", "source_retrieval"],
  emergence_review: ["source_retrieval", "emergence_planning"],
  draft: ["interpret", "rule_assembly", "source_retrieval", "emergence_planning", "emergence_review"],
  chapter_naming: ["draft"],
  dependency_audit: ["source_retrieval", "emergence_planning", "emergence_review", "draft"],
  settings_extraction: ["source_retrieval", "emergence_planning", "emergence_review", "draft", "dependency_audit"],
  response_review: ["source_retrieval", "draft", "dependency_audit"],
  graph_governance: ["source_retrieval", "emergence_planning", "emergence_review", "draft", "dependency_audit", "settings_extraction"],
  graph_structure_plan: ["source_retrieval", "emergence_planning", "emergence_review", "draft", "dependency_audit", "settings_extraction"],
  graph_capacity_rewrite: ["graph_structure_plan"],
  graph_spacetime_settlement: ["dependency_audit", "graph_structure_plan"],
  graph_retrieval_design: ["graph_structure_plan", "graph_spacetime_settlement"],
  graph_governance_review: ["dependency_audit", "graph_structure_plan", "graph_spacetime_settlement", "graph_retrieval_design", "graph_governance"],
  semantic_review: ["draft", "dependency_audit", "settings_extraction", "graph_governance"],
  settlement_review: ["dependency_audit", "settings_extraction", "graph_governance", "semantic_review"],
  frontier_settlement: ["graph_governance", "semantic_review", "settlement_review"],
  commit_review: ["draft", "dependency_audit", "settings_extraction", "graph_governance", "graph_governance_review", "semantic_review", "settlement_review", "frontier_settlement"],
  revision_review: [],
  revision_assist: [],
  synopsis_discuss: [],
  work_naming: [],
} as const satisfies Record<AIPhase, readonly AIPhase[]>

const phaseModelArtifactDependencies = {
  ...phaseInternalArtifactDependencies,
  graph_governance_review: [],
  settlement_review: [],
  frontier_settlement: [],
  commit_review: [],
} as const satisfies Record<AIPhase, readonly AIPhase[]>

const workspaceCatalogPhases = new Set<AIPhase>(["interpret", "rule_assembly", "source_retrieval"])

export type WorldWorkflow = "turn" | "query" | "evolution" | "revision"

function executionPhasesFor(workflow: WorldWorkflow, includeAdaptiveRevisionRoute = false): readonly AIPhase[] {
  switch (workflow) {
    case "turn": return turnExecutionPhases
    case "query": return queryExecutionPhases
    case "evolution": return evolutionExecutionPhases
    case "revision": return includeAdaptiveRevisionRoute
      ? ["graph_governance", ...revisionExecutionPhases]
      : revisionExecutionPhases
  }
}

export type TurnOrchestratorInput = Readonly<{
  workflow?: WorldWorkflow
  adaptiveGraphGovernance?: boolean
  projectId: ProjectId
  workspaceRootRef: string
  internalStore: InternalProjectStore
  userInput: string
  chapterSequence: number
  presentation?: Readonly<{
    descriptionRulePath?: string | undefined
    proseStyleRulePath?: string | undefined
    minimumWordCount: number
    maximumWordCount: number
  }>
  chapterIntent?: ChapterNarrativeIntent
  deductionGoalBundle?: TurnDeductionGoalBundle
  taskId?: string
  turnId?: string
  scopeId?: string
  contextId?: string
  sourceId?: string
  existingSourceUnitIds?: readonly string[]
  allowWorkspaceChapterReads?: boolean
  maxModelCalls?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  deadlineMs?: number
  retrievalExecutionDeadlineMs?: number
  retrievalPhaseDeadlineMs?: number
  maxRetrievalRounds?: number
  resetMetricIds?: readonly ("model_calls" | "input_tokens" | "output_tokens" | "wall_time")[]
  projectSettings?: ProjectSettings
  executionOrigin?: Readonly<{
    kind: "user" | "automatic_evolution"
    triggerTaskId?: string
  }>
  nowMs?: number
}>

export type TurnExecutionResult = Readonly<{
  kind: "turn"
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  chapterPath: string
  chapterHeading: string
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  graphAnchorIds: readonly string[]
  kvCacheHitRate?: number
}>

export type WorldQueryExecutionResult = Readonly<{
  kind: "query"
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  answerMarkdown: string
  evidence: readonly Readonly<{
    readId: string
    ownerKind: string
    ownerId: string
    revisionId?: string
    sourceRefs: readonly unknown[]
  }>[]
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
}>

export type WorldEvolutionExecutionResult = Readonly<{
  kind: "evolution"
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  graphAnchorIds: readonly string[]
  graphMutationCount: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  modelProvider: string
  modelName: string
  kvCacheHitRate?: number
}>

export type WorkflowExecutionResult = TurnExecutionResult | WorldQueryExecutionResult | WorldEvolutionExecutionResult

export type TurnExecutionHooks = Readonly<{
  onPrepared?(): void
  signal?: AbortSignal
}>

export type TurnOrchestratorDependencies = Readonly<{
  taskScopes: TaskScopeRepository
  persistence: TurnPersistencePort
  model: AIModelPort
  prompts: PromptResourcePort
  documents: DocumentRepository
  graph: GraphRepository
  retrieval: RetrievalRepository
  catalog: WorkspaceCatalogPort
  catalogSnapshots: WorkspaceCatalogSnapshotRepository
  evidence: EvidenceStore
  commit: ScopeCommitRepository
  internalStore: InternalStorePort
  workspace: WorkspacePort
  /** Optional public-internet research for `sourceKinds: ["web"]`. */
  webResearch?: WebResearchPort
  chapterSynopsis?: ChapterSynopsisService
  synopsisConversation?: SynopsisConversationService
  settingsExtraction?: SettingsExtractionService
  settingsLineage?: SettingsLineageService
  chapterIndex?: SqliteChapterIndexRepository
  chapterTemporal?: ChapterTemporalSourceResolver
  createId: () => string
  idAllocator?: ProjectIdAllocatorPort
  now: () => number
  diagnostics?: Readonly<{
    log(level: "debug" | "info" | "warn" | "error", event: string, fields?: Readonly<Record<string, unknown>>): void
  }>
}>

type TurnBudgetMetric = "model_calls" | "input_tokens" | "output_tokens" | "wall_time"

export class TurnBudgetExceededError extends Error {
  public constructor(public readonly metric: TurnBudgetMetric, message: string) {
    super(message)
    this.name = "TurnBudgetExceededError"
  }
}

export class TurnPauseRequestedError extends Error {
  public readonly kind = "pause_requested" as const

  public constructor(message = "Turn paused by user") {
    super(message)
    this.name = "TurnPauseRequestedError"
  }
}

export class GraphCapacityExceededError extends Error {
  public constructor(public readonly violations: GraphCapacityAssessment["violations"]) {
    super(`Graph governance exceeded configured degree limits at ${String(violations.length)} node(s)`)
    this.name = "GraphCapacityExceededError"
  }
}

export class QueryDraftAuditExceededError extends Error {
  public constructor(public readonly rounds: number) {
    super(`Query draft still fails response review after ${String(rounds)} revision round(s)`)
    this.name = "QueryDraftAuditExceededError"
  }
}

export class TurnOrchestrator {
  private readonly verificationProbes = new VerificationProbeCoordinator()
  private readonly contextWindow = new ContextWindowManager()
  private readonly chapterContext: ChapterContextResolver

  public constructor(private readonly dependencies: TurnOrchestratorDependencies) {
    this.chapterContext = new ChapterContextResolver({
      documents: dependencies.documents,
      internalStore: dependencies.internalStore,
      persistence: dependencies.persistence,
    })
  }

  public async execute(input: TurnOrchestratorInput, hooks?: TurnExecutionHooks): Promise<WorkflowExecutionResult> {
    throwIfExecutionCancelled(hooks?.signal)
    const workflow = input.workflow ?? "turn"
    const taskId = input.taskId ?? this.dependencies.createId()
    const turnId = input.turnId ?? this.dependencies.createId()
    const scopeId = input.scopeId ?? this.dependencies.createId()
    const contextId = input.contextId ?? this.dependencies.createId()
    const sourceId = input.sourceId ?? await this.nextPersistentId(input.projectId, "source")
    const createdAtMs = input.nowMs ?? this.dependencies.now()
    const baseRules = await this.dependencies.prompts.loadTurnSystemRules()
    const modelContextChain = await this.dependencies.persistence.ensureModelContextChain({
      projectId: input.projectId,
      protocolVersion: PROTOCOL_VERSION,
      systemRulesContent: baseRules.text,
      systemRulesDigest: baseRules.digest,
      createdAtMs,
    })
    await this.compactInheritedModelContext(input, modelContextChain.chainId, taskId)
    const budget = createBudget(input, createdAtMs)
    this.log("debug", "turn.started", {
      taskId,
      turnId,
      projectId: input.projectId,
      workflow,
      chapterSequence: input.chapterSequence,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      maxCalls: budget.maxCalls,
      maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
      deadlineAtMs: budget.deadlineAtMs,
    })
    const catalogSnapshot = await this.dependencies.catalog.createSnapshot({
      snapshotId: this.dependencies.createId(),
      projectId: input.projectId,
      workspaceRootRef: input.workspaceRootRef,
      generatedAtMs: createdAtMs,
    })
    await this.dependencies.catalogSnapshots.save(catalogSnapshot)

    const scope = await this.dependencies.taskScopes.create({
      projectId: input.projectId,
      taskId,
      turnId,
      scopeId,
      kind: workflow,
      status: "created",
      reason: `AI ${workflow} starts from user input and creates a pending isolated scope`,
      configSnapshot: {
        budget,
        runtime: {
          modelContextWindowTokens: requireModelContextWindowTokens(this.dependencies.model),
        },
        executionOrigin: input.executionOrigin ?? { kind: "user" },
        ...(input.projectSettings === undefined ? {} : { projectSettings: input.projectSettings }),
      },
      promptSnapshot: {
        baseRulesRef: baseRules.ref,
        baseRulesDigest: baseRules.digest,
        workspaceCatalogSnapshotId: catalogSnapshot.snapshotId,
        workspaceCatalogDigest: catalogSnapshot.digest,
      },
      createdAtMs,
    })
    await this.dependencies.persistence.initializeRuntimeBudgetWindows({
      projectId: input.projectId,
      taskId,
      limits: {
        model_calls: budget.maxCalls,
        input_tokens: finiteApplicationLimit(budget.maxInputTokens),
        output_tokens: finiteApplicationLimit(budget.maxOutputTokens),
        wall_time: Math.max(1, budget.deadlineAtMs - createdAtMs),
      },
      createdAtMs,
    })
    await this.dependencies.catalogSnapshots.attachToTask(taskId, catalogSnapshot.snapshotId)
    let context = createTurnContext({
      contextId,
      projectId: input.projectId,
      taskId,
      turnId,
      taskKind: workflow,
      baseCommittedSequence: scope.baseCommittedSequence,
      maxTokens: resolveContextTokenLimit(
        requireModelContextWindowTokens(this.dependencies.model),
        input.projectSettings?.execution.contextCompactionThresholdRatio
          ?? defaultProjectSettings.execution.contextCompactionThresholdRatio,
      ),
    })
    context = appendContextSegments(context, [{
      segmentId: this.dependencies.createId(),
      kind: "user_input",
      ownerIds: [sourceId],
      visibility: "pending",
      canonicalDigest: digest(input.userInput),
      tokenEstimate: estimateTokens(input.userInput),
      sequence: 0,
    }])
    const visibleModelContextEvidence = await this.dependencies.persistence.listVisibleModelContextEvidence(
      modelContextChain.chainId,
    )
    const inheritedModelEvidence = filterInheritedModelEvidence(
      visibleModelContextEvidence,
      input.allowWorkspaceChapterReads ?? true,
    )
    context = inheritContextReads(context, inheritedModelEvidence.map((evidence) => ({
      readId: evidence.readId,
      visibility: "committed",
      reason: "Inherited from the currently visible model context chain",
    })))
    await this.dependencies.persistence.createContext({ context, createdAtMs, updatedAtMs: createdAtMs })
    const mandatoryWorkspaceReads = await this.readMandatoryWorkspaceEvidence(
      context,
      input,
      catalogSnapshot,
    )
    context = mandatoryWorkspaceReads.context
    const evolutionFrontierReads = workflow === "evolution"
      ? await this.readEvolutionFrontierEvidence(context, input)
      : { context, evidence: [] as TurnReadEvidence[] }
    context = evolutionFrontierReads.context
    await this.dependencies.persistence.saveContext(context, this.dependencies.now())
    await this.dependencies.persistence.updateTask(taskId, "running", undefined, createdAtMs)
    hooks?.onPrepared?.()

    const artifacts: Partial<Record<AIPhase, unknown>> = workflow === "revision"
      ? {
          draft: {
            contentMarkdown: input.userInput,
            adoptedDecisionIndexes: [],
            currentTimeAnchorRefs: [],
            currentLocationAnchorRefs: [],
            detectedUnplannedContent: [],
          },
        }
      : {}
    const phaseRunIds: string[] = []
    const phaseRuns = new Map<AIPhase, string>()
    const sourceUnitIds: string[] = [...(input.existingSourceUnitIds ?? [])]
    const readEvidence: TurnReadEvidence[] = [
      ...inheritedModelEvidence.map((evidence) => ({ ...evidence, visibility: "committed" as const })),
      ...mandatoryWorkspaceReads.evidence,
      ...evolutionFrontierReads.evidence,
    ]
    const retrievalGaps: TurnRetrievalGap[] = []
    const initialState: TurnExecutionState = {
      taskId,
      turnId,
      scopeId,
      contextId,
      sourceId,
      createdAtMs,
      baseRuleVersion: baseRules.version,
      modelContextChainId: modelContextChain.chainId,
      catalogSnapshot,
      context,
      artifacts,
      phaseRunIds,
      phaseRuns,
      phaseAttempts: new Map(),
      sourceUnitIds,
      readEvidence,
      visibleEvidence: [...readEvidence],
      retrievalGaps,
      verificationProbeCheckpoints: [],
      totalUsage: emptyPhaseUsage(),
      budgetWindowUsage: emptyPhaseUsage(),
      budget,
      startPhaseIndex: 0,
      queryDraftAuditRounds: 0,
      ...(input.adaptiveGraphGovernance === true ? { adaptiveGraphGovernance: true } : {}),
      ...(hooks?.signal === undefined ? {} : { signal: hooks.signal }),
    }
    if (workflow === "revision" && input.adaptiveGraphGovernance === true) {
      return this.executeAdaptiveRevisionGraphGovernance(input, initialState)
    }
    return this.continueExecution(input, initialState)
  }

  private async executeAdaptiveRevisionGraphGovernance(
    input: TurnOrchestratorInput,
    state: TurnExecutionState,
  ): Promise<WorldEvolutionExecutionResult> {
    const phase: AIPhase = "graph_governance"
    const phaseRunId = this.dependencies.createId()
    const attempt = (state.phaseAttempts.get(phase) ?? 0) + 1
    state.phaseAttempts.set(phase, attempt)
    state.phaseRunIds.push(phaseRunId)
    state.phaseRuns.set(phase, phaseRunId)
    try {
      const result = await this.executePhase({
        input,
        inputScopeId: state.scopeId,
        sourceId: state.sourceId,
        sourceUnitIds: state.sourceUnitIds,
        phase,
        phaseRunId,
        attempt,
        phaseRunIds: state.phaseRunIds,
        context: state.context,
        artifacts: state.artifacts,
        readEvidence: state.readEvidence,
        visibleEvidence: state.visibleEvidence,
        retrievalGaps: state.retrievalGaps,
        verificationProbeCheckpoints: state.verificationProbeCheckpoints,
        catalogSnapshot: state.catalogSnapshot,
        modelContextChainId: state.modelContextChainId,
        budget: state.budget,
        usage: state.budgetWindowUsage,
        ...(state.signal === undefined ? {} : { signal: state.signal }),
      })
      state.context = result.context
      state.readEvidence = [...result.readEvidence]
      state.visibleEvidence = [...result.visibleEvidence]
      state.retrievalGaps = [...result.retrievalGaps]
      state.artifacts.graph_governance = result.artifact
      state.budgetWindowUsage = addPhaseUsage(state.budgetWindowUsage, result.usage)
      state.totalUsage = addPhaseUsage(state.totalUsage, result.usage)
      await this.dependencies.persistence.saveTaskCheckpoint({
        projectId: input.projectId,
        taskId: state.taskId,
        phaseRunId: result.phaseRunId,
        phase,
        context: state.context,
        modelContextChainId: state.modelContextChainId,
        savedAtMs: this.dependencies.now(),
      })

      const decision = decideAdaptiveGraphGovernance(result.artifact, state.sourceUnitIds.length)
      this.log("debug", "revision.graph_governance.adaptive_route", {
        taskId: state.taskId,
        phaseRunId: result.phaseRunId,
        mode: decision.mode,
        fallbackReason: decision.fallbackReason,
        readRounds: attempt,
        evidenceCount: state.visibleEvidence.length,
        mutationCount: decision.artifact?.mutations.length ?? 0,
        modelCalls: state.totalUsage.modelCalls,
        inputTokens: state.totalUsage.inputTokens,
        outputTokens: state.totalUsage.outputTokens,
      })

      if (decision.mode === "full_governance") {
        delete state.artifacts.graph_governance
        return this.continueExecution({ ...input, adaptiveGraphGovernance: false }, {
          ...state,
          startPhaseIndex: 0,
          adaptiveGraphGovernance: false,
        }) as Promise<WorldEvolutionExecutionResult>
      }

      if (decision.mode === "no_change") {
        await this.dependencies.commit.retire(state.scopeId, this.dependencies.now())
        await this.dependencies.persistence.updateTask(state.taskId, "completed", phase, this.dependencies.now())
        this.log("info", "revision.graph_governance.no_change", {
          taskId: state.taskId,
          scopeId: state.scopeId,
        })
        return {
          kind: "evolution",
          taskId: state.taskId,
          turnId: state.turnId,
          scopeId: state.scopeId,
          contextId: state.contextId,
          graphAnchorIds: [],
          graphMutationCount: 0,
          modelCalls: state.totalUsage.modelCalls,
          inputTokens: state.totalUsage.inputTokens,
          outputTokens: state.totalUsage.outputTokens,
          modelProvider: this.dependencies.model.info?.provider ?? "unknown",
          modelName: this.dependencies.model.info?.model ?? "unknown",
          ...cacheRateResult(state.totalUsage),
        }
      }

      const graphAnchorIds = await this.stageGraphAndSettlement(
        input,
        state.taskId,
        state.sourceId,
        state.scopeId,
        result.phaseRunId,
        state.artifacts,
        state.sourceUnitIds,
        state.readEvidence,
        state.createdAtMs,
        "local",
      )
      await this.dependencies.commit.commit(state.scopeId)
      await this.dependencies.persistence.updateTask(state.taskId, "completed", phase, this.dependencies.now())
      this.log("info", "revision.graph_governance.local_committed", {
        taskId: state.taskId,
        scopeId: state.scopeId,
        graphMutationCount: decision.artifact?.mutations.length ?? 0,
        graphAnchorCount: graphAnchorIds.length,
      })
      return {
        kind: "evolution",
        taskId: state.taskId,
        turnId: state.turnId,
        scopeId: state.scopeId,
        contextId: state.contextId,
        graphAnchorIds,
        graphMutationCount: decision.artifact?.mutations.length ?? 0,
        modelCalls: state.totalUsage.modelCalls,
        inputTokens: state.totalUsage.inputTokens,
        outputTokens: state.totalUsage.outputTokens,
        modelProvider: this.dependencies.model.info?.provider ?? "unknown",
        modelName: this.dependencies.model.info?.model ?? "unknown",
        ...cacheRateResult(state.totalUsage),
      }
    } catch (error) {
      await this.dependencies.commit.resetPending(state.scopeId).catch(() => undefined)
      await this.dependencies.persistence.updateTask(
        state.taskId,
        "awaiting_user_decision",
        phase,
        this.dependencies.now(),
        createInterruptionRecord(error, phase, state.phaseRuns.get(phase), this.dependencies.now()),
      )
      throw error
    }
  }

  private async compactInheritedModelContext(
    input: TurnOrchestratorInput,
    chainId: string,
    taskId: string,
  ): Promise<void> {
    const messages = await this.dependencies.persistence.listModelContextMessages(chainId)
    const hydrated = await this.chapterContext.hydrateNarrativeMessages(input.projectId, messages)
    const compaction = this.contextWindow.plan({
      messages: hydrated,
      contextWindowTokens: requireModelContextWindowTokens(this.dependencies.model),
      triggerRatio: input.projectSettings?.execution.contextCompactionThresholdRatio
        ?? defaultProjectSettings.execution.contextCompactionThresholdRatio,
      targetRatio: input.projectSettings?.execution.contextCompressionTargetRatio
        ?? defaultProjectSettings.execution.contextCompressionTargetRatio,
      incomingTokenEstimate: estimateModelMessageTokens(input.userInput),
    })
    this.log("debug", "context.preinherit_compaction.evaluated", {
      taskId,
      chainId,
      messageCount: messages.length,
      compactionPhase: compaction.phase,
      estimatedTokens: compaction.estimatedTokens,
      thresholdTokens: compaction.thresholdTokens,
      targetTokens: compaction.targetTokens,
      hiddenMessageCount: compaction.hiddenMessageIds.length,
      protectedTokens: compaction.protectedTokens,
      blocked: compaction.blocked,
    })
    if (compaction.blocked) {
      throw new Error(compaction.reason ?? "Protected model context exceeds the configured model window")
    }
    if (compaction.hiddenMessageIds.length === 0) return
    await this.dependencies.persistence.hideModelContextMessages(
      chainId,
      compaction.hiddenMessageIds,
      this.dependencies.now(),
    )
    this.log("info", "context.preinherit_compaction.applied", {
      taskId,
      chainId,
      compactionPhase: compaction.phase,
      hiddenMessageIds: compaction.hiddenMessageIds,
      visibleMessageCount: compaction.visibleMessages.length,
      estimatedTokens: compaction.estimatedTokens,
    })
  }

  public async resume(input: TurnOrchestratorInput, mode: "continue" | "retry_phase" = "continue", hooks?: TurnExecutionHooks): Promise<WorkflowExecutionResult> {
    throwIfExecutionCancelled(hooks?.signal)
    const workflow = input.workflow ?? "turn"
    const executionPhases = executionPhasesFor(
      workflow,
      workflow === "revision" && input.adaptiveGraphGovernance === true,
    )
    if (input.taskId === undefined) throw new Error("A taskId is required to resume a turn")
    const task = await this.dependencies.taskScopes.findTask(input.taskId)
    if (task === undefined) throw new Error(`Cannot resume missing task: ${input.taskId}`)
    if (task.status !== "awaiting_user_decision" && task.status !== "paused" && task.status !== "waiting_for_review") {
      throw new Error(`Task cannot resume from status: ${task.status}`)
    }
    if (task.status === "waiting_for_review" && this.dependencies.settingsExtraction !== undefined) {
      await this.dependencies.settingsExtraction.assertTaskReadyToContinue(input.taskId)
    }
    await this.dependencies.taskScopes.assertCurrentGeneration(task.scopeId)
    const resumeRequestedAtMs = input.nowMs ?? this.dependencies.now()
    if ((input.resetMetricIds?.length ?? 0) > 0) {
      await this.dependencies.persistence.resetRuntimeBudgetWindows({
        taskId: input.taskId,
        metricIds: input.resetMetricIds ?? [],
        limits: {
          model_calls: input.maxModelCalls ?? defaultTurnExecutionProfile.maxTurnModelCalls,
          input_tokens: finiteApplicationLimit(input.maxInputTokens ?? Number.MAX_SAFE_INTEGER),
          output_tokens: finiteApplicationLimit(input.maxOutputTokens ?? Number.MAX_SAFE_INTEGER),
          wall_time: input.deadlineMs ?? defaultTurnExecutionProfile.maxTurnWallTimeMs,
        },
        resetAtMs: resumeRequestedAtMs,
      })
    }
    const blockedMetrics = readBlockedMetrics(task.error)
    const interruptedAtMs = readInterruptionTimestamp(task.error)
    if (!await this.dependencies.persistence.wereRuntimeMetricsResetAfter(input.taskId, blockedMetrics, interruptedAtMs)) {
      throw new Error(`Explicit budget reset required before resume: ${blockedMetrics.join(", ")}`)
    }
    const baseRules = await this.dependencies.prompts.loadTurnSystemRules()
    const modelContextChain = await this.dependencies.persistence.ensureModelContextChain({
      projectId: input.projectId,
      protocolVersion: PROTOCOL_VERSION,
      systemRulesContent: baseRules.text,
      systemRulesDigest: baseRules.digest,
      createdAtMs: input.nowMs ?? this.dependencies.now(),
    })
    const pendingFinalization = await this.dependencies.persistence.findFinalizationByTask(input.taskId)
    if (pendingFinalization !== undefined && pendingFinalization.status !== "completed") {
      return this.resumeTurnFinalization(input, pendingFinalization)
    }
    const scope = await this.dependencies.taskScopes.findScope(task.scopeId)
    const context = await this.dependencies.persistence.findContextByTask(input.taskId)
    let storedRuns = await this.dependencies.persistence.listPhaseRuns(input.taskId)
    const orphanedRunningPhaseRunIds = storedRuns
      .filter((run) => run.status === "running")
      .map((run) => run.phaseRunId)
    if (orphanedRunningPhaseRunIds.length > 0) {
      await this.dependencies.persistence.supersedePhaseRuns(
        input.taskId,
        orphanedRunningPhaseRunIds,
        resumeRequestedAtMs,
      )
      storedRuns = await this.dependencies.persistence.listPhaseRuns(input.taskId)
      this.log("warn", "turn.resume.orphaned_phase_runs_superseded", {
        taskId: input.taskId,
        phaseRunIds: orphanedRunningPhaseRunIds,
      })
    }
    if (scope === undefined || context === undefined || storedRuns.length === 0) {
      throw new Error("The task has no recoverable phase checkpoint")
    }
    const activeStoredRuns = storedRuns.filter((run) => run.status !== "superseded")
    const latestRun = activeStoredRuns.at(-1)
    if (latestRun === undefined) throw new Error("The task has no recoverable phase checkpoint")
    const storedRunInputs = activeStoredRuns.map((run) => {
      const storedRequest = phaseRequestEnvelopeSchema.parse(run.request)
      return { run, input: readStoredTurnPhaseInput(storedRequest.input) }
    })
    let latestInput = storedRunInputs.at(-1)?.input
    if (latestInput === undefined) throw new Error("The task has no recoverable phase checkpoint")
    const sourceId = [...storedRunInputs].reverse().find(({ input: storedInput }) => storedInput.sourceId !== undefined)?.input.sourceId
    const catalogSnapshot = [...storedRunInputs].reverse().find(({ input: storedInput }) => storedInput.workspaceCatalog !== undefined)?.input.workspaceCatalog
    if (sourceId === undefined || catalogSnapshot === undefined) {
      throw new Error("The task checkpoint is missing source or workspace catalog state")
    }
    const latestPhaseIndex = executionPhases.indexOf(latestRun.phase)
    if (latestPhaseIndex < 0) throw new Error(`Cannot resume unknown phase: ${latestRun.phase}`)
    let effectiveRuns = activeStoredRuns
    let restoredPhaseEntryContext = context
    let startPhaseIndex: number
    let graphCapacityFeedback = readGraphCapacityFeedback(task.error)
    let queryRevisionFeedback = latestInput.revisionFeedback
    const restoredQueryDraftAuditRounds = countFailedQueryReviews(activeStoredRuns)
    const invalidatedPhaseRunIds = new Set<string>()
    if (mode === "retry_phase") {
      const currentPhaseRuns = activeStoredRuns.filter((run) => run.phase === latestRun.phase)
      const phaseEntryInput = storedRunInputs.find(({ run }) => run.phase === latestRun.phase)?.input
      if (phaseEntryInput === undefined) throw new Error("The current phase has no entry checkpoint")
      latestInput = phaseEntryInput
      effectiveRuns = activeStoredRuns.filter((run) => run.phase !== latestRun.phase)
      restoredPhaseEntryContext = restoreContextToPhaseEntry(
        context,
        currentPhaseRuns.map((run) => run.phaseRunId),
        uniqueTurnReadEvidence([
          ...storedRunInputs
            .filter(({ run }) => run.phase !== latestRun.phase)
            .flatMap(({ input: storedInput }) => storedInput.readEvidence),
          ...phaseEntryInput.readEvidence,
        ]),
        latestRun.phase,
      )
      await this.dependencies.persistence.supersedePhaseRuns(
        input.taskId,
        currentPhaseRuns.map((run) => run.phaseRunId),
        input.nowMs ?? this.dependencies.now(),
      )
      if (latestRun.phase === "chapter_naming") await this.dependencies.commit.resetPending(task.scopeId)
      startPhaseIndex = latestPhaseIndex
    } else {
      const latestResult = latestRun.status === "completed" && latestRun.result !== undefined
        ? phaseResultEnvelopeSchema.parse(latestRun.result)
        : undefined
      const phaseHasUnresolvedReads = latestResult?.outcome === "request_read"
        && latestResult.requestedReads.length > 0
      const failedQueryReview = workflow === "query"
        && latestRun.phase === "response_review"
        && latestResult !== undefined
        ? queryReviewDecision(latestResult)
        : undefined
      if (failedQueryReview?.requiresRevision === true) {
        startPhaseIndex = executionPhases.indexOf("draft")
        queryRevisionFeedback = failedQueryReview.feedback
      } else {
        startPhaseIndex = latestRun.status === "completed" && !phaseHasUnresolvedReads
          ? latestPhaseIndex + 1
          : latestPhaseIndex
      }
    }
    const artifacts: Partial<Record<AIPhase, unknown>> = workflow === "revision"
      ? {
          draft: {
            contentMarkdown: latestInput.userInput,
            adoptedDecisionIndexes: [],
            currentTimeAnchorRefs: [],
            currentLocationAnchorRefs: [],
            detectedUnplannedContent: [],
          },
        }
      : {}
    const phaseRuns = new Map<AIPhase, string>()
    const phaseAttempts = new Map<AIPhase, number>()
    for (const run of storedRuns) {
      phaseAttempts.set(run.phase, Math.max(phaseAttempts.get(run.phase) ?? 0, run.attempt))
    }

    const latestCompletedRunByPhase = new Map<AIPhase, (typeof effectiveRuns)[number]>()
    for (const run of effectiveRuns) {
      if (run.status === "completed" && run.result !== undefined) latestCompletedRunByPhase.set(run.phase, run)
    }
    let invalidStoredArtifact: {
      run: (typeof effectiveRuns)[number]
      phaseIndex: number
      error: unknown
    } | undefined
    for (const phase of executionPhases) {
      const run = latestCompletedRunByPhase.get(phase)
      if (run?.result === undefined) continue
      try {
        const result = phaseResultEnvelopeSchema.parse(run.result)
        parsePhaseArtifact(run.phase, result.artifact)
      } catch (error) {
        invalidStoredArtifact = { run, phaseIndex: executionPhases.indexOf(run.phase), error }
        break
      }
    }
    if (invalidStoredArtifact !== undefined) {
      const invalidEntry = storedRunInputs.find(({ run }) => run === invalidStoredArtifact.run)
      if (invalidEntry === undefined) throw new Error("The invalid stored phase artifact has no recoverable entry input")
      const invalidatedRuns = effectiveRuns.filter((run) => (
        executionPhases.indexOf(run.phase) >= invalidStoredArtifact.phaseIndex
      ))
      invalidatedRuns.forEach((run) => { invalidatedPhaseRunIds.add(run.phaseRunId) })
      await this.dependencies.persistence.supersedePhaseRuns(
        input.taskId,
        [...invalidatedPhaseRunIds],
        input.nowMs ?? this.dependencies.now(),
      )
      effectiveRuns = effectiveRuns.filter((run) => !invalidatedPhaseRunIds.has(run.phaseRunId))
      latestInput = invalidEntry.input
      restoredPhaseEntryContext = restoreContextToPhaseEntry(
        context,
        [...invalidatedPhaseRunIds],
        uniqueTurnReadEvidence([
          ...storedRunInputs
            .filter(({ run }) => effectiveRuns.includes(run))
            .flatMap(({ input: storedInput }) => storedInput.readEvidence),
          ...invalidEntry.input.readEvidence,
        ]),
        invalidStoredArtifact.run.phase,
      )
      startPhaseIndex = invalidStoredArtifact.phaseIndex
      queryRevisionFeedback = invalidEntry.input.revisionFeedback
      this.log("warn", "turn.resume.invalid_artifact_rewound", {
        taskId: input.taskId,
        invalidatedPhaseRunIds: [...invalidatedPhaseRunIds],
        error: invalidStoredArtifact.error instanceof Error
          ? invalidStoredArtifact.error.message
          : String(invalidStoredArtifact.error),
        resumePhase: invalidStoredArtifact.run.phase,
      })
    }

    const restorableCompletedRunByPhase = new Map<AIPhase, (typeof effectiveRuns)[number]>()
    for (const run of effectiveRuns) {
      phaseRuns.set(run.phase, run.phaseRunId)
      if (run.status === "completed" && run.result !== undefined) restorableCompletedRunByPhase.set(run.phase, run)
    }
    for (const run of restorableCompletedRunByPhase.values()) {
      if (run.result === undefined) continue
      const result = phaseResultEnvelopeSchema.parse(run.result)
      artifacts[run.phase] = parsePhaseArtifact(run.phase, result.artifact)
    }
    const structureRun = effectiveRuns.find((run) => run.phase === "graph_structure_plan" && run.status === "completed" && run.result !== undefined)
    if (structureRun?.result !== undefined) {
      const structureResult = phaseResultEnvelopeSchema.parse(structureRun.result)
      const rewrites = effectiveRuns
        .filter((run) => run.phase === "graph_capacity_rewrite" && run.status === "completed" && run.result !== undefined)
        .map((run) => graphCapacityRewriteArtifactSchema.parse(phaseResultEnvelopeSchema.parse(run.result).artifact))
      artifacts.graph_structure_plan = replayGraphCapacityRewrites(
        graphStructurePlanArtifactSchema.parse(structureResult.artifact),
        rewrites,
      )
    }
    this.materializeStagedGraphGovernanceArtifacts(artifacts, latestInput.sourceUnitIds.length)
    const dependencyAuditIndex = executionPhases.indexOf("dependency_audit")
    const dependencyAudit = artifacts.dependency_audit === undefined
      ? undefined
      : dependencyAuditArtifactSchema.parse(artifacts.dependency_audit)
    if (workflow === "turn"
      && dependencyAuditIndex >= 0
      && startPhaseIndex > dependencyAuditIndex
      && latestInput.sourceUnitIds.length > 0
      && dependencyAudit?.sceneContinuity.length === 0) {
      const dependencyEntry = storedRunInputs.find(({ run }) => (
        run.phase === "dependency_audit" && effectiveRuns.includes(run)
      ))
      if (dependencyEntry === undefined) throw new Error("The invalid dependency audit has no recoverable entry input")
      const invalidatedRuns = effectiveRuns.filter((run) => (
        executionPhases.indexOf(run.phase) >= dependencyAuditIndex
      ))
      invalidatedRuns.forEach((run) => { invalidatedPhaseRunIds.add(run.phaseRunId) })
      await this.dependencies.persistence.supersedePhaseRuns(
        input.taskId,
        [...invalidatedPhaseRunIds],
        input.nowMs ?? this.dependencies.now(),
      )
      effectiveRuns = effectiveRuns.filter((run) => !invalidatedPhaseRunIds.has(run.phaseRunId))
      for (const invalidatedPhase of executionPhases.slice(dependencyAuditIndex)) {
        Reflect.deleteProperty(artifacts, invalidatedPhase)
        phaseRuns.delete(invalidatedPhase)
      }
      latestInput = dependencyEntry.input
      restoredPhaseEntryContext = restoreContextToPhaseEntry(
        context,
        [...invalidatedPhaseRunIds],
        uniqueTurnReadEvidence([
          ...storedRunInputs
            .filter(({ run }) => effectiveRuns.includes(run))
            .flatMap(({ input: storedInput }) => storedInput.readEvidence),
          ...dependencyEntry.input.readEvidence,
        ]),
        "dependency_audit",
      )
      startPhaseIndex = dependencyAuditIndex
      this.log("warn", "dependency_audit.resume_rewound", {
        taskId: input.taskId,
        invalidatedPhaseRunIds: [...invalidatedPhaseRunIds],
        sourceUnitCount: dependencyEntry.input.sourceUnitIds.length,
        resumePhase: "dependency_audit",
      })
    }
    const graphStructureIndex = executionPhases.indexOf("graph_structure_plan")
    const graphCapacityIndex = executionPhases.indexOf("graph_capacity_rewrite")
    if (graphStructureIndex >= 0
      && graphCapacityIndex >= 0
      && startPhaseIndex > graphCapacityIndex
      && artifacts.graph_structure_plan !== undefined) {
      const capacityAssessment = await this.assessGraphStructureCapacity(
        input,
        graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan),
      )
      if (capacityAssessment.violations.length > 0) {
        const structureEntry = storedRunInputs.find(({ run }) => (
          run.phase === "graph_structure_plan" && effectiveRuns.includes(run)
        ))
        if (structureEntry === undefined) throw new Error("The stored graph structure has no recoverable entry input")
        const invalidatedRuns = effectiveRuns.filter((run) => (
          executionPhases.indexOf(run.phase) >= graphCapacityIndex
        ))
        invalidatedRuns.forEach((run) => { invalidatedPhaseRunIds.add(run.phaseRunId) })
        await this.dependencies.persistence.supersedePhaseRuns(
          input.taskId,
          [...invalidatedPhaseRunIds],
          input.nowMs ?? this.dependencies.now(),
        )
        effectiveRuns = effectiveRuns.filter((run) => !invalidatedPhaseRunIds.has(run.phaseRunId))
        for (const invalidatedPhase of executionPhases.slice(graphCapacityIndex)) {
          Reflect.deleteProperty(artifacts, invalidatedPhase)
          phaseRuns.delete(invalidatedPhase)
        }
        delete artifacts.graph_governance
        delete artifacts.semantic_review
        latestInput = structureEntry.input
        restoredPhaseEntryContext = restoreContextToPhaseEntry(
          context,
          [...invalidatedPhaseRunIds],
          uniqueTurnReadEvidence([
            ...storedRunInputs
              .filter(({ run }) => effectiveRuns.includes(run))
              .flatMap(({ input: storedInput }) => storedInput.readEvidence),
            ...structureEntry.input.readEvidence,
          ]),
          "graph_capacity_rewrite",
        )
        startPhaseIndex = graphCapacityIndex
        graphCapacityFeedback = {
          round: 1,
          nodeCount: capacityAssessment.nodeCount,
          linkCount: capacityAssessment.linkCount,
          violations: capacityAssessment.violations,
        }
        this.log("warn", "graph.capacity.resume_rewound", {
          taskId: input.taskId,
          invalidatedPhaseRunIds: [...invalidatedPhaseRunIds],
          violations: capacityAssessment.violations,
          resumePhase: "graph_capacity_rewrite",
        })
      }
    }
    const graphSpacetimeIndex = executionPhases.indexOf("graph_spacetime_settlement")
    if (graphSpacetimeIndex >= 0
      && startPhaseIndex > graphSpacetimeIndex
      && artifacts.dependency_audit !== undefined
      && artifacts.graph_structure_plan !== undefined
      && artifacts.graph_spacetime_settlement !== undefined) {
      const spacetimeEntry = storedRunInputs.find(({ run }) => (
        run.phase === "graph_spacetime_settlement" && effectiveRuns.includes(run)
      ))
      if (spacetimeEntry === undefined) throw new Error("The stored spacetime settlement has no recoverable entry input")
      let invalidSpacetimeError: unknown
      try {
        assertGraphSpacetimeSettlementCoverage(
          artifacts.dependency_audit,
          artifacts.graph_structure_plan,
          artifacts.graph_spacetime_settlement,
          spacetimeEntry.input.sourceUnitIds.length,
        )
        const structure = graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan)
        assertPhaseReferenceContract(
          "graph_spacetime_settlement",
          artifacts.graph_spacetime_settlement,
          {
            readableGraphIds: new Set(spacetimeEntry.input.readEvidence
              .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
              .map((evidence) => evidence.ownerId)),
            readableEvidenceIds: new Set(spacetimeEntry.input.readEvidence.map((evidence) => evidence.readId)),
            readableWorkspacePaths: new Set(),
            declaredLocalGraphRefs: new Set(structure.proposals.flatMap((proposal) => (
              proposal.mutation.operation === "create_node" || proposal.mutation.operation === "create_link"
                ? [proposal.mutation.ref]
                : []
            ))),
          },
        )
      } catch (error) {
        invalidSpacetimeError = error
      }
      if (invalidSpacetimeError !== undefined) {
        const invalidatedRuns = effectiveRuns.filter((run) => (
          executionPhases.indexOf(run.phase) >= graphSpacetimeIndex
        ))
        invalidatedRuns.forEach((run) => { invalidatedPhaseRunIds.add(run.phaseRunId) })
        await this.dependencies.persistence.supersedePhaseRuns(
          input.taskId,
          [...invalidatedPhaseRunIds],
          input.nowMs ?? this.dependencies.now(),
        )
        effectiveRuns = effectiveRuns.filter((run) => !invalidatedPhaseRunIds.has(run.phaseRunId))
        for (const invalidatedPhase of executionPhases.slice(graphSpacetimeIndex)) {
          Reflect.deleteProperty(artifacts, invalidatedPhase)
          phaseRuns.delete(invalidatedPhase)
        }
        delete artifacts.graph_governance
        delete artifacts.semantic_review
        latestInput = spacetimeEntry.input
        restoredPhaseEntryContext = restoreContextToPhaseEntry(
          context,
          [...invalidatedPhaseRunIds],
          uniqueTurnReadEvidence([
            ...storedRunInputs
              .filter(({ run }) => effectiveRuns.includes(run))
              .flatMap(({ input: storedInput }) => storedInput.readEvidence),
            ...spacetimeEntry.input.readEvidence,
          ]),
          "graph_spacetime_settlement",
        )
        startPhaseIndex = graphSpacetimeIndex
        this.log("warn", "graph.spacetime.resume_rewound", {
          taskId: input.taskId,
          invalidatedPhaseRunIds: [...invalidatedPhaseRunIds],
          error: invalidSpacetimeError instanceof Error ? invalidSpacetimeError.message : String(invalidSpacetimeError),
          resumePhase: "graph_spacetime_settlement",
        })
      }
    }
    const graphRetrievalIndex = executionPhases.indexOf("graph_retrieval_design")
    if (graphRetrievalIndex >= 0
      && startPhaseIndex > graphRetrievalIndex
      && artifacts.graph_structure_plan !== undefined
      && artifacts.graph_retrieval_design !== undefined) {
      const retrievalEntry = storedRunInputs.find(({ run }) => (
        run.phase === "graph_retrieval_design" && effectiveRuns.includes(run)
      ))
      if (retrievalEntry === undefined) throw new Error("The stored graph retrieval design has no recoverable entry input")
      let invalidRetrievalError: unknown
      try {
        const structure = graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan)
        assertPhaseReferenceContract(
          "graph_retrieval_design",
          artifacts.graph_retrieval_design,
          {
            readableGraphIds: new Set(retrievalEntry.input.readEvidence
              .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
              .map((evidence) => evidence.ownerId)),
            readableEvidenceIds: new Set(retrievalEntry.input.readEvidence.map((evidence) => evidence.readId)),
            readableWorkspacePaths: new Set(),
            declaredLocalGraphRefs: new Set(structure.proposals.flatMap((proposal) => (
              proposal.mutation.operation === "create_node" || proposal.mutation.operation === "create_link"
                ? [proposal.mutation.ref]
                : []
            ))),
          },
        )
      } catch (error) {
        invalidRetrievalError = error
      }
      if (invalidRetrievalError !== undefined) {
        const invalidatedRuns = effectiveRuns.filter((run) => (
          executionPhases.indexOf(run.phase) >= graphRetrievalIndex
        ))
        invalidatedRuns.forEach((run) => { invalidatedPhaseRunIds.add(run.phaseRunId) })
        await this.dependencies.persistence.supersedePhaseRuns(
          input.taskId,
          [...invalidatedPhaseRunIds],
          input.nowMs ?? this.dependencies.now(),
        )
        effectiveRuns = effectiveRuns.filter((run) => !invalidatedPhaseRunIds.has(run.phaseRunId))
        for (const invalidatedPhase of executionPhases.slice(graphRetrievalIndex)) {
          Reflect.deleteProperty(artifacts, invalidatedPhase)
          phaseRuns.delete(invalidatedPhase)
        }
        delete artifacts.graph_governance
        delete artifacts.semantic_review
        latestInput = retrievalEntry.input
        restoredPhaseEntryContext = restoreContextToPhaseEntry(
          context,
          [...invalidatedPhaseRunIds],
          uniqueTurnReadEvidence([
            ...storedRunInputs
              .filter(({ run }) => effectiveRuns.includes(run))
              .flatMap(({ input: storedInput }) => storedInput.readEvidence),
            ...retrievalEntry.input.readEvidence,
          ]),
          "graph_retrieval_design",
        )
        startPhaseIndex = graphRetrievalIndex
        this.log("warn", "graph.retrieval.resume_rewound", {
          taskId: input.taskId,
          invalidatedPhaseRunIds: [...invalidatedPhaseRunIds],
          error: invalidRetrievalError instanceof Error ? invalidRetrievalError.message : String(invalidRetrievalError),
          resumePhase: "graph_retrieval_design",
        })
      }
    }
    const commitReviewIndex = executionPhases.indexOf("commit_review")
    if (commitReviewIndex >= 0 && startPhaseIndex >= commitReviewIndex) {
      await this.dependencies.commit.resetPending(task.scopeId)
    }
    let restoredSourceUnitIds = [...latestInput.sourceUnitIds]
    if (restoredSourceUnitIds.length === 0 && artifacts.chapter_naming !== undefined) {
      const persistedSourceUnits = await this.dependencies.documents.listSourceUnits(input.projectId, sourceId)
      restoredSourceUnitIds = persistedSourceUnits.length > 0
        ? persistedSourceUnits.map((unit) => unit.id)
        : await this.persistDraftUnits(input, task.scopeId, sourceId, artifacts)
    }
    const nowMs = resumeRequestedAtMs
    const runtimeMetrics = await this.dependencies.persistence.listRuntimeMetrics(input.taskId, nowMs)
    const runtimeBudgetUsage = await this.dependencies.persistence.readRuntimeBudgetUsage(input.taskId, nowMs)
    const resumedMaxModelCalls = readRuntimeMetricLimit(runtimeMetrics, "model_calls") ?? input.maxModelCalls
    const resumedMaxInputTokens = readRuntimeMetricLimit(runtimeMetrics, "input_tokens") ?? input.maxInputTokens
    const resumedMaxOutputTokens = readRuntimeMetricLimit(runtimeMetrics, "output_tokens") ?? input.maxOutputTokens
    const resumedDeadlineMs = readRuntimeMetricLimit(runtimeMetrics, "wall_time") ?? input.deadlineMs
    const resumedInput: TurnOrchestratorInput = {
      ...input,
      ...(resumedMaxModelCalls === undefined ? {} : { maxModelCalls: resumedMaxModelCalls }),
      ...(resumedMaxInputTokens === undefined ? {} : { maxInputTokens: resumedMaxInputTokens }),
      ...(resumedMaxOutputTokens === undefined ? {} : { maxOutputTokens: resumedMaxOutputTokens }),
      ...(resumedDeadlineMs === undefined ? {} : { deadlineMs: resumedDeadlineMs }),
    }
    const totalUsage = storedRuns.reduce((total, run) => addPhaseUsage(total, phaseUsageFromStored(run.usage)), emptyPhaseUsage())
    const verificationProbeCheckpoints = (await this.dependencies.persistence.listVerificationProbeCheckpoints(input.taskId))
      .filter((checkpoint) => !invalidatedPhaseRunIds.has(checkpoint.phaseRunId))
    const restoredContext = restoreVerificationProbeContext(restoredPhaseEntryContext, verificationProbeCheckpoints)
    const restoredProbeEvidence = verificationProbeCheckpoints.flatMap((checkpoint) => checkpoint.evidence)
    const restoredReadEvidence = uniqueTurnReadEvidence([
      ...storedRunInputs
        .filter(({ run }) => effectiveRuns.includes(run))
        .flatMap(({ input: storedInput }) => storedInput.readEvidence),
      ...latestInput.readEvidence,
      ...restoredProbeEvidence,
    ])
    const restoredVisibleEvidence = uniqueTurnReadEvidence([
      ...latestInput.readEvidence,
      ...restoredProbeEvidence,
    ])
    if (restoredContext !== context) {
      await this.dependencies.persistence.saveContext(restoredContext, nowMs)
    }
    this.log("info", "turn.resumed", {
      taskId: task.taskId,
      resumePhase: executionPhases[startPhaseIndex],
      completedPhaseRuns: effectiveRuns.filter((run) => run.status === "completed").length,
      previousModelCalls: totalUsage.modelCalls,
      mode,
    })
    await this.dependencies.persistence.updateTask(task.taskId, "running", executionPhases[startPhaseIndex], nowMs)
    return this.continueExecution(resumedInput, {
      taskId: task.taskId,
      turnId: scope.turnId,
      scopeId: task.scopeId,
      contextId: context.contextId,
      sourceId,
      createdAtMs: task.createdAtMs,
      baseRuleVersion: baseRules.version,
      modelContextChainId: modelContextChain.chainId,
      catalogSnapshot,
      context: restoredContext,
      artifacts,
      phaseRunIds: storedRuns.map((run) => run.phaseRunId),
      phaseRuns,
      phaseAttempts,
      sourceUnitIds: restoredSourceUnitIds,
      readEvidence: restoredReadEvidence,
      visibleEvidence: restoredVisibleEvidence,
      retrievalGaps: [...latestInput.retrievalGaps],
      verificationProbeCheckpoints: [...verificationProbeCheckpoints],
      totalUsage,
      budget: createBudget(resumedInput, nowMs, runtimeBudgetUsage.wallTimeMs),
      budgetWindowUsage: {
        modelCalls: runtimeBudgetUsage.modelCalls,
        inputTokens: runtimeBudgetUsage.inputTokens,
        outputTokens: runtimeBudgetUsage.outputTokens,
        cacheHits: 0,
        cacheMisses: 0,
      },
      startPhaseIndex,
      queryDraftAuditRounds: restoredQueryDraftAuditRounds,
      ...(input.adaptiveGraphGovernance === true ? { adaptiveGraphGovernance: true } : {}),
      ...(queryRevisionFeedback === undefined ? {} : { queryRevisionFeedback }),
      ...(graphCapacityFeedback === undefined ? {} : { graphCapacityFeedback }),
      ...(hooks?.signal === undefined ? {} : { signal: hooks.signal }),
    })
  }

  private async continueExecution(input: TurnOrchestratorInput, state: TurnExecutionState): Promise<WorkflowExecutionResult> {
    const workflow = input.workflow ?? "turn"
    const executionPhases = executionPhasesFor(workflow, state.adaptiveGraphGovernance === true)
    let {
      context,
      sourceUnitIds,
      readEvidence,
      visibleEvidence,
      retrievalGaps,
      totalUsage,
    } = state
    const artifacts = state.artifacts
    const phaseRunIds = state.phaseRunIds
    const phaseRuns = state.phaseRuns
    let windowUsage = state.budgetWindowUsage
    let phaseIndex = state.startPhaseIndex
    let graphGovernanceRounds = 0
    let graphCapacityFeedback = state.graphCapacityFeedback
    let queryDraftAuditRounds = state.queryDraftAuditRounds
    let queryRevisionFeedback = state.queryRevisionFeedback

    try {
      while (phaseIndex < executionPhases.length) {
        const phase = executionPhases[phaseIndex]
        if (phase === undefined) break
        throwIfExecutionCancelled(state.signal)
        if (phase === "graph_capacity_rewrite") {
          const structure = graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan)
          const capacityAssessment = await this.assessGraphStructureCapacity(input, structure)
          graphGovernanceRounds += 1
          this.log(capacityAssessment.violations.length === 0 ? "debug" : "warn", "graph.capacity.staged_assessed", {
            taskId: state.taskId,
            round: graphGovernanceRounds,
            maxRounds: defaultTurnExecutionProfile.maxGraphGovernanceRounds,
            nodeCount: capacityAssessment.nodeCount,
            linkCount: capacityAssessment.linkCount,
            violations: capacityAssessment.violations,
            hotspots: capacityAssessment.entries.slice(0, 12),
          })
          if (capacityAssessment.violations.length === 0) {
            graphCapacityFeedback = undefined
            phaseIndex += 1
            continue
          }
          if (graphGovernanceRounds > defaultTurnExecutionProfile.maxGraphGovernanceRounds) {
            throw new GraphCapacityExceededError(capacityAssessment.violations)
          }
          graphCapacityFeedback = {
            round: graphGovernanceRounds,
            nodeCount: capacityAssessment.nodeCount,
            linkCount: capacityAssessment.linkCount,
            violations: capacityAssessment.violations,
          }
          const capacityEvidence = await this.readGraphCapacityEvidence({
            context,
            input,
            scopeId: state.scopeId,
            catalogSnapshot: state.catalogSnapshot,
            existingEvidence: readEvidence,
            visibleEvidence,
            violations: capacityAssessment.violations,
          })
          context = capacityEvidence.context
          readEvidence = uniqueTurnReadEvidence([...readEvidence, ...capacityEvidence.evidence])
          visibleEvidence = uniqueTurnReadEvidence([...visibleEvidence, ...capacityEvidence.evidence])
          await this.dependencies.persistence.saveContext(context, this.dependencies.now())
        }
        if (phase === "graph_governance_review" && artifacts.graph_governance === undefined) {
          artifacts.graph_governance = assembleGraphGovernanceArtifact({
            structure: graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan),
            spacetime: graphSpacetimeSettlementArtifactSchema.parse(artifacts.graph_spacetime_settlement),
            retrieval: graphRetrievalDesignArtifactSchema.parse(artifacts.graph_retrieval_design),
            sourceUnitCount: sourceUnitIds.length,
          })
        }
        const phaseStartedAtMs = this.dependencies.now()
        const phaseRunId = this.dependencies.createId()
        const attempt = (state.phaseAttempts.get(phase) ?? 0) + 1
        state.phaseAttempts.set(phase, attempt)
        phaseRunIds.push(phaseRunId)
        phaseRuns.set(phase, phaseRunId)
        const result = await this.executePhase({
          input,
          inputScopeId: state.scopeId,
          sourceId: state.sourceId,
          sourceUnitIds,
          phase,
          phaseRunId,
          attempt,
          phaseRunIds,
          context,
          artifacts,
          readEvidence,
          visibleEvidence,
          retrievalGaps,
          verificationProbeCheckpoints: state.verificationProbeCheckpoints,
          catalogSnapshot: state.catalogSnapshot,
          modelContextChainId: state.modelContextChainId,
          budget: state.budget,
          usage: windowUsage,
          ...(graphCapacityFeedback === undefined ? {} : { graphCapacityFeedback }),
          ...(phase !== "draft" || queryRevisionFeedback === undefined ? {} : { revisionFeedback: queryRevisionFeedback }),
          ...(state.signal === undefined ? {} : { signal: state.signal }),
        })
        context = result.context
        readEvidence = [...result.readEvidence]
        visibleEvidence = [...result.visibleEvidence]
        retrievalGaps = mergeRetrievalGaps(retrievalGaps, result.retrievalGaps)
        phaseRuns.set(phase, result.phaseRunId)
        artifacts[phase] = result.artifact
        windowUsage = addPhaseUsage(windowUsage, result.usage)
        totalUsage = addPhaseUsage(totalUsage, result.usage)
        if (phase === "graph_capacity_rewrite") {
          artifacts.graph_structure_plan = applyGraphCapacityRewrite(
            graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan),
            graphCapacityRewriteArtifactSchema.parse(result.artifact),
          )
        }
        if (phase === "graph_governance_review") {
          const review = graphGovernanceReviewArtifactSchema.parse(result.artifact)
          const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
          artifacts.semantic_review = {
            approvedMutationIndexes: governance.mutations.map((_, index) => index),
            rejectedMutationIndexes: [],
            approvedSpacetimeBindingIndexes: governance.sceneSpacetimeBindings.map((_, index) => index),
            rejectedSpacetimeBindingIndexes: [],
            approvedMutationSpacetimeSettlementIndexes: governance.mutationSpacetimeSettlements.map((_, index) => index),
            rejectedMutationSpacetimeSettlementIndexes: [],
            approvedAffectedFrontierRefs: governance.affectedFrontierRefs,
            rejectedAffectedFrontierRefs: [],
            verificationProbeAssessments: review.verificationProbeAssessments,
            sceneInventoryComplete: true,
            graphStillDiscoverable: review.graphStillDiscoverable,
            graphStillConcise: review.graphStillConcise,
            continuityPreserved: review.continuityPreserved,
            spacetimeContinuityPreserved: review.spacetimeContinuityPreserved,
          }
        }
        this.log("debug", "phase.completed", {
          taskId: state.taskId,
          phase,
          phaseRunId: result.phaseRunId,
          elapsedMs: this.dependencies.now() - phaseStartedAtMs,
          phaseModelCalls: result.usage.modelCalls,
          phaseInputTokens: result.usage.inputTokens,
          phaseOutputTokens: result.usage.outputTokens,
          totalModelCalls: totalUsage.modelCalls,
          totalInputTokens: totalUsage.inputTokens,
          totalOutputTokens: totalUsage.outputTokens,
          deadlineRemainingMs: state.budget.deadlineAtMs - this.dependencies.now(),
          contextSegments: context.segments.length,
          evidenceCount: readEvidence.length,
          visibleEvidenceCount: visibleEvidence.length,
          retrievalGapCount: retrievalGaps.length,
        })
        assertUsageWithinBudget(state.budget, windowUsage, this.dependencies.now())
        await this.dependencies.persistence.updateTask(state.taskId, phase === "commit_review" ? "committing" : "running", phase, this.dependencies.now())
        if (phase === "rule_assembly") {
          const rules = ruleAssemblyArtifactSchema.parse(result.artifact)
          const ruleSnapshotId = this.dependencies.createId()
          const sourceVersions = resolveRuleSourceVersions(rules.selectedWorkspacePaths, readEvidence)
          const ruleSnapshot = {
            id: ruleSnapshotId,
            projectId: input.projectId,
            taskId: state.taskId,
            baseRuleVersion: state.baseRuleVersion,
            sourceVersions,
            selectionReasons: rules.selectionReasons,
            createdAtMs: this.dependencies.now(),
          }
          await this.dependencies.persistence.stageRuleSnapshot({
            ...ruleSnapshot,
            digest: digest(ruleSnapshot),
          })
          context = { ...context, ruleSnapshotId }
          await this.dependencies.persistence.saveContext(context, this.dependencies.now())
        }
        if (phase === "chapter_naming") {
          sourceUnitIds = await this.persistDraftUnits(input, state.scopeId, state.sourceId, artifacts)
        }
        await this.dependencies.persistence.saveTaskCheckpoint({
          projectId: input.projectId,
          taskId: state.taskId,
          phaseRunId: result.phaseRunId,
          phase,
          context,
          modelContextChainId: state.modelContextChainId,
          savedAtMs: this.dependencies.now(),
        })
        if (phase === "settings_extraction" && workflow === "turn" && this.dependencies.settingsExtraction !== undefined) {
          const extraction = settingsExtractionArtifactSchema.parse(result.artifact)
          if (extraction.proposals.length > 0) {
            const created = await this.dependencies.settingsExtraction.createProposalsFromArtifact({
              projectId: input.projectId,
              taskId: state.taskId,
              phaseRunId: result.phaseRunId,
              proposals: extraction.proposals,
              worldDivergenceMode: resolveWorldDivergenceMode(input.projectSettings),
            })
            if (created.length > 0) {
              const interruptedAtMs = this.dependencies.now()
              const interruption = {
                kind: "settings_extraction_review",
                message: `正文已生成，抽取了 ${String(created.length)} 条设定修订提案，请确认后再继续图治理`,
                recoverable: true,
                blockedMetrics: [] as const,
                phase,
                phaseRunId: result.phaseRunId,
                interruptedAtMs,
                proposalCount: created.length,
              }
              await this.dependencies.persistence.updateTask(
                state.taskId,
                "waiting_for_review",
                phase,
                interruptedAtMs,
                interruption,
              )
              throw new SettingsExtractionReviewPendingError(created.length)
            }
          }
        }
        if (workflow === "query" && phase === "response_review") {
          const reviewDecision = queryReviewDecision(result)
          if (reviewDecision.requiresRevision) {
            queryDraftAuditRounds += 1
            queryRevisionFeedback = reviewDecision.feedback
            this.log("warn", "world.query.revision_requested", {
              taskId: state.taskId,
              phaseRunId: result.phaseRunId,
              round: queryDraftAuditRounds,
              maxRounds: defaultTurnExecutionProfile.maxDraftAuditRounds,
              outcome: result.outcome,
              evidenceClosed: reviewDecision.review.evidenceClosed,
              leaksUnobservedInformation: reviewDecision.review.leaksUnobservedInformation,
              requiresWorkflowUpgrade: reviewDecision.review.requiresWorkflowUpgrade,
              reason: result.reason,
            })
            if (queryDraftAuditRounds >= defaultTurnExecutionProfile.maxDraftAuditRounds) {
              throw new QueryDraftAuditExceededError(queryDraftAuditRounds)
            }
            delete artifacts.draft
            phaseIndex = queryExecutionPhases.indexOf("draft")
            continue
          }
          queryRevisionFeedback = undefined
        }
        if (phase !== "graph_capacity_rewrite") phaseIndex += 1
      }

      throwIfExecutionCancelled(state.signal)
      if (workflow === "query") {
        return await this.completeQuery(state, artifacts, readEvidence, totalUsage)
      }
      if (workflow === "evolution" || workflow === "revision") {
        return await this.completeEvolution(input, state, artifacts, phaseRuns, readEvidence, totalUsage)
      }
      return await this.completeTurn(input, state, artifacts, phaseRuns, sourceUnitIds, readEvidence, totalUsage)
    } catch (error) {
      if (error instanceof SettingsExtractionReviewPendingError) {
        throw error
      }
      if (state.signal?.aborted) {
        const cancelledPhase = phaseRuns.size === 0 ? undefined : [...phaseRuns.keys()].at(-1)
        const cancelledAtMs = this.dependencies.now()
        const cancellation = executionCancellationReason(state.signal)
        const status = cancellation instanceof TurnPauseRequestedError ? "paused" : "cancelled"
        this.log("info", status === "paused" ? "turn.paused" : "turn.cancelled", {
          taskId: state.taskId,
          turnId: state.turnId,
          phase: cancelledPhase,
          phaseRunId: phaseRuns.get(cancelledPhase as AIPhase),
          elapsedMs: cancelledAtMs - state.createdAtMs,
        })
        await this.dependencies.persistence.updateTask(
          state.taskId,
          status,
          cancelledPhase,
          cancelledAtMs,
        )
        throw cancellation
      }
      const failedPhase = phaseRuns.size === 0 ? undefined : [...phaseRuns.keys()].at(-1)
      const interruptedAtMs = this.dependencies.now()
      const normalizedError = normalizeDeadlineInterruption(error, state.budget, interruptedAtMs)
      const interruption = createInterruptionRecord(normalizedError, failedPhase, phaseRuns.get(failedPhase as AIPhase), interruptedAtMs)
      this.log("warn", "turn.interrupted", {
        taskId: state.taskId,
        turnId: state.turnId,
        failedPhase,
        elapsedMs: interruptedAtMs - state.createdAtMs,
        deadlineAtMs: state.budget.deadlineAtMs,
        nowMs: interruptedAtMs,
        usage: totalUsage,
        interruption,
      })
      await this.dependencies.persistence.updateTask(
        state.taskId,
        "awaiting_user_decision",
        failedPhase,
        interruptedAtMs,
        interruption,
      )
      throw normalizedError
    }
  }

  private async completeTurn(
    input: TurnOrchestratorInput,
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    phaseRuns: ReadonlyMap<AIPhase, string>,
    sourceUnitIds: readonly string[],
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<TurnExecutionResult> {
    const parsedNaming = chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
    const naming = { ...parsedNaming, heading: normalizeChapterHeading(parsedNaming.heading) }
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { recommendation: string }
    this.log("debug", "turn.commit_review.advisory", {
      taskId: state.taskId,
      recommendation: commitReview.recommendation,
      message: "AI commit review is advisory; structural and settlement gates decide whether the turn can be persisted",
    })
    const chapterContent = assembleChapterDocument(naming.heading, draft.contentMarkdown)
    const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, state.sourceId, chapterContent)
    await this.stageDocument(input, state.sourceId, state.scopeId, naming, contentRef, chapterContent, state.createdAtMs)
    const graphAnchorIds = await this.stageGraphAndSettlement(
      input,
      state.taskId,
      state.sourceId,
      state.scopeId,
      phaseRuns.get("graph_governance_review") ?? phaseRuns.get("graph_governance"),
      artifacts,
      sourceUnitIds,
      readEvidence,
      state.createdAtMs,
    )

    const chapterPath = await this.resolveUniqueChapterPublishPath(
      input.workspaceRootRef,
      naming.heading,
      naming.volumeFolderName,
    )
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    const finalization: TurnFinalizationRecord = {
      finalizationId: this.dependencies.createId(),
      projectId: input.projectId,
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      sourceId: state.sourceId,
      chapterSequence: input.chapterSequence,
      chapterPath,
      chapterHeading: naming.heading,
      contentRef,
      contentDigest: digest(chapterContent),
      contentTokenEstimate: estimateTokens(chapterContent),
      canonicalMessageId: this.dependencies.createId(),
      graphAnchorIds,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      ...cacheRateResult(totalUsage),
      status: "prepared",
      createdAtMs: this.dependencies.now(),
      updatedAtMs: this.dependencies.now(),
    }
    await this.dependencies.persistence.createFinalization(finalization)
    await this.executeTurnFinalization(input, finalization)
    this.log("info", "turn.committed", {
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      chapterPath,
      elapsedMs: this.dependencies.now() - state.createdAtMs,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      graphMutationCount: governance.mutations.length,
    })
    return {
      kind: "turn",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      chapterPath,
      chapterHeading: naming.heading,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      graphAnchorIds,
      ...cacheRateResult(totalUsage),
    }
  }

  private async resumeTurnFinalization(
    input: TurnOrchestratorInput,
    finalization: TurnFinalizationRecord,
  ): Promise<TurnExecutionResult> {
    await this.dependencies.persistence.updateTask(
      finalization.taskId,
      "committing",
      "commit_review",
      this.dependencies.now(),
    )
    return this.executeTurnFinalization(input, finalization)
  }

  private async executeTurnFinalization(
    input: TurnOrchestratorInput,
    initial: TurnFinalizationRecord,
  ): Promise<TurnExecutionResult> {
    let current = initial
    try {
      if (current.status === "prepared") {
        this.log("debug", "turn.finalization.step.started", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "scope_commit",
        })
        const committed = await this.dependencies.commit.commit(current.scopeId)
        await this.dependencies.persistence.markFinalizationScopeCommitted(
          current.finalizationId,
          committed.committedSequence,
          this.dependencies.now(),
        )
        current = await this.requireFinalization(current.taskId)
        this.log("debug", "turn.finalization.step.completed", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "scope_commit",
          committedSequence: current.committedSequence,
        })
      }
      if (current.status === "scope_committed") {
        this.log("debug", "turn.finalization.step.started", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "chapter_publish",
        })
        const chapterContent = await this.dependencies.internalStore.readDocument(current.contentRef)
        if (digest(chapterContent) !== current.contentDigest) {
          throw new Error(`Finalization chapter content digest mismatch: ${current.sourceId}`)
        }
        await this.dependencies.workspace.publishChapter(input.workspaceRootRef, current.chapterPath, chapterContent)
        await this.dependencies.persistence.markFinalizationChapterPublished(
          current.finalizationId,
          this.dependencies.now(),
        )
        current = await this.requireFinalization(current.taskId)
        this.log("debug", "turn.finalization.step.completed", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "chapter_publish",
        })
      }
      if (current.status === "chapter_published") {
        this.log("debug", "turn.finalization.step.started", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "chapter_register",
        })
        await this.dependencies.persistence.registerCanonicalChapter(
          current.finalizationId,
          this.dependencies.now(),
        )
        current = await this.requireFinalization(current.taskId)
        this.log("debug", "turn.finalization.step.completed", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "chapter_register",
        })
      }
      if (current.status === "chapter_registered") {
        if (this.dependencies.chapterSynopsis !== undefined) {
          const version = await this.dependencies.documents.findVersion(current.projectId, current.sourceId)
          if (version !== undefined) {
            await this.dependencies.chapterSynopsis.linkAfterPublish({
              projectId: current.projectId,
              workspaceRootRef: input.workspaceRootRef,
              chapterId: version.chapterId,
              chapterSequence: current.chapterSequence,
              chapterPath: current.chapterPath,
            })
          }
        }
        if (this.dependencies.synopsisConversation !== undefined) {
          try {
            const body = await this.dependencies.workspace.readMarkdown(
              input.workspaceRootRef,
              current.chapterPath,
            ).catch(() => "")
            await this.dependencies.synopsisConversation.recordTurnHandoff({
              projectId: current.projectId,
              workspaceRootRef: input.workspaceRootRef,
              brief: {
                taskId: current.taskId,
                chapterSequence: current.chapterSequence,
                chapterPath: current.chapterPath,
                chapterHeading: current.chapterHeading,
                bodyDigest: truncateChapterBodyDigest(body),
                outlineNotes: [
                  "本章已发布；请对照开推前梗概核对兑现与偏差。",
                ],
                createdAtMs: this.dependencies.now(),
              },
              model: this.dependencies.model,
              runAutoAnalysis: true,
              ...(input.chapterIntent === undefined ? {} : { chapterIntent: input.chapterIntent }),
            })
          } catch (error) {
            this.log("warn", "turn.handoff.failed", {
              taskId: current.taskId,
              detail: error instanceof Error ? error.message : String(error),
            })
          }
        }
        this.log("debug", "turn.finalization.step.started", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "task_complete",
        })
        await this.dependencies.persistence.completeFinalization(
          current.finalizationId,
          current.taskId,
          "commit_review",
          this.dependencies.now(),
        )
        this.log("debug", "turn.finalization.step.completed", {
          taskId: current.taskId,
          finalizationId: current.finalizationId,
          step: "task_complete",
        })
      }
      return this.turnResultFromFinalization(current)
    } catch (error) {
      const interruptedAtMs = this.dependencies.now()
      const interruption = createInterruptionRecord(error, "commit_review", undefined, interruptedAtMs)
      this.log("warn", "turn.finalization.interrupted", {
        taskId: current.taskId,
        finalizationId: current.finalizationId,
        status: current.status,
        interruption,
      })
      await this.dependencies.persistence.recordFinalizationError(
        current.finalizationId,
        interruption,
        interruptedAtMs,
      )
      await this.dependencies.persistence.updateTask(
        current.taskId,
        "awaiting_user_decision",
        "commit_review",
        interruptedAtMs,
        interruption,
      )
      throw error
    }
  }

  private async requireFinalization(taskId: string): Promise<TurnFinalizationRecord> {
    const finalization = await this.dependencies.persistence.findFinalizationByTask(taskId)
    if (finalization !== undefined) return finalization
    throw new Error(`Missing finalization record for task: ${taskId}`)
  }

  private turnResultFromFinalization(finalization: TurnFinalizationRecord): TurnExecutionResult {
    return {
      kind: "turn",
      taskId: finalization.taskId,
      turnId: finalization.turnId,
      scopeId: finalization.scopeId,
      contextId: finalization.contextId,
      chapterPath: finalization.chapterPath,
      chapterHeading: finalization.chapterHeading,
      modelCalls: finalization.modelCalls,
      inputTokens: finalization.inputTokens,
      outputTokens: finalization.outputTokens,
      modelProvider: finalization.modelProvider,
      modelName: finalization.modelName,
      graphAnchorIds: finalization.graphAnchorIds,
      ...(finalization.kvCacheHitRate === undefined ? {} : { kvCacheHitRate: finalization.kvCacheHitRate }),
    }
  }

  private async completeQuery(
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<WorldQueryExecutionResult> {
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const review = parsePhaseArtifact("response_review", artifacts.response_review) as {
      evidenceClosed: boolean
      leaksUnobservedInformation: boolean
      requiresWorkflowUpgrade: boolean
    }
    this.log("info", "world.query.reviewed", {
      taskId: state.taskId,
      evidenceClosed: review.evidenceClosed,
      leaksUnobservedInformation: review.leaksUnobservedInformation,
      requiresWorkflowUpgrade: review.requiresWorkflowUpgrade,
      evidenceCount: readEvidence.length,
    })
    await this.dependencies.commit.retire(state.scopeId, this.dependencies.now())
    await this.dependencies.persistence.updateTask(state.taskId, "completed", "response_review", this.dependencies.now())
    return {
      kind: "query",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      answerMarkdown: draft.contentMarkdown,
      evidence: readEvidence.map((evidence) => ({
        readId: evidence.readId,
        ownerKind: evidence.ownerKind,
        ownerId: evidence.ownerId,
        ...(evidence.revisionId === undefined ? {} : { revisionId: evidence.revisionId }),
        ...(evidence.relatedOwnerRefs === undefined ? {} : { relatedOwnerRefs: evidence.relatedOwnerRefs }),
        sourceRefs: evidence.sourceRefs,
      })),
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      ...cacheRateResult(totalUsage),
    }
  }

  private async completeEvolution(
    input: TurnOrchestratorInput,
    state: TurnExecutionState,
    artifacts: Partial<Record<AIPhase, unknown>>,
    phaseRuns: ReadonlyMap<AIPhase, string>,
    readEvidence: readonly TurnReadEvidence[],
    totalUsage: PhaseUsage,
  ): Promise<WorldEvolutionExecutionResult> {
    assertEvolutionFrontierContinuity(readEvidence)
    const commitReview = parsePhaseArtifact("commit_review", artifacts.commit_review) as { recommendation: string }
    this.log("debug", "world.evolve.commit_review.advisory", {
      taskId: state.taskId,
      recommendation: commitReview.recommendation,
    })
    const graphAnchorIds = await this.stageGraphAndSettlement(
      input,
      state.taskId,
      state.sourceId,
      state.scopeId,
      phaseRuns.get("graph_governance_review") ?? phaseRuns.get("graph_governance"),
      artifacts,
      state.sourceUnitIds,
      readEvidence,
      state.createdAtMs,
    )
    await this.dependencies.commit.commit(state.scopeId)
    await this.dependencies.persistence.updateTask(state.taskId, "completed", "commit_review", this.dependencies.now())
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    this.log("info", "world.evolve.committed", {
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      graphMutationCount: governance.mutations.length,
      elapsedMs: this.dependencies.now() - state.createdAtMs,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
    })
    return {
      kind: "evolution",
      taskId: state.taskId,
      turnId: state.turnId,
      scopeId: state.scopeId,
      contextId: state.contextId,
      graphAnchorIds,
      graphMutationCount: governance.mutations.length,
      modelCalls: totalUsage.modelCalls,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      modelProvider: this.dependencies.model.info?.provider ?? "unknown",
      modelName: this.dependencies.model.info?.model ?? "unknown",
      ...cacheRateResult(totalUsage),
    }
  }

  private async executePhase(input: ExecutePhaseInput): Promise<ExecutePhaseResult> {
    throwIfExecutionCancelled(input.signal)
    const basePrompt = await this.dependencies.prompts.loadPhase(input.phase)
    const appendices = [
      worldDivergencePhaseAppendix(
        resolveWorldDivergenceMode(input.input.projectSettings),
        input.phase,
      ),
      chapterNarrativeIntentPhaseAppendix(input.input.chapterIntent, input.phase),
    ].filter((text): text is string => text !== undefined)
    const prompt = appendices.length === 0
      ? basePrompt
      : (() => {
          const text = `${basePrompt.text}\n\n${appendices.join("\n\n")}`
          return {
            ...basePrompt,
            text,
            digest: digest(text),
          }
        })()
    let currentContext = input.context
    let currentPhaseRunId = input.phaseRunId
    let attempt = input.attempt
    let phaseUsage = emptyPhaseUsage()
    let currentEvidence = [...input.readEvidence]
    let currentVisibleEvidence = [...input.visibleEvidence]
    let currentRetrievalGaps = [...input.retrievalGaps]
    const currentVerificationProbeCheckpoints = [...input.verificationProbeCheckpoints]
    let currentVerificationProbeExecutions: VerificationProbeExecution[] = currentVerificationProbeCheckpoints
      .map((checkpoint) => checkpoint.execution)
    let resurfacedReadIds: string[] = []
    const alreadyResurfacedReadIds = new Set<string>()
    const inheritedRetrievalGapCount = currentRetrievalGaps.length
    const inheritedVisibleEvidence = uniqueTurnReadEvidence(input.visibleEvidence)
    const phaseCitedReadIds = new Set<string>()
    const carryForwardEvidence = (): TurnReadEvidence[] => {
      const selected = selectCarryForwardEvidence(
        input.phase,
        inheritedVisibleEvidence,
        currentVisibleEvidence,
        [...phaseCitedReadIds],
      )
      this.log("debug", "phase.evidence_window.selected", {
        taskId: currentContext.taskId,
        phase: input.phase,
        inheritedEvidenceCount: inheritedVisibleEvidence.length,
        availableEvidenceCount: currentVisibleEvidence.length,
        citedEvidenceCount: phaseCitedReadIds.size,
        selectedEvidenceCount: selected.length,
      })
      return selected
    }

    for (;;) {
      const stageProjection = buildStageProjection({
        phase: input.phase,
        scopeId: input.inputScopeId,
        artifacts: input.artifacts,
        sourceUnitCount: input.sourceUnitIds.length,
        verificationProbeExecutions: currentVerificationProbeExecutions,
        readEvidence: currentVisibleEvidence,
      })
      const phaseInput: TurnPhaseInput = {
        workflow: input.input.workflow ?? "turn",
        userInput: input.input.userInput,
        chapterSequence: input.input.chapterSequence,
        allowWorkspaceChapterReads: input.input.allowWorkspaceChapterReads ?? true,
        ...(input.input.presentation === undefined ? {} : { presentation: input.input.presentation }),
        ...(input.input.chapterIntent === undefined ? {} : { chapterIntent: input.input.chapterIntent }),
        ...(input.input.deductionGoalBundle === undefined
          ? {}
          : {
              deductionGoalBundle: input.input.deductionGoalBundle,
              deductionGoalConstraintMarkdown: formatDeductionGoalConstraintMarkdown(
                input.input.deductionGoalBundle,
              ),
            }),
        sourceId: input.sourceId,
        sourceUnitIds: input.sourceUnitIds,
        phaseRunIds: input.phaseRunIds,
        readEvidence: currentVisibleEvidence,
        ...(resurfacedReadIds.length === 0 ? {} : { resurfacedReadIds }),
        retrievalGaps: currentRetrievalGaps,
        ...((input.phase === "semantic_review" || input.phase === "graph_governance_review") && currentVerificationProbeExecutions.length > 0
          ? { verificationProbeExecutions: currentVerificationProbeExecutions }
          : {}),
        ...(phaseUsesWorkspaceCatalog(input.phase) ? { workspaceCatalog: input.catalogSnapshot } : {}),
        ...(input.input.projectSettings === undefined ? {} : { projectSettings: input.input.projectSettings }),
        ...(input.revisionFeedback === undefined ? {} : { revisionFeedback: input.revisionFeedback }),
        ...(input.phase === "graph_capacity_rewrite"
          ? { graphCapacity: await this.readGraphCapacity(input) }
          : {}),
        ...(stageProjection === undefined
          ? {}
          : {
              stageProjection,
              validationArtifacts: selectPhaseArtifacts(
                input.phase,
                input.artifacts,
                phaseInternalArtifactDependencies,
              ),
            }),
        artifacts: selectPhaseArtifacts(
          input.phase,
          input.artifacts,
          phaseModelArtifactDependencies,
        ),
      }
      const phaseBudget = remainingBudget(input.budget, {
        modelCalls: input.usage.modelCalls + phaseUsage.modelCalls,
        inputTokens: input.usage.inputTokens + phaseUsage.inputTokens,
        outputTokens: input.usage.outputTokens + phaseUsage.outputTokens,
      })
      const modelRequestTimeoutMs = input.input.projectSettings?.execution.maxModelRequestTimeMs
        ?? defaultProjectSettings.execution.maxModelRequestTimeMs
      const readableEvidenceIds = collectReadableEvidenceIds(
        currentContext.readLedger,
        [...currentEvidence, ...currentVisibleEvidence],
      )
      const request: PhaseRequestEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        envelopeId: this.dependencies.createId(),
        projectId: input.input.projectId,
        taskId: currentContext.taskId,
        turnId: currentContext.turnId,
        contextId: currentContext.contextId,
        scopeId: input.inputScopeId,
        phase: input.phase,
        protocolVersion: PROTOCOL_VERSION,
        promptRef: prompt.ref,
        promptDigest: prompt.digest,
        contextViewRef: digest({ contextId: currentContext.contextId, segments: currentContext.segments }),
        committedReadIds: readableEvidenceIds.committedReadIds,
        visiblePendingIds: readableEvidenceIds.visiblePendingIds,
        remainingBudget: {
          ...phaseBudget,
          modelRequestDeadlineAtMs: Math.min(
            phaseBudget.deadlineAtMs,
            this.dependencies.now() + modelRequestTimeoutMs,
          ),
        },
        input: phaseInput,
      }
      const startedAtMs = this.dependencies.now()
      await this.dependencies.persistence.updateTask(
        currentContext.taskId,
        input.phase === "commit_review" ? "committing" : "running",
        input.phase,
        this.dependencies.now(),
      )

      if (input.usage.modelCalls + phaseUsage.modelCalls >= input.budget.maxCalls) {
        throw new TurnBudgetExceededError("model_calls", "Model call budget exhausted before the next phase")
      }

      await this.dependencies.persistence.startPhaseRun({
        phaseRunId: currentPhaseRunId,
        projectId: input.input.projectId,
        taskId: currentContext.taskId,
        contextId: currentContext.contextId,
        phase: input.phase,
        attempt,
        request,
        startedAtMs,
      })

      this.log("debug", "phase.model_request.started", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        contextSegments: currentContext.segments.length,
        committedReadCount: request.committedReadIds.length,
        visiblePendingCount: request.visiblePendingIds.length,
        evidenceCount: currentEvidence.length,
        visibleEvidenceCount: currentVisibleEvidence.length,
        visibleEvidenceProfile: profileTurnEvidence(currentVisibleEvidence),
        retrievalGapCount: currentRetrievalGaps.length,
        priorArtifactCount: Object.keys(input.artifacts).length,
        phaseInputCharacters: JSON.stringify(phaseInput).length,
        artifactCharacters: JSON.stringify(phaseInput.artifacts).length,
        workspaceCatalogEntryCount: phaseInput.workspaceCatalog?.entries.length ?? 0,
        remainingCalls: request.remainingBudget.remainingCalls,
        remainingInputTokens: request.remainingBudget.remainingInputTokens,
        remainingOutputTokens: request.remainingBudget.remainingOutputTokens,
        deadlineRemainingMs: request.remainingBudget.deadlineAtMs - this.dependencies.now(),
        modelRequestDeadlineRemainingMs: (request.remainingBudget.modelRequestDeadlineAtMs ?? request.remainingBudget.deadlineAtMs) - this.dependencies.now(),
      })

      let execution: PhaseModelExecution
      try {
        const persistedContextMessages = await this.dependencies.persistence.listModelContextMessages(input.modelContextChainId)
        const hydratedMessages = await this.chapterContext.hydrateNarrativeMessages(input.input.projectId, persistedContextMessages)
        const hydratedContextContent = new Map(hydratedMessages.map((message) => [message.messageId, message.content]))
        const contextMessagesForCompaction = hydratedMessages
        const compaction = this.contextWindow.plan({
          messages: contextMessagesForCompaction,
          currentTurnId: currentContext.turnId,
          contextWindowTokens: requireModelContextWindowTokens(this.dependencies.model),
          triggerRatio: input.input.projectSettings?.execution.contextCompactionThresholdRatio
            ?? defaultProjectSettings.execution.contextCompactionThresholdRatio,
          targetRatio: input.input.projectSettings?.execution.contextCompressionTargetRatio
            ?? defaultProjectSettings.execution.contextCompressionTargetRatio,
          incomingTokenEstimate: estimateModelMessageTokens(JSON.stringify({ phase: input.phase, prompt: prompt.text, request })),
        })
        this.log("debug", "context.compaction.evaluated", {
          taskId: currentContext.taskId,
          phase: input.phase,
          chainId: input.modelContextChainId,
          messageCount: persistedContextMessages.length,
          compactionPhase: compaction.phase,
          estimatedTokens: compaction.estimatedTokens,
          thresholdTokens: compaction.thresholdTokens,
          targetTokens: compaction.targetTokens,
          hiddenMessageCount: compaction.hiddenMessageIds.length,
          protectedTokens: compaction.protectedTokens,
          blocked: compaction.blocked,
        })
        if (compaction.blocked) {
          throw new Error(compaction.reason ?? "Protected model context exceeds the configured model window")
        }
        if (compaction.hiddenMessageIds.length > 0) {
          await this.dependencies.persistence.hideModelContextMessages(
            input.modelContextChainId,
            compaction.hiddenMessageIds,
            this.dependencies.now(),
          )
          this.log("info", "context.compaction.applied", {
            taskId: currentContext.taskId,
            phase: input.phase,
            chainId: input.modelContextChainId,
            compactionPhase: compaction.phase,
            hiddenMessageIds: compaction.hiddenMessageIds,
            visibleMessageCount: compaction.visibleMessages.length,
            estimatedTokens: compaction.estimatedTokens,
          })
        }
        const contextMessages = compaction.visibleMessages.map((message) => ({
          messageId: message.messageId,
          sequence: message.sequence,
          role: message.role,
          kind: message.kind,
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
          ...(message.phase === undefined ? {} : { phase: message.phase }),
          content: hydratedContextContent.get(message.messageId) as string,
        }))
        execution = await this.dependencies.model.execute(
          request,
          {
            contextChainId: input.modelContextChainId,
            contextMessages,
            phasePrompt: prompt,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
        )
        throwIfExecutionCancelled(input.signal)
      } catch (error) {
        this.log("error", "phase.model_request.failed", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          attempt,
          elapsedMs: this.dependencies.now() - startedAtMs,
          error,
        })
        await this.dependencies.persistence.finishPhaseRun({
          phaseRunId: currentPhaseRunId,
          status: input.signal?.aborted ? "cancelled" : "failed",
          result: {
            error: error instanceof Error ? error.message : String(error),
            ...(isRecordWithRawResponse(error) ? { rawModelOutput: error.rawResponse } : {}),
          },
          usage: {},
          finishedAtMs: this.dependencies.now(),
        })
        throw error
      }
      const parsedResult = phaseResultEnvelopeSchema.parse(execution.result)
      resurfacedReadIds = []
      this.log("debug", "phase.model_response.received", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        elapsedMs: this.dependencies.now() - startedAtMs,
        outcome: parsedResult.outcome,
        requestedReadCount: parsedResult.requestedReads.length,
        citedReadCount: parsedResult.citedReadIds.length,
        citedReadIds: parsedResult.citedReadIds,
         readableReadIds: [...request.committedReadIds, ...request.visiblePendingIds],
        invalidCitedReadIds: parsedResult.citedReadIds.filter((readId) => !(
          request.committedReadIds.includes(readId)
          || request.visiblePendingIds.includes(readId)
        )),
        retrievalGapRequestIds: currentRetrievalGaps.map((gap) => gap.requestId),
        citedRetrievalGapIds: parsedResult.citedReadIds.filter((readId) => (
          currentRetrievalGaps.some((gap) => gap.requestId === readId)
        )),
        unresolvedDependencyCount: parsedResult.unresolvedDependencies.length,
        inputTokens: execution.usage.inputTokens,
        outputTokens: execution.usage.outputTokens,
        cacheHitInputTokens: execution.usage.cacheHitInputTokens,
        cacheMissInputTokens: execution.usage.cacheMissInputTokens,
      })
      assertCitationsWereRead(currentContext, parsedResult.citedReadIds)
      assertCitationsAreVisible(request, parsedResult.citedReadIds)
      for (const readId of parsedResult.citedReadIds) phaseCitedReadIds.add(readId)
      const attemptUsage = phaseUsageFromExecution(execution)
      phaseUsage = addPhaseUsage(phaseUsage, attemptUsage)
      const effectiveRequestedReads = parsedResult.requestedReads
      let validatedFinalArtifact: unknown
      if (effectiveRequestedReads.length === 0) {
        try {
          validatedFinalArtifact = this.parseAndValidatePhaseArtifact(
            input.phase,
            parsedResult.artifact,
            currentContext.taskId,
            currentPhaseRunId,
            input.sourceUnitIds.length,
          )
          if (input.phase === "semantic_review" || input.phase === "graph_governance_review") {
            this.verificationProbes.assertAssessments(validatedFinalArtifact, currentVerificationProbeExecutions)
          }
        } catch (error) {
          await this.dependencies.persistence.finishPhaseRun({
            phaseRunId: currentPhaseRunId,
            status: "failed",
            result: { error: error instanceof Error ? error.message : String(error) },
            usage: execution.usage,
            finishedAtMs: this.dependencies.now(),
          })
          throw error
        }
      }
      const resultSegment = {
        segmentId: this.dependencies.createId(),
        kind: "phase_result" as const,
        ownerIds: [currentPhaseRunId, ...parsedResult.producedArtifactIds],
        visibility: "pending" as const,
        canonicalDigest: digest(parsedResult),
        tokenEstimate: estimateTokens(parsedResult),
        sequence: currentContext.segments.length,
      }
      currentContext = appendContextSegments(currentContext, [resultSegment])
      await this.dependencies.persistence.finishPhaseRun({
        phaseRunId: currentPhaseRunId,
        status: "completed",
        result: {
          ...parsedResult,
          ...(execution.usage.reasoningContent === undefined ? {} : { modelReasoning: execution.usage.reasoningContent }),
          ...(execution.usage.reasoningKind === undefined ? {} : { modelReasoningKind: execution.usage.reasoningKind }),
        },
        usage: execution.usage,
        ...(execution.contextExchange === undefined ? {} : {
          contextMessages: [
            ...execution.contextExchange.requestMessages,
            execution.contextExchange.responseMessage,
          ],
        }),
        finishedAtMs: this.dependencies.now(),
      })
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      if (parsedResult.outcome === "blocked"
        || parsedResult.outcome === "revise"
        || parsedResult.outcome === "reject"
        || parsedResult.outcome === "retire") {
        this.log("warn", "phase.model_advisory", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          message: "AI workflow decisions are advisory; structural persistence gates determine whether execution can continue",
        })
      }
      if (effectiveRequestedReads.length === 0) {
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
          artifact: validatedFinalArtifact,
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          usage: phaseUsage,
        }
      }

      const completedProbePlans = new Set(currentVerificationProbeCheckpoints.map((checkpoint) => checkpoint.planDigest))
      const plannedInThisResponse = new Set<string>()
      const requestedReads = effectiveRequestedReads.filter((read) => {
        if ((input.phase !== "semantic_review" && input.phase !== "graph_governance_review") || read.verificationProbe === undefined) return true
        const planDigest = this.verificationProbes.planDigest(read, input.artifacts.graph_governance)
        if (completedProbePlans.has(planDigest) || plannedInThisResponse.has(planDigest)) return false
        plannedInThisResponse.add(planDigest)
        return true
      })
      const skippedProbeCount = effectiveRequestedReads.length - requestedReads.length
      if (skippedProbeCount > 0) {
        this.log("debug", "verification_probe.completed_plan_skipped", {
          taskId: currentContext.taskId,
          phaseRunId: currentPhaseRunId,
          skippedProbeCount,
          completedProbeCount: currentVerificationProbeCheckpoints.length,
        })
      }
      const readsStartedAtMs = this.dependencies.now()
      const includesVerificationProbe = (input.phase === "semantic_review" || input.phase === "graph_governance_review")
        && requestedReads.some((request) => request.verificationProbe !== undefined)
      this.log("debug", "phase.reads.started", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        requestCount: requestedReads.length,
      })

      if (attempt >= (input.input.maxRetrievalRounds ?? input.input.projectSettings?.execution.maxRetrievalRounds ?? defaultProjectSettings.execution.maxRetrievalRounds)) {
        const exhaustedVerificationProbes = requestedReads.filter((request) => request.verificationProbe !== undefined)
        this.log("warn", "phase.reads.exhausted", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          attempt,
          exhaustedVerificationProbeCount: exhaustedVerificationProbes.length,
          completedVerificationProbeCount: currentVerificationProbeExecutions.length,
          requestedReadIds: requestedReads.map((read) => read.requestId),
          ledgerReturnedReadIds: currentContext.readLedger.returnedReadIds,
          ledgerCommittedReadIds: currentContext.readLedger.committedReadIds,
          ledgerVisiblePendingIds: currentContext.readLedger.visiblePendingIds,
        })
        if (exhaustedVerificationProbes.length > 0) {
          this.log("warn", "verification_probe.read_gap_recorded", {
            taskId: currentContext.taskId,
            phase: input.phase,
            phaseRunId: currentPhaseRunId,
            requestIds: exhaustedVerificationProbes.map((request) => request.requestId),
            message: "Verification probes could not be executed within the retrieval-round limit; no execution or pass assessment was fabricated",
          })
        }
        currentRetrievalGaps = [
          ...currentRetrievalGaps,
          ...createRetrievalGaps(requestedReads),
        ]
        this.log("debug", "retrieval.gaps.recorded", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          gapCount: requestedReads.length,
          requestIds: requestedReads.map((request) => request.requestId),
          typeId: "system:retrieval-gap",
        })
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
          artifact: this.parseAndValidatePhaseArtifact(
            input.phase,
            parsedResult.artifact,
            currentContext.taskId,
            currentPhaseRunId,
            input.sourceUnitIds.length,
          ),
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          usage: phaseUsage,
        }
      }
      const readResult = await this.executeReads(
        currentContext,
        requestedReads,
        input.input.projectId,
        input.inputScopeId,
        input.input.projectSettings?.retrieval,
        input.input.workspaceRootRef,
        input.catalogSnapshot,
        currentEvidence,
        includesVerificationProbe ? [] : currentVisibleEvidence,
        input.input.allowWorkspaceChapterReads ?? true,
        input.input.chapterSequence,
        async (request, readExecution, requestEvidence, contextRead) => {
          if ((input.phase !== "semantic_review" && input.phase !== "graph_governance_review") || request.verificationProbe === undefined) return
          const probeIndex = (currentVerificationProbeExecutions.at(-1)?.probeIndex ?? -1) + 1
          const execution = this.verificationProbes.createExecutions(
            [request],
            [readExecution],
            input.artifacts.graph_governance,
            probeIndex,
          )[0]
          if (execution === undefined) throw new Error(`Verification probe execution was not created: ${request.requestId}`)
          const checkpointCore = {
            projectId: input.input.projectId,
            taskId: currentContext.taskId,
            phaseRunId: currentPhaseRunId,
            probeIndex,
            planDigest: this.verificationProbes.planDigest(request, input.artifacts.graph_governance),
            execution,
            evidence: requestEvidence,
            contextRead,
            createdAtMs: this.dependencies.now(),
          }
          const checkpoint = { ...checkpointCore, recordDigest: digest(checkpointCore) }
          const savedCheckpoint = await this.dependencies.persistence.saveVerificationProbeCheckpoint(checkpoint)
          currentVerificationProbeCheckpoints.push(savedCheckpoint)
          currentVerificationProbeExecutions = [...currentVerificationProbeExecutions, savedCheckpoint.execution]
          this.log("debug", "verification_probe.checkpoint.saved", {
            taskId: currentContext.taskId,
            phaseRunId: currentPhaseRunId,
            probeIndex,
            planDigest: savedCheckpoint.planDigest,
            evidenceCount: savedCheckpoint.evidence.length,
          })
        },
      )
      currentContext = readResult.context
      currentEvidence = reconcileCurrentGraphEvidence(
        [...currentEvidence, ...readResult.evidence],
        readResult.currentGraphRevisions,
      )
      currentVisibleEvidence = reconcileCurrentGraphEvidence(
        [...currentVisibleEvidence, ...readResult.evidence],
        readResult.currentGraphRevisions,
      )
      this.log("debug", "phase.reads.completed", {
        taskId: currentContext.taskId,
        phase: input.phase,
        phaseRunId: currentPhaseRunId,
        attempt,
        evidenceAdded: readResult.evidence.length,
        evidenceReadIds: readResult.evidence.map((evidence) => evidence.readId),
        elapsedMs: this.dependencies.now() - readsStartedAtMs,
        addedEvidenceProfile: profileTurnEvidence(readResult.evidence),
        totalEvidence: currentEvidence.length,
        retrievalGapCount: currentRetrievalGaps.length,
        committedReadCount: currentContext.readLedger.committedReadIds.length,
        visiblePendingCount: currentContext.readLedger.visiblePendingIds.length,
        ledgerReturnedReadIds: currentContext.readLedger.returnedReadIds,
      })
      const readsResolvedFromVisibleEvidence = readResult.readExecutions.some((execution) => (
        execution.returnedReadRefs.length > 0
      ))
      if (readResult.evidence.length === 0 && readsResolvedFromVisibleEvidence && !includesVerificationProbe) {
        const returnedReadIds = [...new Set(readResult.readExecutions.flatMap((execution) => execution.returnedReadRefs))]
        const newlyResurfacedReadIds = returnedReadIds.filter((readId) => !alreadyResurfacedReadIds.has(readId))
        this.log("debug", "retrieval.visible_evidence_reused", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          requestIds: requestedReads.map((request) => request.requestId),
          returnedReadRefs: returnedReadIds,
          newlyResurfacedReadIds,
        })
        if (newlyResurfacedReadIds.length > 0) {
          for (const readId of newlyResurfacedReadIds) alreadyResurfacedReadIds.add(readId)
          resurfacedReadIds = returnedReadIds
          await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
          currentPhaseRunId = this.dependencies.createId()
          input.phaseRunIds.push(currentPhaseRunId)
          attempt += 1
          continue
        }
        await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
          artifact: this.parseAndValidatePhaseArtifact(
            input.phase,
            parsedResult.artifact,
            currentContext.taskId,
            currentPhaseRunId,
            input.sourceUnitIds.length,
          ),
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          usage: phaseUsage,
        }
      }
      if (readResult.evidence.length === 0 && !readsResolvedFromVisibleEvidence
        && !((input.phase === "semantic_review" || input.phase === "graph_governance_review")
          && effectiveRequestedReads.some((request) => request.verificationProbe !== undefined))) {
        currentRetrievalGaps = [
          ...currentRetrievalGaps,
          ...createRetrievalGaps(requestedReads),
        ]
        this.log("debug", "retrieval.gaps.recorded", {
          taskId: currentContext.taskId,
          phase: input.phase,
          phaseRunId: currentPhaseRunId,
          gapCount: requestedReads.length,
          requestIds: requestedReads.map((request) => request.requestId),
          typeId: "system:retrieval-gap",
          reason: "no_new_evidence",
        })
        await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
        return {
          phaseRunId: currentPhaseRunId,
          context: currentContext,
          readEvidence: currentEvidence,
          visibleEvidence: carryForwardEvidence(),
          retrievalGaps: currentRetrievalGaps.slice(inheritedRetrievalGapCount),
          artifact: parsePhaseArtifact(input.phase, parsedResult.artifact),
          outcome: parsedResult.outcome,
          reason: parsedResult.reason,
          selfReview: parsedResult.selfReview,
          usage: phaseUsage,
        }
      }
      await this.dependencies.persistence.saveContext(currentContext, this.dependencies.now())
      currentPhaseRunId = this.dependencies.createId()
      input.phaseRunIds.push(currentPhaseRunId)
      attempt += 1
    }
  }

  private async readGraphCapacity(input: ExecutePhaseInput): Promise<NonNullable<TurnPhaseInput["graphCapacity"]>> {
    const settings = input.input.projectSettings?.graph ?? defaultProjectSettings.graph
    const profile: GraphDegreeProfile = await this.dependencies.graph.getDegreeProfile({
      projectId: input.input.projectId,
      pendingScopeId: input.inputScopeId,
    })
    return {
      nodeCount: profile.nodeCount,
      linkCount: profile.linkCount,
      maxDirectInDegree: settings.maxDirectInDegree,
      maxDirectOutDegree: settings.maxDirectOutDegree,
      mergeWarningThreshold: settings.mergeWarningThreshold,
      hotspots: profile.entries.slice(0, Math.max(8, settings.maxNeighborhoodAnchors)),
      ...(input.graphCapacityFeedback === undefined ? {} : {
        candidateAssessment: input.graphCapacityFeedback,
      }),
    }
  }

  private async readGraphCapacityEvidence(input: Readonly<{
    context: TurnContext
    input: TurnOrchestratorInput
    scopeId: string
    catalogSnapshot: WorkspaceCatalogSnapshot
    existingEvidence: readonly TurnReadEvidence[]
    visibleEvidence: readonly TurnReadEvidence[]
    violations: GraphCapacityAssessment["violations"]
  }>): Promise<Readonly<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }>> {
    const graphSettings = input.input.projectSettings?.graph ?? defaultProjectSettings.graph
    const retrievalSettings = input.input.projectSettings?.retrieval ?? defaultProjectSettings.retrieval
    const anchorIds = [...new Set(input.violations.map((violation) => violation.nodeId)
      .filter((nodeId) => !nodeId.startsWith("local:")))]
    if (anchorIds.length === 0) return { context: input.context, evidence: [] }
    const maxCandidates = Math.max(
      retrievalSettings.maxCandidates,
      graphSettings.maxVisitedNodes + graphSettings.maxVisitedLinks,
    )
    const requestId = this.dependencies.createId()
    const result = await this.executeReads(
      input.context,
      [{
        requestId,
        reason: "Read the bounded local graph around capacity violations before restructuring it",
        expectedEvidence: "Current hotspot nodes, incident links, and adjacent nodes needed for a valid local graph rewrite",
        query: {
          exactKeys: [],
          semanticTexts: [],
          anchorIds,
          directions: ["both"],
          maxCandidates,
          maxDepth: 1,
          sourceKinds: ["graph", "revision"],
        },
      }],
      input.input.projectId,
      input.scopeId,
      {
        ...retrievalSettings,
        maxCandidates,
        maxDepth: Math.max(1, retrievalSettings.maxDepth),
      },
      input.input.workspaceRootRef,
      input.catalogSnapshot,
      input.existingEvidence,
      [],
      input.input.allowWorkspaceChapterReads ?? true,
      input.input.chapterSequence,
    )
    this.log("debug", "graph.capacity.evidence_loaded", {
      taskId: input.context.taskId,
      requestId,
      anchorIds,
      evidenceCount: result.evidence.length,
      graphOwnerIds: result.evidence
        .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
        .map((evidence) => evidence.ownerId),
    })
    return { context: result.context, evidence: result.evidence }
  }

  private async assessGraphStructureCapacity(
    input: TurnOrchestratorInput,
    structure: ReturnType<typeof graphStructurePlanArtifactSchema.parse>,
  ): Promise<GraphCapacityAssessment> {
    const settings = input.projectSettings?.graph ?? defaultProjectSettings.graph
    return assessGraphStructureCapacity({
      projectId: input.projectId,
      profile: await this.dependencies.graph.getDegreeProfile({ projectId: input.projectId }),
      structure,
      limits: settings,
      graph: this.dependencies.graph,
    })
  }

  private materializeStagedGraphGovernanceArtifacts(
    artifacts: Partial<Record<AIPhase, unknown>>,
    sourceUnitCount: number,
  ): void {
    if (artifacts.graph_governance === undefined
      && artifacts.graph_structure_plan !== undefined
      && artifacts.graph_spacetime_settlement !== undefined
      && artifacts.graph_retrieval_design !== undefined) {
      artifacts.graph_governance = assembleGraphGovernanceArtifact({
        structure: graphStructurePlanArtifactSchema.parse(artifacts.graph_structure_plan),
        spacetime: graphSpacetimeSettlementArtifactSchema.parse(artifacts.graph_spacetime_settlement),
        retrieval: graphRetrievalDesignArtifactSchema.parse(artifacts.graph_retrieval_design),
        sourceUnitCount,
      })
    }
    if (artifacts.semantic_review === undefined
      && artifacts.graph_governance !== undefined
      && artifacts.graph_governance_review !== undefined) {
      const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
      const review = graphGovernanceReviewArtifactSchema.parse(artifacts.graph_governance_review)
      artifacts.semantic_review = {
        approvedMutationIndexes: governance.mutations.map((_, index) => index),
        rejectedMutationIndexes: [],
        approvedSpacetimeBindingIndexes: governance.sceneSpacetimeBindings.map((_, index) => index),
        rejectedSpacetimeBindingIndexes: [],
        approvedMutationSpacetimeSettlementIndexes: governance.mutationSpacetimeSettlements.map((_, index) => index),
        rejectedMutationSpacetimeSettlementIndexes: [],
        approvedAffectedFrontierRefs: governance.affectedFrontierRefs,
        rejectedAffectedFrontierRefs: [],
        verificationProbeAssessments: review.verificationProbeAssessments,
        sceneInventoryComplete: true,
        graphStillDiscoverable: review.graphStillDiscoverable,
        graphStillConcise: review.graphStillConcise,
        continuityPreserved: review.continuityPreserved,
        spacetimeContinuityPreserved: review.spacetimeContinuityPreserved,
      }
    }
  }

  private async readMandatoryWorkspaceEvidence(
    context: TurnContext,
    input: TurnOrchestratorInput,
    catalogSnapshot: WorkspaceCatalogSnapshot,
  ): Promise<{ context: TurnContext; evidence: readonly TurnReadEvidence[] }> {
    const selectedPresentationPaths = resolveSelectedPresentationPaths(input.presentation)
    const requiredEntries = catalogSnapshot.entries.filter((entry) => (
      isMandatoryWorkspaceEntry(entry)
      || selectedPresentationPaths.includes(entry.relativePath)
    ))
    const requiredPaths = new Set(requiredEntries.map((entry) => entry.relativePath))
    for (const requiredPath of ["设定集/readme.md", "参考文件/readme.md"]) {
      if (!requiredPaths.has(requiredPath)) {
        throw new Error(`Required workspace index is missing: ${requiredPath}`)
      }
    }
    for (const selectedPath of selectedPresentationPaths) {
      const selectedEntry = catalogSnapshot.entries.find((entry) => entry.relativePath === selectedPath)
      if (selectedEntry?.entryKind !== "file") {
        throw new Error(`Selected presentation rule is missing: ${selectedPath}`)
      }
    }
    const returned: Array<{ readId: string; reason: string; segment: TurnContext["segments"][number] }> = []
    const evidence: TurnReadEvidence[] = []
    for (const entry of requiredEntries) {
      const content = await this.dependencies.workspace.readMarkdown(input.workspaceRootRef, entry.relativePath)
      const evidenceId = await this.nextPersistentId(input.projectId, "evidence")
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId,
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "workspace",
        ownerId: entry.relativePath,
        version: entry.version,
        digest: entry.digest,
        locator: `workspace://${entry.relativePath}`,
        content,
        readReason: "Mandatory turn workspace context",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateTokens(content)
      returned.push({
        readId: storedEvidence.evidenceId,
        reason: "Mandatory turn workspace context",
        segment: {
          segmentId: this.dependencies.createId(),
          kind: "committed_read",
          ownerIds: [storedEvidence.evidenceId],
          visibility: "committed",
          canonicalDigest: storedEvidence.digest,
          tokenEstimate,
          sequence: context.segments.length + returned.length,
        },
      })
      evidence.push(workspaceTurnEvidence(storedEvidence.evidenceId, entry, content))
    }
    const requestId = this.dependencies.createId()
    this.log("debug", "workspace.required_evidence.loaded", {
      taskId: context.taskId,
      requestId,
      evidenceCount: evidence.length,
      paths: evidence.map((item) => item.ownerId),
    })
    let nextContext = recordContextRead(context, { requestId, returned, rejectedReadIds: [] })
    const presentationEvidence = evidence.filter((item) => item.ownerKind === "workspace:presentation")
    if (presentationEvidence.length > 0) {
      nextContext = appendContextSegments(nextContext, [{
        segmentId: this.dependencies.createId(),
        kind: "presentation_rules",
        ownerIds: presentationEvidence.map((item) => item.readId),
        visibility: "committed",
        canonicalDigest: digest(presentationEvidence.map((item) => item.digest)),
        tokenEstimate: presentationEvidence.reduce((total, item) => total + estimateTokens(item.semanticText), 0),
        sequence: nextContext.segments.length,
      }])
    }
    return { context: nextContext, evidence }
  }

  private async readEvolutionFrontierEvidence(
    context: TurnContext,
    input: TurnOrchestratorInput,
  ): Promise<Readonly<{ context: TurnContext; evidence: TurnReadEvidence[] }>> {
    const limit = input.projectSettings?.retrieval.maxCandidates
      ?? defaultProjectSettings.retrieval.maxCandidates
    const frontiers = await this.dependencies.persistence.listSchedulableFrontiers(input.projectId, limit)
    if (frontiers.length === 0) return { context, evidence: [] }
    const anchorIds = [...new Set(frontiers.flatMap((frontier) => [
      frontier.frontierAnchorRef,
      ...frontier.lastSceneAnchorRefs,
      ...frontier.lastTimeAnchorRefs,
      ...frontier.lastLocationAnchorRefs,
      ...frontier.correspondenceRefs,
    ]))]
    const currentProjections = await this.dependencies.retrieval.findCurrentForOwners(
      { projectId: input.projectId },
      anchorIds,
      Math.max(limit, anchorIds.length),
    )
    const projectionsByOwnerId = new Map(currentProjections.map((projection) => [projection.ownerId, projection]))
    const evidence: TurnReadEvidence[] = []
    const returned: Array<Readonly<{
      readId: string
      reason: string
      segment: TurnContext["segments"][number]
    }>> = []

    for (const frontier of frontiers) {
      const relatedOwnerRefs = [...new Set([
        frontier.frontierAnchorRef,
        ...frontier.lastSceneAnchorRefs,
        ...frontier.lastTimeAnchorRefs,
        ...frontier.lastLocationAnchorRefs,
        ...frontier.correspondenceRefs,
      ])].flatMap((ownerId) => {
        const projection = projectionsByOwnerId.get(ownerId)
        return projection === undefined ? [] : [{
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          revisionId: projection.ownerRevisionId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
        }]
      })
      const semanticText = JSON.stringify({
        disposition: frontier.disposition,
        reason: frontier.reason,
        revisitCondition: frontier.revisitCondition ?? null,
        lastSceneAnchorCount: frontier.lastSceneAnchorRefs.length,
        lastTimeAnchorCount: frontier.lastTimeAnchorRefs.length,
        lastLocationAnchorCount: frontier.lastLocationAnchorRefs.length,
        correspondenceCount: frontier.correspondenceRefs.length,
      })
      const readId = await this.nextPersistentId(input.projectId, "evidence")
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId: readId,
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "graph",
        ownerId: frontier.frontierAnchorRef,
        version: String(frontier.lastProcessedAt),
        digest: digest(semanticText),
        locator: frontier.id,
        content: semanticText,
        readReason: "Load a bounded committed world-evolution frontier before autonomous evolution",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateRetrievalEvidenceTokens({
        ownerKind: "frontier",
        ownerId: frontier.frontierAnchorRef,
        exactKeys: [],
        semanticText,
        relatedOwnerRefs,
      })
      returned.push({
        readId,
        reason: storedEvidence.readReason,
        segment: {
          segmentId: this.dependencies.createId(),
          kind: "committed_read",
          ownerIds: [readId],
          visibility: "committed",
          canonicalDigest: storedEvidence.digest,
          tokenEstimate,
          sequence: context.segments.length + returned.length,
        },
      })
      evidence.push({
        readId,
        visibility: "committed",
        ownerKind: "frontier",
        ownerId: frontier.frontierAnchorRef,
        exactKeys: [],
        semanticText,
        sourceRefs: [{
          frontierRecordId: frontier.id,
          frontierAnchorRef: frontier.frontierAnchorRef,
          lastSceneAnchorRefs: frontier.lastSceneAnchorRefs,
          lastTimeAnchorRefs: frontier.lastTimeAnchorRefs,
          lastLocationAnchorRefs: frontier.lastLocationAnchorRefs,
          correspondenceRefs: frontier.correspondenceRefs,
        }],
        relatedOwnerRefs,
        digest: storedEvidence.digest,
      })
    }

    for (const projection of currentProjections) {
      const storedEvidence = await this.dependencies.evidence.writeImmutable({
        evidenceId: await this.nextPersistentId(input.projectId, "evidence"),
        projectId: input.projectId,
        contextId: context.contextId,
        sourceKind: "graph",
        ownerId: projection.ownerId,
        version: projection.ownerRevisionId,
        digest: digest(projection.semanticText),
        locator: projection.projectionId,
        content: projection.semanticText,
        readReason: "Resolve current graph anchors for a scheduled world-evolution frontier",
        createdAtMs: this.dependencies.now(),
      })
      const tokenEstimate = estimateRetrievalEvidenceTokens(projection)
      returned.push({
        readId: storedEvidence.evidenceId,
        reason: storedEvidence.readReason,
        segment: {
          segmentId: this.dependencies.createId(),
          kind: "committed_read",
          ownerIds: [storedEvidence.evidenceId],
          visibility: "committed",
          canonicalDigest: storedEvidence.digest,
          tokenEstimate,
          sequence: context.segments.length + returned.length,
        },
      })
      evidence.push({
        readId: storedEvidence.evidenceId,
        visibility: "committed",
        ownerKind: projection.ownerKind,
        ownerId: projection.ownerId,
        revisionId: projection.ownerRevisionId,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        sourceRefs: projection.sourceRefs,
        digest: projection.digest,
        stateRole: "current",
      })
    }
    this.log("debug", "world.evolve.frontiers.loaded", {
      taskId: context.taskId,
      frontierCount: frontiers.length,
      anchorCount: anchorIds.length,
      resolvedAnchorCount: currentProjections.length,
    })
    return {
      context: recordContextRead(context, {
        requestId: this.dependencies.createId(),
        returned,
        rejectedReadIds: [],
      }),
      evidence,
    }
  }

  private async executeReads(
    context: TurnContext,
    requests: PhaseResultEnvelope["requestedReads"],
    projectId: ProjectId,
    scopeId: string,
    settings: ProjectSettings["retrieval"] | undefined,
    workspaceRootRef: string,
    catalogSnapshot: WorkspaceCatalogSnapshot,
    existingEvidence: readonly TurnReadEvidence[],
    budgetEvidence: readonly TurnReadEvidence[],
    allowWorkspaceChapterReads: boolean,
    chapterSequence: number,
    onReadExecution?: (
      request: PhaseResultEnvelope["requestedReads"][number],
      execution: ReadExecutionRecord,
      evidence: readonly TurnReadEvidence[],
      contextRead: Readonly<{
        requestId: string
        returned: readonly Readonly<{
          readId: string
          reason: string
          segment: TurnContext["segments"][number]
        }>[]
        rejectedReadIds: readonly string[]
      }>,
    ) => Promise<void>,
  ): Promise<{
    context: TurnContext
    evidence: readonly TurnReadEvidence[]
    readExecutions: readonly ReadExecutionRecord[]
    currentGraphRevisions: readonly CurrentGraphOwnerRevision[]
  }> {
    const returned = [] as Array<{
      requestId: string
      readId: string
      reason: string
      segment: TurnContext["segments"][number]
    }>
    const evidence: TurnReadEvidence[] = []
    const readExecutions: ReadExecutionRecord[] = []
    const currentGraphRevisions = new Map<string, CurrentGraphOwnerRevision>()
    const seenReadIds = new Set<string>()
    const seenEvidenceKeys = new Set(existingEvidence.map((item) => `${item.ownerId}:${item.digest}`))
    const visibleReadIds = new Set(budgetEvidence.map((item) => item.readId))
    const selectedRequests = requests.slice(0, settings?.maxRequestsPerRound ?? requests.length)
    const evidenceTokenLimit = settings?.maxEvidenceTokens ?? Number.POSITIVE_INFINITY
    let evidenceTokens = budgetEvidence
      .filter(countsAgainstRetrievalEvidenceBudget)
      .reduce((total, item) => total + estimateRetrievalEvidenceTokens(item), 0)
    let evidenceBudgetTruncated = false
    let includedRelatedOwnerRefs = 0
    let omittedRelatedOwnerRefs = 0
    let temporalReadsThisRound = 0
    let nextContext = context
    if (selectedRequests.length < requests.length) {
      this.log("debug", "retrieval.requests.truncated", {
        taskId: context.taskId,
        requestedCount: requests.length,
        selectedCount: selectedRequests.length,
        maxRequestsPerRound: settings?.maxRequestsPerRound,
      })
    }
    for (const request of selectedRequests) {
      const evidenceStartIndex = evidence.length
      const retrievalRequestStartedAtMs = this.dependencies.now()
      const requestReadRefs = new Set<string>()
      const requestGraphRefs = new Set<string>()
      if (
        isTemporalReadRequest(request)
        && this.dependencies.settingsLineage !== undefined
        && this.dependencies.chapterTemporal !== undefined
        && this.dependencies.chapterIndex !== undefined
      ) {
        const temporalRejected = temporalReadsThisRound >= MAX_TEMPORAL_READS_PER_ROUND
        if (!temporalRejected) {
          temporalReadsThisRound += 1
          const temporalItems = await executeSynopsisTemporalReads({
            projectId,
            sessionChapterSequence: chapterSequence,
            catalog: catalogSnapshot,
            requests: [request],
            existingEvidence: [...existingEvidence, ...evidence],
            settingsLineage: this.dependencies.settingsLineage,
            chapterIndex: this.dependencies.chapterIndex,
            documents: this.dependencies.documents,
            internalStore: this.dependencies.internalStore,
            chapterTemporal: this.dependencies.chapterTemporal,
            createId: this.dependencies.createId,
            ...(settings?.maxCandidates === undefined
              ? {}
              : { maxCandidates: settings.maxCandidates }),
          })
          for (const item of temporalItems) {
            const evidenceKey = `${item.ownerId}:${item.digest}`
            if (seenEvidenceKeys.has(evidenceKey)) {
              const existing = [...existingEvidence, ...evidence].find((entry) => (
                `${entry.ownerId}:${entry.digest}` === evidenceKey
              ))
              if (existing !== undefined) requestReadRefs.add(existing.readId)
              continue
            }
            const tokenEstimate = estimateRetrievalEvidenceTokens(item)
            if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
              evidenceBudgetTruncated = true
              continue
            }
            seenEvidenceKeys.add(evidenceKey)
            evidenceTokens += tokenEstimate
            const evidenceId = await this.nextPersistentId(projectId, "evidence")
            const sourceKind = item.ownerKind.startsWith("settings-lineage") ? "workspace" as const : "chapter" as const
            const storedEvidence = await this.dependencies.evidence.writeImmutable({
              evidenceId,
              projectId,
              contextId: context.contextId,
              sourceKind,
              ownerId: item.ownerId,
              version: item.digest.slice(0, 16),
              digest: item.digest,
              locator: item.ownerKind.startsWith("settings-lineage")
                ? `settings-lineage://${item.ownerId}`
                : `source-temporal://${item.ownerId}`,
              content: item.semanticText,
              readReason: request.reason,
              createdAtMs: this.dependencies.now(),
            })
            returned.push({
              requestId: request.requestId,
              readId: storedEvidence.evidenceId,
              reason: request.reason,
              segment: {
                segmentId: this.dependencies.createId(),
                kind: "committed_read",
                ownerIds: [storedEvidence.evidenceId],
                visibility: "committed",
                canonicalDigest: storedEvidence.digest,
                tokenEstimate,
                sequence: context.segments.length + returned.length,
              },
            })
            evidence.push({ ...item, readId: storedEvidence.evidenceId })
            requestReadRefs.add(storedEvidence.evidenceId)
          }
        }
        const readExecution = {
          requestId: request.requestId,
          operationId: request.requestId,
          returnedReadRefs: [...requestReadRefs],
          returnedGraphRefs: [...requestGraphRefs],
          resultDigest: digest({
            requestId: request.requestId,
            query: request.query,
            returnedReadRefs: [...requestReadRefs],
            returnedGraphRefs: [...requestGraphRefs],
          }),
        }
        readExecutions.push(readExecution)
        const contextRead = {
          requestId: request.requestId,
          returned: returned
            .filter((item) => item.requestId === request.requestId)
            .map(({ requestId: ignoredRequestId, ...item }) => {
              void ignoredRequestId
              return item
            }),
          rejectedReadIds: temporalRejected ? [request.requestId] : [],
        }
        nextContext = recordContextRead(nextContext, contextRead)
        await onReadExecution?.(request, readExecution, evidence.slice(evidenceStartIndex), contextRead)
        this.log("debug", "retrieval.temporal.completed", {
          taskId: context.taskId,
          requestId: request.requestId,
          purpose: request.query.purpose ?? "current",
          asOfChapterSequence: request.query.asOfChapterSequence,
          evidenceCount: evidence.length - evidenceStartIndex,
          elapsedMs: this.dependencies.now() - retrievalRequestStartedAtMs,
        })
        continue
      }
      const maxCandidates = Math.min(request.query.maxCandidates, settings?.maxCandidates ?? request.query.maxCandidates)
      const maxDepth = Math.min(request.query.maxDepth, settings?.maxDepth ?? request.query.maxDepth)
      const workspaceEntries = selectWorkspaceEntries(
        catalogSnapshot,
        request,
        maxCandidates,
        allowWorkspaceChapterReads,
      )
      for (const entry of workspaceEntries) {
        const evidenceKey = `${entry.relativePath}:${entry.digest}`
        if (seenEvidenceKeys.has(evidenceKey)) {
          const existing = [...existingEvidence, ...evidence].find((item) => `${item.ownerId}:${item.digest}` === evidenceKey)
          if (existing !== undefined) requestReadRefs.add(existing.readId)
          continue
        }
        const content = await this.dependencies.workspace.readMarkdown(workspaceRootRef, entry.relativePath)
        const workspaceEvidence = workspaceTurnEvidence("budget-preview", entry, content)
        const tokenEstimate = estimateRetrievalEvidenceTokens(workspaceEvidence)
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenEvidenceKeys.add(evidenceKey)
        evidenceTokens += tokenEstimate
        const evidenceId = await this.nextPersistentId(projectId, "evidence")
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId,
          projectId,
          contextId: context.contextId,
          sourceKind: "workspace",
          ownerId: entry.relativePath,
          version: entry.version,
          digest: entry.digest,
          locator: `workspace://${entry.relativePath}`,
          content,
          readReason: request.reason,
          createdAtMs: this.dependencies.now(),
        })
        returned.push({
          requestId: request.requestId,
          readId: storedEvidence.evidenceId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: "committed_read",
            ownerIds: [storedEvidence.evidenceId],
            visibility: "committed",
            canonicalDigest: storedEvidence.digest,
            tokenEstimate,
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push(workspaceTurnEvidence(storedEvidence.evidenceId, entry, content))
        requestReadRefs.add(storedEvidence.evidenceId)
      }
      if (
        request.query.sourceKinds.includes("web")
        && (settings?.webResearchEnabled ?? defaultProjectSettings.retrieval.webResearchEnabled)
        && this.dependencies.webResearch !== undefined
      ) {
        const maxWebResults = Math.min(
          maxCandidates,
          settings?.maxWebResults ?? defaultProjectSettings.retrieval.maxWebResults,
        )
        const webItems = await this.collectWebResearchEvidence({
          request,
          maxWebResults,
        })
        for (const item of webItems) {
          const evidenceKey = `${item.ownerId}:${item.digest}`
          if (seenEvidenceKeys.has(evidenceKey)) {
            const existing = [...existingEvidence, ...evidence].find((entry) => `${entry.ownerId}:${entry.digest}` === evidenceKey)
            if (existing !== undefined) requestReadRefs.add(existing.readId)
            continue
          }
          const tokenEstimate = estimateRetrievalEvidenceTokens(item)
          if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
            evidenceBudgetTruncated = true
            continue
          }
          seenEvidenceKeys.add(evidenceKey)
          evidenceTokens += tokenEstimate
          const evidenceId = await this.nextPersistentId(projectId, "evidence")
          const storedEvidence = await this.dependencies.evidence.writeImmutable({
            evidenceId,
            projectId,
            contextId: context.contextId,
            sourceKind: "web",
            ownerId: item.ownerId,
            version: item.digest.slice(0, 16),
            digest: item.digest,
            locator: item.locator,
            content: item.semanticText,
            readReason: request.reason,
            createdAtMs: this.dependencies.now(),
          })
          returned.push({
            requestId: request.requestId,
            readId: storedEvidence.evidenceId,
            reason: request.reason,
            segment: {
              segmentId: this.dependencies.createId(),
              kind: "committed_read",
              ownerIds: [storedEvidence.evidenceId],
              visibility: "committed",
              canonicalDigest: storedEvidence.digest,
              tokenEstimate,
              sequence: context.segments.length + returned.length,
            },
          })
          evidence.push({
            ...item,
            readId: storedEvidence.evidenceId,
          })
          requestReadRefs.add(storedEvidence.evidenceId)
        }
      }
      const searchesGraph = request.query.sourceKinds.some((kind) => (
        kind === "graph" || kind === "revision" || kind === "source"
      ))
      const searchesGraphOwners = request.query.sourceKinds.some((kind) => (
        kind === "graph" || kind === "revision"
      ))
      const graphScope = { projectId, pendingScopeId: scopeId }
      const neighborhood = searchesGraphOwners && request.query.anchorIds.length > 0 && maxDepth > 0
        ? await this.dependencies.graph.getNeighborhood({
            scope: graphScope,
            anchorIds: request.query.anchorIds,
            direction: resolveGraphReadDirection(request.query.directions),
            maxDepth,
            maxNodes: maxCandidates,
            maxLinks: maxCandidates,
          })
        : undefined
      const anchoredOwnerIds = [...new Set([
        ...request.query.anchorIds,
        ...(neighborhood?.nodes.map((node) => node.id) ?? []),
        ...(neighborhood?.links.map((link) => link.id) ?? []),
      ])]
      const currentAnchorRevisions = searchesGraphOwners
        ? await this.dependencies.graph.getCurrentOwnerRevisions(graphScope, anchoredOwnerIds)
        : []
      for (const current of currentAnchorRevisions) {
        currentGraphRevisions.set(`${current.ownerKind}:${current.ownerId}`, current)
      }
      const visibleGraphEvidenceByOwner = new Map(
        budgetEvidence
          .filter((item) => (item.ownerKind === "node" || item.ownerKind === "link") && item.revisionId !== undefined)
          .map((item) => [`${item.ownerKind}:${item.ownerId}`, item] as const),
      )
      const staleOrMissingAnchorIds = currentAnchorRevisions.flatMap((current) => {
        const visible = visibleGraphEvidenceByOwner.get(`${current.ownerKind}:${current.ownerId}`)
        return visible?.revisionId === current.revisionId ? [] : [current.ownerId]
      })
      for (const current of currentAnchorRevisions) {
        const visible = visibleGraphEvidenceByOwner.get(`${current.ownerKind}:${current.ownerId}`)
        if (visible?.revisionId === current.revisionId) {
          requestReadRefs.add(visible.readId)
          requestGraphRefs.add(visible.ownerId)
        }
      }
      const freshnessProfile = currentAnchorRevisions.reduce((profile, current) => {
        const visible = visibleGraphEvidenceByOwner.get(`${current.ownerKind}:${current.ownerId}`)
        if (visible === undefined) profile.missing += 1
        else if (visible.revisionId === current.revisionId) profile.current += 1
        else profile.stale += 1
        return profile
      }, { current: 0, stale: 0, missing: 0 })
      this.log("debug", "retrieval.graph_freshness.checked", {
        taskId: context.taskId,
        requestId: request.requestId,
        requestedAnchorCount: anchoredOwnerIds.length,
        resolvedAnchorCount: currentAnchorRevisions.length,
        currentEvidenceCount: freshnessProfile.current,
        staleEvidenceCount: freshnessProfile.stale,
        missingEvidenceCount: freshnessProfile.missing,
      })
      const refreshOwnerIds = [...new Set([
        ...staleOrMissingAnchorIds,
        ...(neighborhood?.nodes.map((node) => node.id) ?? []),
        ...(neighborhood?.links.map((link) => link.id) ?? []),
      ])]
      const anchored = searchesGraph && refreshOwnerIds.length > 0
        ? await this.dependencies.retrieval.findCurrentForOwners(
            graphScope,
            refreshOwnerIds,
            Math.max(maxCandidates, refreshOwnerIds.length),
          )
        : []
      const exact = searchesGraph ? await this.dependencies.retrieval.searchExact(
        { projectId, pendingScopeId: scopeId }, request.query.exactKeys, maxCandidates,
      ) : []
      const semantic = searchesGraphOwners ? await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchText(
        { projectId, pendingScopeId: scopeId }, text, maxCandidates,
      ))) : []
      const sourceIds = [...new Set([...anchored, ...exact]
        .filter((projection) => projection.ownerKind === "source")
        .flatMap((projection) => sourceIdsFromRefs(projection.sourceRefs)))]
      const sourceSemantic = searchesGraph && request.query.sourceKinds.includes("source")
        ? await Promise.all(request.query.semanticTexts.map((text) => this.dependencies.retrieval.searchSourceText(
          { projectId, pendingScopeId: scopeId },
          text,
          maxCandidates,
          sourceIds.length === 0 ? undefined : sourceIds,
        )))
        : []
      const sourceLiteral = searchesGraph && request.query.sourceKinds.includes("source")
        ? await Promise.all(request.query.exactKeys.map((text) => this.dependencies.retrieval.searchSourceText(
          { projectId, pendingScopeId: scopeId },
          text,
          maxCandidates,
          sourceIds.length === 0 ? undefined : sourceIds,
        )))
        : []
      const sourceOnly = request.query.sourceKinds.every((kind) => kind === "source")
      const primarySourceMatch = [...sourceSemantic, ...sourceLiteral].find((matches) => matches.length > 0)?.[0]
      const sourceNeighborhoodRadius = Math.max(0, Math.floor((maxCandidates - 1) / 2))
      const sourceNeighborhood = !sourceOnly || primarySourceMatch === undefined
        ? []
        : await this.dependencies.retrieval.expandSourceNeighborhood(
          { projectId, pendingScopeId: scopeId },
          sourceSequenceAnchorsFromRefs(primarySourceMatch.sourceRefs),
          sourceNeighborhoodRadius,
          maxCandidates,
        )
      const sourceBoundary = !request.query.sourceKinds.includes("source")
        || request.query.sourceBoundary === undefined
        || (request.query.sourceIds?.length ?? 0) === 0
        ? []
        : await this.dependencies.retrieval.readSourceBoundary(
          { projectId, pendingScopeId: scopeId },
          request.query.sourceIds ?? [],
          request.query.sourceBoundary,
          maxCandidates,
        )
      const orderedCandidates = sourceOnly
        ? [...sourceBoundary, ...sourceNeighborhood, ...exact, ...sourceLiteral.flat(), ...anchored, ...sourceSemantic.flat()]
        : [...sourceBoundary, ...anchored, ...exact, ...sourceLiteral.flat(), ...sourceNeighborhood, ...sourceSemantic.flat(), ...semantic.flat()]
      const eligibleCandidates = orderedCandidates.filter((projection) => (
        projectionMatchesRequestedSourceKinds(projection, request.query.sourceKinds)
      ))
      const projections = selectRetrievalProjections(
        eligibleCandidates,
        maxCandidates,
        request.query.sourceKinds,
      )
      const projectedGraphOwnerIds = new Set(projections
        .filter((projection) => projection.ownerKind === "node" || projection.ownerKind === "link")
        .map((projection) => `${projection.ownerKind}:${projection.ownerId}`))
      const graphFallbackCandidates = neighborhood === undefined ? [] : [
        ...neighborhood.nodes.map((node) => ({ ownerKind: "node" as const, ownerId: node.id, value: node })),
        ...neighborhood.links.map((link) => ({ ownerKind: "link" as const, ownerId: link.id, value: link })),
      ].filter((candidate) => !projectedGraphOwnerIds.has(`${candidate.ownerKind}:${candidate.ownerId}`))
        .slice(0, Math.max(0, maxCandidates - projections.length))
      const sourceUnitIds = [...new Set(projections
        .filter((projection) => projection.ownerKind === "source")
        .flatMap((projection) => sourceUnitIdsFromRefs(projection.sourceRefs)))]
      const settlements = await this.dependencies.persistence.listSettlementsForSourceUnits(projectId, sourceUnitIds)
      const sourceProjectionCount = projections.filter((projection) => projection.ownerKind === "source").length
      const maxRelatedOwnersPerSourceUnit = sourceProjectionCount === 0
        ? 0
        : Math.max(1, Math.ceil(maxCandidates / sourceProjectionCount))
      const relatedOwnersBySourceUnitId = await enrichRelatedOwners(
        this.dependencies.retrieval,
        projectId,
        indexRelatedOwnersBySourceUnitId(settlements),
        maxRelatedOwnersPerSourceUnit,
      )
      this.log("debug", "retrieval.request.completed", {
        taskId: context.taskId,
        requestId: request.requestId,
        requestedCandidates: request.query.maxCandidates,
        maxCandidates,
        requestedDepth: request.query.maxDepth,
        maxDepth,
        anchorMatches: anchored.length,
        exactMatches: exact.length,
        semanticMatches: semantic.flat().length,
        sourceLiteralMatches: sourceLiteral.flat().length,
        sourceSemanticMatches: sourceSemantic.flat().length,
        sourceNeighborhoodMatches: sourceNeighborhood.length,
        sourceBoundaryMatches: sourceBoundary.length,
        requestedSourceBoundary: request.query.sourceBoundary,
        sourceNeighborhoodRadius,
        workspaceMatches: workspaceEntries.length,
        orderedCandidateCount: orderedCandidates.length,
        eligibleCandidateCount: eligibleCandidates.length,
        uniqueEligibleCandidateCount: new Set(eligibleCandidates.map((projection) => projection.projectionId)).size,
        duplicateOrOverflowCandidateCount: Math.max(0, eligibleCandidates.length - projections.length),
        selectedCandidates: projections.length,
        selectedCandidateProfile: profileRetrievalCandidates(projections, {
          anchored,
          exact,
          semantic: semantic.flat(),
          sourceLiteral: sourceLiteral.flat(),
          sourceSemantic: sourceSemantic.flat(),
          sourceNeighborhood,
          sourceBoundary,
        }),
        selectedEvidenceProfile: profileRetrievalProjectionEvidence(projections),
        requestedSourceKinds: request.query.sourceKinds,
        exactKeyCount: request.query.exactKeys.length,
        semanticTextCount: request.query.semanticTexts.length,
        anchorIdCount: request.query.anchorIds.length,
        neighborhoodNodeCount: neighborhood?.nodes.length ?? 0,
        neighborhoodLinkCount: neighborhood?.links.length ?? 0,
        neighborhoodTruncated: neighborhood?.truncated ?? false,
        elapsedMs: this.dependencies.now() - retrievalRequestStartedAtMs,
      })
      const enrichExistingEvidenceReturnPath = (
        existing: TurnReadEvidence,
        relatedOwnerRefs: readonly RelatedOwnerRef[],
        sourcePosition: TurnReadEvidence["sourcePosition"],
      ): void => {
        const needsRelatedOwners = (existing.relatedOwnerRefs?.length ?? 0) === 0 && relatedOwnerRefs.length > 0
        const needsSourcePosition = existing.sourcePosition === undefined && sourcePosition !== undefined
        if (!needsRelatedOwners && !needsSourcePosition) return
        const selectedRelatedOwnerRefs = relatedOwnerRefs.slice(0, maxRelatedOwnersPerSourceUnit)
        const enriched = {
          ...existing,
          ...(needsRelatedOwners ? { relatedOwnerRefs: selectedRelatedOwnerRefs } : {}),
          ...(needsSourcePosition ? { sourcePosition } : {}),
        }
        const evidenceIndex = evidence.findIndex((item) => item.readId === existing.readId)
        const oldEstimate = evidenceIndex >= 0 || budgetEvidence.some((item) => item.readId === existing.readId)
          ? estimateRetrievalEvidenceTokens(existing)
          : 0
        const enrichedEstimate = estimateRetrievalEvidenceTokens(enriched)
        if (evidenceTokens - oldEstimate + enrichedEstimate > evidenceTokenLimit) {
          omittedRelatedOwnerRefs += selectedRelatedOwnerRefs.length
          evidenceBudgetTruncated = true
          return
        }
        evidenceTokens = evidenceTokens - oldEstimate + enrichedEstimate
        includedRelatedOwnerRefs += selectedRelatedOwnerRefs.length
        if (evidenceIndex >= 0) evidence[evidenceIndex] = enriched
        else evidence.push(enriched)
      }
      const exposeExistingEvidence = (existing: TurnReadEvidence): void => {
        if (!visibleReadIds.has(existing.readId) && !evidence.some((item) => item.readId === existing.readId)) {
          evidence.push(existing)
        }
        requestReadRefs.add(existing.readId)
        if (existing.ownerKind === "node" || existing.ownerKind === "link") {
          requestGraphRefs.add(existing.ownerId)
        }
      }
      for (const projection of projections) {
        if (projection.visibility === "retired") continue
        if (projection.ownerKind === "node" || projection.ownerKind === "link") {
          requestGraphRefs.add(projection.ownerId)
        }
        if (seenReadIds.has(projection.projectionId)) {
          const existing = evidence.find((item) => item.ownerId === projection.ownerId && item.digest === projection.digest)
          if (existing !== undefined) {
            exposeExistingEvidence(existing)
            const relatedOwnerRefs = projection.ownerKind === "source"
              ? relatedOwnersForProjection(projection.sourceRefs, relatedOwnersBySourceUnitId)
              : []
            enrichExistingEvidenceReturnPath(existing, relatedOwnerRefs, projection.sourcePosition)
          }
          continue
        }
        const evidenceKey = `${projection.ownerId}:${projection.digest}`
        if (seenEvidenceKeys.has(evidenceKey)) {
          const existing = [...existingEvidence, ...evidence].find((item) => `${item.ownerId}:${item.digest}` === evidenceKey)
          if (existing !== undefined) {
            exposeExistingEvidence(existing)
            const relatedOwnerRefs = projection.ownerKind === "source"
              ? relatedOwnersForProjection(projection.sourceRefs, relatedOwnersBySourceUnitId)
              : []
            enrichExistingEvidenceReturnPath(existing, relatedOwnerRefs, projection.sourcePosition)
          }
          continue
        }
        const availableRelatedOwnerRefs = projection.ownerKind === "source"
          ? relatedOwnersForProjection(projection.sourceRefs, relatedOwnersBySourceUnitId)
          : []
        const evidenceBudgetView = {
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
          sourcePosition: projection.sourcePosition,
        }
        let selectedRelatedOwnerRefs: RelatedOwnerRef[] = []
        let tokenEstimate = estimateRetrievalEvidenceTokens(evidenceBudgetView)
        for (const relatedOwnerRef of availableRelatedOwnerRefs) {
          const nextRelatedOwnerRefs = [...selectedRelatedOwnerRefs, relatedOwnerRef]
          const nextEstimate = estimateRetrievalEvidenceTokens({
            ...evidenceBudgetView,
            relatedOwnerRefs: nextRelatedOwnerRefs,
          })
          if (evidenceTokens + nextEstimate > evidenceTokenLimit) {
            omittedRelatedOwnerRefs += 1
            evidenceBudgetTruncated = true
            continue
          }
          selectedRelatedOwnerRefs = nextRelatedOwnerRefs
          tokenEstimate = nextEstimate
          includedRelatedOwnerRefs += 1
        }
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenReadIds.add(projection.projectionId)
        seenEvidenceKeys.add(evidenceKey)
        evidenceTokens += tokenEstimate
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId: await this.nextPersistentId(projectId, "evidence"),
          projectId,
          contextId: context.contextId,
          sourceKind: evidenceSourceKindForProjection(projection),
          ownerId: projection.ownerId,
          version: projection.ownerRevisionId,
          digest: digest(projection.semanticText),
          locator: projection.projectionId,
          content: projection.semanticText,
          readReason: request.reason,
          createdAtMs: this.dependencies.now(),
        })
        returned.push({
          requestId: request.requestId,
          readId: storedEvidence.evidenceId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: projection.visibility === "pending" ? "pending_artifact" : "committed_read",
            ownerIds: [storedEvidence.evidenceId],
            visibility: projection.visibility,
            canonicalDigest: storedEvidence.digest,
            tokenEstimate,
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push({
          readId: storedEvidence.evidenceId,
          visibility: projection.visibility,
          ownerKind: projection.ownerKind,
          ownerId: projection.ownerId,
          revisionId: projection.ownerRevisionId,
          exactKeys: projection.exactKeys,
          semanticText: projection.semanticText,
          sourceRefs: projection.sourceRefs,
          ...(selectedRelatedOwnerRefs.length === 0 ? {} : { relatedOwnerRefs: selectedRelatedOwnerRefs }),
          digest: projection.digest,
          ...(projection.stateRole === undefined ? {} : { stateRole: projection.stateRole }),
          ...(projection.committedSequence === undefined ? {} : { committedSequence: projection.committedSequence }),
          ...(projection.sourcePosition === undefined ? {} : { sourcePosition: projection.sourcePosition }),
        })
        requestReadRefs.add(storedEvidence.evidenceId)
      }
      for (const candidate of graphFallbackCandidates) {
        const semanticText = JSON.stringify(candidate.value)
        const graphDigest = digest(semanticText)
        const evidenceKey = `${candidate.ownerId}:${graphDigest}`
        if (seenEvidenceKeys.has(evidenceKey)) {
          const existing = [...existingEvidence, ...evidence].find((item) => (
            item.ownerId === candidate.ownerId && item.digest === graphDigest
          ))
          if (existing !== undefined) exposeExistingEvidence(existing)
          continue
        }
        const tokenEstimate = estimateRetrievalEvidenceTokens({
          ownerKind: candidate.ownerKind,
          ownerId: candidate.ownerId,
          exactKeys: [candidate.ownerId],
          semanticText,
        })
        if (evidenceTokens + tokenEstimate > evidenceTokenLimit) {
          evidenceBudgetTruncated = true
          continue
        }
        seenEvidenceKeys.add(evidenceKey)
        evidenceTokens += tokenEstimate
        const storedEvidence = await this.dependencies.evidence.writeImmutable({
          evidenceId: await this.nextPersistentId(projectId, "evidence"),
          projectId,
          contextId: context.contextId,
          sourceKind: "graph",
          ownerId: candidate.ownerId,
          version: graphDigest,
          digest: graphDigest,
          locator: `graph://${candidate.ownerKind}/${candidate.ownerId}`,
          content: semanticText,
          readReason: request.reason,
          createdAtMs: this.dependencies.now(),
        })
        returned.push({
          requestId: request.requestId,
          readId: storedEvidence.evidenceId,
          reason: request.reason,
          segment: {
            segmentId: this.dependencies.createId(),
            kind: "committed_read",
            ownerIds: [storedEvidence.evidenceId],
            visibility: "committed",
            canonicalDigest: storedEvidence.digest,
            tokenEstimate,
            sequence: context.segments.length + returned.length,
          },
        })
        evidence.push({
          readId: storedEvidence.evidenceId,
          visibility: "committed",
          ownerKind: candidate.ownerKind,
          ownerId: candidate.ownerId,
          exactKeys: [candidate.ownerId],
          semanticText,
          sourceRefs: [],
          digest: graphDigest,
          stateRole: "current",
        })
        requestReadRefs.add(storedEvidence.evidenceId)
        requestGraphRefs.add(candidate.ownerId)
      }
      const readExecution = {
        requestId: request.requestId,
        operationId: request.requestId,
        returnedReadRefs: [...requestReadRefs],
        returnedGraphRefs: [...requestGraphRefs],
        resultDigest: digest({
          requestId: request.requestId,
          query: request.query,
          returnedReadRefs: [...requestReadRefs],
          returnedGraphRefs: [...requestGraphRefs],
        }),
      }
      readExecutions.push(readExecution)
      const contextRead = {
        requestId: request.requestId,
        returned: returned
          .filter((item) => item.requestId === request.requestId)
          .map(({ requestId: ignoredRequestId, ...item }) => {
            void ignoredRequestId
            return item
          }),
        rejectedReadIds: [],
      }
      nextContext = recordContextRead(nextContext, contextRead)
      await onReadExecution?.(request, readExecution, evidence.slice(evidenceStartIndex), contextRead)
    }
    if (omittedRelatedOwnerRefs > 0) {
      this.log("debug", "retrieval.related_owner_budget.truncated", {
        taskId: context.taskId,
        includedRelatedOwnerRefs,
        omittedRelatedOwnerRefs,
        evidenceTokens,
        maxEvidenceTokens: evidenceTokenLimit,
      })
    }
    if (evidenceBudgetTruncated) {
      this.log("debug", "retrieval.evidence_budget.reached", {
        taskId: context.taskId,
        evidenceTokens,
        maxEvidenceTokens: evidenceTokenLimit,
        selectedEvidenceCount: evidence.length,
      })
    }
    return { context: nextContext, evidence, readExecutions, currentGraphRevisions: [...currentGraphRevisions.values()] }
  }

  private async collectWebResearchEvidence(input: Readonly<{
    request: PhaseResultEnvelope["requestedReads"][number]
    maxWebResults: number
  }>): Promise<Array<TurnReadEvidence & { locator: string }>> {
    const port = this.dependencies.webResearch
    if (port === undefined || input.maxWebResults <= 0) return []
    const urlKeys = input.request.query.exactKeys.filter(looksLikeHttpUrl)
    const searchQueries = [
      ...input.request.query.semanticTexts,
      ...input.request.query.exactKeys.filter((key) => !looksLikeHttpUrl(key)),
    ].map((query) => query.trim()).filter((query) => query.length > 0)
    const uniqueQueries = [...new Set(searchQueries)]
    const collected: Array<TurnReadEvidence & { locator: string }> = []
    const seenOwners = new Set<string>()

    for (const url of [...new Set(urlKeys)]) {
      if (collected.length >= input.maxWebResults) break
      const page = await port.fetchPage({ url })
      if (page === undefined) continue
      const ownerId = page.url
      if (seenOwners.has(ownerId)) continue
      seenOwners.add(ownerId)
      const semanticText = formatWebPageEvidence(page)
      const contentDigest = digest(semanticText)
      collected.push({
        readId: "budget-preview",
        visibility: "committed",
        ownerKind: "web:page",
        ownerId,
        exactKeys: [page.url, page.title],
        semanticText,
        sourceRefs: [{ sourceKind: "web", url: page.url, title: page.title }],
        digest: contentDigest,
        locator: `web://${page.url}`,
      })
    }

    for (const query of uniqueQueries) {
      if (collected.length >= input.maxWebResults) break
      const remaining = input.maxWebResults - collected.length
      const hits = await port.search({ query, maxResults: remaining })
      for (const hit of hits) {
        if (collected.length >= input.maxWebResults) break
        if (seenOwners.has(hit.url)) continue
        seenOwners.add(hit.url)
        const semanticText = formatWebSearchHitEvidence(query, hit)
        const contentDigest = digest(semanticText)
        collected.push({
          readId: "budget-preview",
          visibility: "committed",
          ownerKind: "web:search",
          ownerId: hit.url,
          exactKeys: [hit.url, hit.title, query],
          semanticText,
          sourceRefs: [{ sourceKind: "web", url: hit.url, title: hit.title, query }],
          digest: contentDigest,
          locator: `web-search://${encodeURIComponent(query)}#${encodeURIComponent(hit.url)}`,
        })
      }
    }

    this.log("debug", "retrieval.web.completed", {
      requestId: input.request.requestId,
      queryCount: uniqueQueries.length,
      urlCount: urlKeys.length,
      returnedCount: collected.length,
      maxWebResults: input.maxWebResults,
    })
    return collected
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    this.dependencies.diagnostics?.log(level, event, fields)
  }

  private nextPersistentId(projectId: ProjectId, prefix: PersistentIdPrefix): Promise<string> {
    return this.dependencies.idAllocator?.next(projectId, prefix)
      ?? Promise.resolve(this.dependencies.createId())
  }

  private parseAndValidatePhaseArtifact(
    phase: AIPhase,
    artifact: unknown,
    taskId: string,
    phaseRunId: string,
    sourceUnitCount: number,
  ): unknown {
    const parsedArtifact = parsePhaseArtifact(phase, artifact)
    this.assertDraftCanBePublished(phase, parsedArtifact, taskId, phaseRunId)
    this.assertGraphStructureCanAdvance(phase, parsedArtifact, taskId, phaseRunId, sourceUnitCount)
    return parsedArtifact
  }

  private assertGraphStructureCanAdvance(
    phase: AIPhase,
    artifact: unknown,
    taskId: string,
    phaseRunId: string,
    sourceUnitCount: number,
  ): void {
    if (phase !== "graph_structure_plan" || sourceUnitCount === 0) return
    const structure = graphStructurePlanArtifactSchema.parse(artifact)
    if (structure.proposals.length > 0) return
    this.log("error", "graph.structure.empty_rejected", {
      taskId,
      phase,
      phaseRunId,
      sourceUnitCount,
      reason: "A persisted narrative turn cannot advance without at least one graph proposal",
    })
    throw new Error("Graph structure plan cannot be empty when the turn has persisted narrative source units")
  }

  private assertDraftCanBePublished(
    phase: AIPhase,
    artifact: unknown,
    taskId: string,
    phaseRunId: string,
  ): void {
    if (phase !== "draft") return
    const draft = internalDraftArtifactSchema.parse(artifact)
    const content = draft.contentMarkdown.trim()
    const placeholderPattern = /等待读取|尚未开始(?:撰写|生成)|无法(?:撰写|生成)(?:正文)?|不能(?:撰写|生成)(?:正文)?|待补充(?:资料|设定)/u
    if (!placeholderPattern.test(content)) return
    this.log("error", "draft.placeholder_rejected", {
      taskId,
      phase,
      phaseRunId,
      contentLength: content.length,
      reason: "Draft contains a waiting or refusal placeholder instead of substantive prose",
    })
    throw new Error("Draft content is a waiting/refusal placeholder; the model must write substantive prose even when old evidence is missing")
  }

  private async persistDraftUnits(
    input: TurnOrchestratorInput,
    scopeId: string,
    sourceId: string,
    artifacts: Partial<Record<AIPhase, unknown>>,
  ): Promise<string[]> {
    const draft = internalDraftArtifactSchema.parse(artifacts.draft)
    const parsedNaming = artifacts.chapter_naming === undefined ? undefined : chapterNamingArtifactSchema.parse(artifacts.chapter_naming)
    const naming = parsedNaming === undefined ? undefined : {
      ...parsedNaming,
      heading: normalizeChapterHeading(parsedNaming.heading),
    }
    const content = naming === undefined ? draft.contentMarkdown : assembleChapterDocument(naming.heading, draft.contentMarkdown)
    const units = splitSourceUnits(content)
    const sourceUnits = await Promise.all(units.map(async (contentMarkdown, sequence) => {
      const id = this.dependencies.createId()
      const contentRef = await this.dependencies.internalStore.writeImmutableDocument(input.internalStore, id, contentMarkdown)
      return {
        id,
        projectId: input.projectId,
        sourceId,
        sequence,
        contentRef,
        digest: digest(contentMarkdown),
        createdAtMs: this.dependencies.now(),
      }
    }))
    await this.dependencies.documents.stageSourceUnits(sourceUnits)
    for (const [index, unit] of sourceUnits.entries()) {
      const contentMarkdown = units[index]
      if (contentMarkdown === undefined) throw new Error(`Missing staged source unit content: ${String(index)}`)
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId: input.projectId,
        scopeId,
        ownerKind: "source",
        ownerId: unit.id,
        ownerRevisionId: unit.id,
        exactKeys: buildSourceUnitExactKeys(contentMarkdown),
        semanticText: contentMarkdown,
        sourceRefs: [{ sourceId, sourceUnitId: unit.id, sequence: unit.sequence }],
        digest: unit.digest,
      })
    }
    return sourceUnits.map((unit) => unit.id)
  }

  private async stageDocument(
    input: TurnOrchestratorInput,
    sourceId: string,
    scopeId: string,
    naming: ReturnType<typeof chapterNamingArtifactSchema.parse>,
    contentRef: string,
    content: string,
    createdAtMs: number,
  ): Promise<void> {
    const publishPath = await this.resolveUniqueChapterPublishPath(
      input.workspaceRootRef,
      naming.heading,
      naming.volumeFolderName,
    )
    const contentDigest = digest(content)
    const existing = await this.dependencies.documents.findVersion(input.projectId, sourceId, scopeId)
    if (existing !== undefined) {
      if (existing.contentRef !== contentRef
        || existing.heading !== naming.heading
        || existing.publishPath !== publishPath
        || existing.digest !== contentDigest) {
        throw new Error(`Pending document version does not match the resumed turn: ${sourceId}`)
      }
      return
    }
    const chapterId = this.dependencies.createId()
    await this.dependencies.documents.stageVersion({
      id: chapterId,
      projectId: input.projectId,
      scopeId,
      sourceId,
      chapterId,
      contentRef,
      heading: naming.heading,
      publishPath,
      digest: contentDigest,
      createdAtMs,
    })
  }

  private async resolveUniqueChapterPublishPath(
    workspaceRootRef: string,
    heading: string,
    volumeFolderName: string,
  ): Promise<string> {
    const existingVolumes = await this.dependencies.workspace.listVolumeFolderNames(workspaceRootRef)
    const uniqueness = assertUniqueVolumeSequence(volumeFolderName, existingVolumes)
    if (!uniqueness.ok) {
      throw new Error(uniqueness.reason)
    }
    return deriveChapterPublishPath(heading, volumeFolderName)
  }

  private async stageGraphAndSettlement(
    input: TurnOrchestratorInput,
    taskId: string,
    sourceId: string,
    scopeId: string,
    graphPhaseRunId: string | undefined,
    artifacts: Partial<Record<AIPhase, unknown>>,
    sourceUnitIds: readonly string[],
    readEvidence: readonly TurnReadEvidence[],
    createdAtMs: number,
    mode: "full" | "local" = "full",
  ): Promise<string[]> {
    const governance = graphGovernanceArtifactSchema.parse(artifacts.graph_governance)
    if (mode === "full") {
      emergencePlanningArtifactSchema.parse(artifacts.emergence_planning)
      emergenceReviewArtifactSchema.parse(artifacts.emergence_review)
      const dependencyAudit = dependencyAuditArtifactSchema.parse(artifacts.dependency_audit)
      assertSpacetimeGovernanceCoverage(dependencyAudit, governance, sourceUnitIds.length)
      const semantic = semanticReviewArtifactSchema.parse(artifacts.semantic_review)
      assertSemanticReviewCoversGovernance(governance, semantic)
      this.log("debug", "turn.semantic_review.advisory", {
        taskId,
        graphStillDiscoverable: semantic.graphStillDiscoverable,
        graphStillConcise: semantic.graphStillConcise,
        continuityPreserved: semantic.continuityPreserved,
        spacetimeContinuityPreserved: semantic.spacetimeContinuityPreserved,
        sceneInventoryComplete: semantic.sceneInventoryComplete,
        rejectedMutationIndexes: semantic.rejectedMutationIndexes,
        rejectedSpacetimeBindingIndexes: semantic.rejectedSpacetimeBindingIndexes,
        rejectedMutationSpacetimeSettlementIndexes: semantic.rejectedMutationSpacetimeSettlementIndexes,
        rejectedAffectedFrontierRefs: semantic.rejectedAffectedFrontierRefs,
        verificationProbeCount: semantic.verificationProbeAssessments.length,
      })
    }
    const readableGraphIds = new Set(readEvidence
      .filter((evidence) => evidence.ownerKind === "node" || evidence.ownerKind === "link")
      .map((evidence) => evidence.ownerId))
    const approvedAffectedFrontierRefs = mode === "full"
      ? semanticReviewArtifactSchema.parse(artifacts.semantic_review).approvedAffectedFrontierRefs
      : []
    for (const state of readPriorFrontierStates(readEvidence, approvedAffectedFrontierRefs)) {
      for (const reference of [
        state.frontierAnchorRef,
        ...state.lastSceneAnchorRefs,
        ...state.lastTimeAnchorRefs,
        ...state.lastLocationAnchorRefs,
        ...state.correspondenceRefs,
      ]) readableGraphIds.add(reference)
    }
    assertGraphGovernanceReferenceContract(
      governance,
      readableGraphIds,
      new Set(readEvidence.map((evidence) => evidence.readId)),
    )
    const localReferences = new Map<string, string>()
    for (const mutation of governance.mutations) {
      if (mutation.operation === "create_node" || mutation.operation === "create_link") {
        if (localReferences.has(mutation.ref)) throw new Error(`Duplicate local graph reference: ${mutation.ref}`)
        localReferences.set(
          mutation.ref,
          await this.nextPersistentId(input.projectId, mutation.operation === "create_node" ? "node" : "link"),
        )
      }
    }
    const resolveReference = (reference: string): string => {
      const local = localReferences.get(reference)
      if (local !== undefined) return local
      if (!readableGraphIds.has(reference)) {
        throw new Error(`Graph reference was not read in this turn: ${reference}`)
      }
      return reference
    }
    const sourceRefs = [{
      sourceId,
      taskId,
      taskKind: input.workflow ?? "turn",
    }]
    const mutations: GraphMutation[] = governance.mutations.map((mutation) => {
      switch (mutation.operation) {
        case "create_node":
          return {
            operation: "create_node",
            node: {
              id: resolveReference(mutation.ref),
              content: resolveEmbeddedGraphReferences(mutation.data.content, resolveReference),
              ...(mutation.data.metadata === undefined ? {} : {
                metadata: resolveEmbeddedGraphReferences(mutation.data.metadata, resolveReference) as Record<string, unknown>,
              }),
              sourceRefs,
            },
          }
        case "edit_node":
          return {
            operation: "edit_node",
            nodeId: resolveReference(mutation.nodeRef),
            next: {
              content: resolveEmbeddedGraphReferences(mutation.next.content, resolveReference),
              ...(mutation.next.metadata === undefined ? {} : {
                metadata: resolveEmbeddedGraphReferences(mutation.next.metadata, resolveReference) as Record<string, unknown>,
              }),
              sourceRefs,
            },
          }
        case "retire_node":
          return { operation: "retire_node", nodeId: resolveReference(mutation.nodeRef), archiveOutletIds: mutation.archiveOutletRefs.map(resolveReference) }
        case "create_link":
          return {
            operation: "create_link",
            link: {
              id: resolveReference(mutation.ref),
              fromNodeId: resolveReference(mutation.fromRef),
              toNodeId: resolveReference(mutation.toRef),
              ...(mutation.content === undefined ? {} : { content: resolveEmbeddedGraphReferences(mutation.content, resolveReference) }),
              ...(mutation.metadata === undefined ? {} : { metadata: resolveEmbeddedGraphReferences(mutation.metadata, resolveReference) as Record<string, unknown> }),
              sourceRefs,
            },
          }
        case "edit_link":
          return {
            operation: "edit_link",
            linkId: resolveReference(mutation.linkRef),
            next: {
              fromNodeId: resolveReference(mutation.fromRef),
              toNodeId: resolveReference(mutation.toRef),
              ...(mutation.content === undefined ? {} : { content: resolveEmbeddedGraphReferences(mutation.content, resolveReference) }),
              ...(mutation.metadata === undefined ? {} : { metadata: resolveEmbeddedGraphReferences(mutation.metadata, resolveReference) as Record<string, unknown> }),
              sourceRefs,
            },
          }
        case "retire_link":
          return { operation: "retire_link", linkId: resolveReference(mutation.linkRef), archiveOutletIds: mutation.archiveOutletRefs.map(resolveReference) }
      }
    })
    const revisions: GraphRevision[] = []
    const revisionByMutation = new Map<number, string>()
    for (const [index, mutation] of mutations.entries()) {
      const revision = await this.materializeMutation(
        input.projectId,
        scopeId,
        mutation,
        governance,
        index,
        readEvidence.map((evidence) => evidence.readId),
        createdAtMs,
      )
      revisions.push(revision)
      revisionByMutation.set(index, revision.revisionId)
    }
    await this.dependencies.graph.stageRevisions(input.projectId, scopeId, revisions)
    const stagedProfile = await this.dependencies.graph.getDegreeProfile({
      projectId: input.projectId,
      pendingScopeId: scopeId,
    })
    const graphSettings = input.projectSettings?.graph ?? defaultProjectSettings.graph
    const stagedViolations = findGraphCapacityViolations(stagedProfile, graphSettings)
    this.log(stagedViolations.length === 0 ? "debug" : "error", "graph.capacity.staged_verified", {
      taskId,
      scopeId,
      nodeCount: stagedProfile.nodeCount,
      linkCount: stagedProfile.linkCount,
      maxDirectInDegree: graphSettings.maxDirectInDegree,
      maxDirectOutDegree: graphSettings.maxDirectOutDegree,
      violations: stagedViolations,
      hotspots: stagedProfile.entries.slice(0, 12),
    })
    if (stagedViolations.length > 0) {
      await this.dependencies.commit.resetPending(scopeId)
      throw new GraphCapacityExceededError(stagedViolations)
    }
    const revisionByOwner = new Map(revisions.map((revision) => [
      `${revision.targetKind}:${revision.targetId}`,
      revision.revisionId,
    ]))
    await this.stageInheritedMutationProjections(
      input.projectId,
      scopeId,
      mutations,
      governance.retrievalProjections,
      revisionByMutation,
      sourceRefs,
    )
    const sceneBindingIds = new Map<number, string>()
    const sceneBindings: SceneSpacetimeBindingRecord[] = governance.sceneSpacetimeBindings.map((binding) => {
      const id = this.dependencies.createId()
      sceneBindingIds.set(binding.sceneIndex, id)
      return {
        id,
        projectId: input.projectId,
        scopeId,
        sourceId,
        sceneIndex: binding.sceneIndex,
        sceneAnchorId: resolveReference(binding.sceneAnchorRef),
        sourceUnitIndexes: binding.sourceUnitIndexes,
        temporalReferenceRefs: binding.temporalReferenceRefs.map(resolveReference),
        timeAnchorRefs: binding.timeAnchorRefs.map(resolveReference),
        spatialReferenceRefs: binding.spatialReferenceRefs.map(resolveReference),
        locationAnchorRefs: binding.locationAnchorRefs.map(resolveReference),
        predecessorSceneIndexes: binding.predecessorSceneIndexes,
        predecessorSceneRefs: binding.predecessorSceneAnchorRefs.map(resolveReference),
        transitionPathRefs: binding.transitionPathRefs.map(resolveReference),
        correspondenceRefs: binding.correspondenceRefs.map(resolveReference),
        reason: binding.explanation,
        selfReview: binding.selfReview,
        visibility: "pending",
        digest: digest(binding),
        createdAtMs,
      }
    })
    await this.dependencies.persistence.stageSceneSpacetimeBindings(sceneBindings)
    const revisionSpacetime: GraphRevisionSpacetimeRecord[] = governance.mutationSpacetimeSettlements.flatMap((settlement) => (
      settlement.mutationIndexes
        .filter((mutationIndex) => revisionByMutation.has(mutationIndex))
        .map((mutationIndex) => {
          const graphRevisionId = revisionByMutation.get(mutationIndex)
          if (graphRevisionId === undefined) throw new Error(`Missing graph revision for mutation ${String(mutationIndex)}`)
          const predecessorRevisionIds = settlement.predecessorRevisionReadRefs.flatMap((readId) => {
            const revisionId = resolveReadRevisionId(readId, readEvidence)
            if (revisionId !== undefined) return [revisionId]
            this.log("warn", "turn.predecessor_revision_reference.advisory", {
              taskId,
              readId,
              message: "Ignored a non-revision read evidence reference; the graph revision chain remains authoritative",
            })
            return []
          })
          return {
            id: this.dependencies.createId(),
            projectId: input.projectId,
            scopeId,
            graphRevisionId,
            effectDisposition: settlement.effectDisposition,
            effectiveSceneBindingIds: settlement.effectiveSceneBindingIndexes.map((index) => {
              const bindingId = sceneBindingIds.get(index)
              if (bindingId === undefined) throw new Error(`Missing scene binding for scene ${String(index)}`)
              return bindingId
            }),
            effectiveExistingSceneRefs: settlement.effectiveExistingSceneAnchorRefs.map(resolveReference),
            currentEntryRefs: settlement.currentEntryRefs.map(resolveReference),
            predecessorRevisionRequired: settlement.predecessorRevisionRequired && predecessorRevisionIds.length > 0,
            predecessorRevisionIds,
            historicalReturnRefs: settlement.historicalReturnRefs.map(resolveReference),
            reason: settlement.reason,
            selfReview: settlement.selfReview,
            visibility: "pending" as const,
            digest: digest({ settlement, mutationIndex, graphRevisionId }),
            createdAtMs,
          }
        })
    ))
    await this.dependencies.persistence.stageGraphRevisionSpacetime(revisionSpacetime)
    const resolvedRetrievalProjections = await Promise.all(governance.retrievalProjections.map(async (projection) => {
      const ownerId = projection.ownerMutationIndex === undefined
        ? "ownerRef" in projection && projection.ownerRef !== undefined
          ? resolveReference(projection.ownerRef)
          : undefined
        : mutationTargetId(mutations[projection.ownerMutationIndex])
      if (ownerId === undefined) throw new Error("Projection has no resolvable owner")
      const ownerRevisionId = projection.ownerMutationIndex === undefined
        ? revisionByOwner.get(`${projection.ownerKind}:${ownerId}`)
          ?? (await this.dependencies.graph.listRevisions(input.projectId, projection.ownerKind, ownerId)).at(-1)?.revisionId
        : revisionByMutation.get(projection.ownerMutationIndex)
      if (ownerRevisionId === undefined) throw new Error("Projection has no approved owner revision")
      return {
        projectId: input.projectId,
        scopeId,
        ownerKind: projection.ownerKind,
        ownerId,
        ownerRevisionId,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        sourceRefs,
      }
    }))
    const canonicalRetrievalProjections = canonicalizeRetrievalProjections(resolvedRetrievalProjections)
    for (const projection of canonicalRetrievalProjections) {
      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        ...projection,
        exactKeys: projection.exactKeys,
        semanticText: projection.semanticText,
        digest: digest(projection),
      })
    }
    const records: SettlementRecord[] = governance.settlementRecords.map((record) => ({
      id: this.dependencies.createId(),
      projectId: input.projectId,
      scopeId,
      sourceUnitId: requireSourceUnit(sourceUnitIds, record.sourceUnitIndex),
      graphRefs: record.graphRefs.map((reference) => ({
        targetKind: reference.targetKind,
        targetId: resolveReference(reference.targetRef),
        ...(reference.mutationIndex === undefined ? {} : { revisionId: revisionByMutation.get(reference.mutationIndex) }),
      })),
      reason: record.reason,
      status: record.status,
      digest: digest(record),
      createdAtMs,
    }))
    if (records.some((record) => !sourceUnitIds.includes(record.sourceUnitId))) {
      throw new Error("Settlement record references a source unit outside the current chapter")
    }
    await this.dependencies.persistence.stageSettlementRecords(records)
    if (graphPhaseRunId !== undefined) {
      const decisionRecords: DecisionRecord[] = governance.decisionRecords.map((record) => ({
        id: this.dependencies.createId(),
        projectId: input.projectId,
        taskId,
        scopeId,
        phaseRunId: graphPhaseRunId,
        decisionKind: record.decisionKind,
        reason: record.reason,
        evidenceIds: readEvidence.map((evidence) => evidence.readId),
        payload: {
          ...record.payload as object,
          mutationIndexes: record.mutationIndexes,
          mutationSpacetimeSettlementIndexes: record.mutationSpacetimeSettlementIndexes,
          selfReview: record.selfReview,
        },
        digest: digest(record),
        createdAtMs,
      }))
      await this.dependencies.persistence.stageDecisionRecords(decisionRecords)
    }
    if (mode === "local") {
      return [...new Set(mutations.flatMap((mutation) => {
        switch (mutation.operation) {
          case "create_node": return [mutation.node.id]
          case "edit_node": return [mutation.nodeId]
          case "retire_node": return [mutation.nodeId]
          case "create_link": return [mutation.link.fromNodeId, mutation.link.toNodeId]
          case "edit_link": return [mutation.next.fromNodeId, mutation.next.toNodeId]
          case "retire_link": return []
        }
      }))]
    }
    const frontier = frontierSettlementArtifactSchema.parse(artifacts.frontier_settlement)
    await this.dependencies.persistence.stageFrontiers(frontier.frontiers
      .map((item) => ({
        id: this.dependencies.createId(),
        projectId: input.projectId,
        scopeId,
        frontierAnchorRef: resolveReference(item.frontierAnchorRef),
        disposition: item.disposition,
        lastSceneAnchorRefs: item.lastSceneAnchorRefs.map(resolveReference),
        lastTimeAnchorRefs: item.lastTimeAnchorRefs.map(resolveReference),
        lastLocationAnchorRefs: item.lastLocationAnchorRefs.map(resolveReference),
        correspondenceRefs: item.correspondenceRefs.map(resolveReference),
        lastProcessedAt: createdAtMs,
        reason: item.reason,
        ...(item.revisitCondition === undefined ? {} : { revisitCondition: item.revisitCondition }),
      })))
    const settlementReview = settlementReviewArtifactSchema.parse(artifacts.settlement_review)
    this.log("debug", "turn.settlement_review.advisory", {
      taskId,
      sourceReturnComplete: settlementReview.sourceReturnComplete,
      retrievalProjectionComplete: settlementReview.retrievalProjectionComplete,
      semanticCoverageComplete: settlementReview.semanticCoverageComplete,
      spacetimeBindingsComplete: settlementReview.spacetimeBindingsComplete,
      mutationSpacetimeSettlementsComplete: settlementReview.mutationSpacetimeSettlementsComplete,
      uncoveredSourceUnitIndexes: settlementReview.uncoveredSourceUnitIndexes,
    })
    settlementReview.settledSourceUnitIndexes.forEach((index) => { requireSourceUnit(sourceUnitIds, index) })
    return [...new Set(mutations.flatMap((mutation) => {
      switch (mutation.operation) {
        case "create_node": return [mutation.node.id]
        case "edit_node": return [mutation.nodeId]
        case "retire_node": return [mutation.nodeId]
        case "create_link": return [mutation.link.fromNodeId, mutation.link.toNodeId]
        case "edit_link": return [mutation.next.fromNodeId, mutation.next.toNodeId]
        case "retire_link": return []
      }
    }))]
  }

  private async stageInheritedMutationProjections(
    projectId: string,
    scopeId: string,
    mutations: readonly GraphMutation[],
    projections: GraphGovernanceArtifact["retrievalProjections"],
    revisionByMutation: ReadonlyMap<number, string>,
    sourceRefs: readonly { sourceId: string }[],
  ): Promise<void> {
    for (const [mutationIndex, mutation] of mutations.entries()) {
      if (mutation.operation !== "edit_node" && mutation.operation !== "edit_link") continue
      const ownerId = mutation.operation === "edit_node" ? mutation.nodeId : mutation.linkId
      if (projections.some((projection) => (
        projection.ownerMutationIndex === mutationIndex
        || projection.ownerRef === ownerId
      ))) continue

      const ownerKind = mutation.operation === "edit_node" ? "node" as const : "link" as const
      const revisionId = revisionByMutation.get(mutationIndex)
      if (revisionId === undefined) throw new Error(`Missing revision for mutation ${String(mutationIndex)}`)

      const revisions = await this.dependencies.graph.listRevisions(projectId, ownerKind, ownerId)
      let inherited: Awaited<ReturnType<RetrievalRepository["findForOwnerRevision"]>>
      for (const previousRevision of revisions
        .filter((revision) => revision.revisionId !== revisionId)
        .reverse()) {
        inherited = await this.dependencies.retrieval.findForOwnerRevision(
          projectId,
          ownerKind,
          ownerId,
          previousRevision.revisionId,
        )
        if (inherited !== undefined) break
      }
      if (inherited === undefined) continue

      const currentValue = mutation.operation === "edit_node"
        ? await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, ownerId)
        : await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, ownerId)
      if (currentValue === undefined) throw new Error(`Missing staged graph owner for mutation ${ownerId}`)

      await this.dependencies.retrieval.stageProjection({
        projectionId: this.dependencies.createId(),
        projectId,
        scopeId,
        ownerKind,
        ownerId,
        ownerRevisionId: revisionId,
        exactKeys: inherited.exactKeys,
        semanticText: describeInheritedGraphValue(currentValue, inherited.semanticText),
        sourceRefs: [...inherited.sourceRefs, ...sourceRefs],
        digest: digest({ ownerKind, ownerId, revisionId, inherited: inherited.projectionId, currentValue }),
      })
      this.log("debug", "graph.retrieval_projection.inherited", {
        projectId,
        scopeId,
        ownerKind,
        ownerId,
        revisionId,
        inheritedProjectionId: inherited.projectionId,
      })
    }
  }

  private async materializeMutation(
    projectId: ProjectId,
    scopeId: string,
    mutation: GraphMutation,
    governance: GraphGovernanceArtifact,
    mutationIndex: number,
    evidenceIds: readonly string[],
    createdAtMs: number,
  ): Promise<GraphRevision> {
    const decision = governance.decisionRecords.find((candidate) => candidate.mutationIndexes.includes(mutationIndex))
    if (decision === undefined) {
      throw new Error(`Approved graph mutation ${String(mutationIndex)} has no AI decision record`)
    }
    const { reason, selfReview } = decision
    const targetKind = mutation.operation.endsWith("_node") ? "node" : "link"
    const targetId = "node" in mutation ? mutation.node.id
      : "link" in mutation ? mutation.link.id
      : "nodeId" in mutation ? mutation.nodeId
      : mutation.linkId
    const predecessorRevisionId = (await this.dependencies.graph.listRevisions(projectId, targetKind, targetId)).at(-1)?.revisionId
    const base = {
      revisionId: await this.nextPersistentId(projectId, "revision"),
      scopeId,
      ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
      reason,
      selfReview,
      evidenceIds,
      createdAtMs,
    }
    switch (mutation.operation) {
      case "create_node":
        return { ...base, targetKind: "node", targetId: mutation.node.id, operation: "create", before: null, after: mutation.node, archiveOutletIds: [] }
      case "create_link":
        return { ...base, targetKind: "link", targetId: mutation.link.id, operation: "create", before: null, after: mutation.link, archiveOutletIds: [] }
      case "edit_node": {
        const before = await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, mutation.nodeId)
        if (before === undefined) throw new Error(`Cannot edit missing node: ${mutation.nodeId}`)
        return { ...base, targetKind: "node", targetId: mutation.nodeId, operation: "edit", before, after: { id: mutation.nodeId, ...mutation.next }, archiveOutletIds: [] }
      }
      case "edit_link": {
        const before = await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, mutation.linkId)
        if (before === undefined) throw new Error(`Cannot edit missing link: ${mutation.linkId}`)
        return { ...base, targetKind: "link", targetId: mutation.linkId, operation: "edit", before, after: { id: mutation.linkId, ...mutation.next }, archiveOutletIds: [] }
      }
      case "retire_node": {
        const before = await this.dependencies.graph.getNode({ projectId, pendingScopeId: scopeId }, mutation.nodeId)
        if (before === undefined) throw new Error(`Cannot retire missing node: ${mutation.nodeId}`)
        return { ...base, targetKind: "node", targetId: mutation.nodeId, operation: "retire", before, after: null, archiveOutletIds: mutation.archiveOutletIds }
      }
      case "retire_link": {
        const before = await this.dependencies.graph.getLink({ projectId, pendingScopeId: scopeId }, mutation.linkId)
        if (before === undefined) throw new Error(`Cannot retire missing link: ${mutation.linkId}`)
        return { ...base, targetKind: "link", targetId: mutation.linkId, operation: "retire", before, after: null, archiveOutletIds: mutation.archiveOutletIds }
      }
    }
  }
}

type ExecutePhaseInput = Readonly<{
  input: TurnOrchestratorInput
  inputScopeId: string
  sourceId: string
  sourceUnitIds: readonly string[]
  phase: AIPhase
  phaseRunId: string
  attempt: number
  phaseRunIds: string[]
  context: TurnContext
  artifacts: Partial<Record<AIPhase, unknown>>
  readEvidence: readonly TurnReadEvidence[]
  visibleEvidence: readonly TurnReadEvidence[]
  retrievalGaps: readonly TurnRetrievalGap[]
  verificationProbeCheckpoints: readonly VerificationProbeCheckpoint[]
  catalogSnapshot: WorkspaceCatalogSnapshot
  modelContextChainId: string
  budget: ModelCallBudget
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
  graphCapacityFeedback?: GraphCapacityFeedback
  revisionFeedback?: TurnPhaseInput["revisionFeedback"]
  signal?: AbortSignal
}>

type GraphCapacityFeedback = NonNullable<NonNullable<TurnPhaseInput["graphCapacity"]>["candidateAssessment"]>

type TurnExecutionState = {
  taskId: string
  turnId: string
  scopeId: string
  contextId: string
  sourceId: string
  createdAtMs: number
  baseRuleVersion: string
  modelContextChainId: string
  catalogSnapshot: WorkspaceCatalogSnapshot
  context: TurnContext
  artifacts: Partial<Record<AIPhase, unknown>>
  phaseRunIds: string[]
  phaseRuns: Map<AIPhase, string>
  phaseAttempts: Map<AIPhase, number>
  sourceUnitIds: string[]
  readEvidence: TurnReadEvidence[]
  visibleEvidence: TurnReadEvidence[]
  retrievalGaps: TurnRetrievalGap[]
  verificationProbeCheckpoints: VerificationProbeCheckpoint[]
  totalUsage: PhaseUsage
  budgetWindowUsage: PhaseUsage
  budget: ModelCallBudget
  startPhaseIndex: number
  adaptiveGraphGovernance?: boolean
  graphCapacityFeedback?: GraphCapacityFeedback
  queryDraftAuditRounds: number
  queryRevisionFeedback?: TurnPhaseInput["revisionFeedback"]
  signal?: AbortSignal
}

function restoreVerificationProbeContext(
  context: TurnContext,
  checkpoints: readonly VerificationProbeCheckpoint[],
): TurnContext {
  return checkpoints.reduce((current, checkpoint) => {
    if (current.readLedger.requestedReadIds.includes(checkpoint.contextRead.requestId)) return current
    return recordContextRead(current, checkpoint.contextRead)
  }, context)
}

function restoreContextToPhaseEntry(
  context: TurnContext,
  phaseRunIds: readonly string[],
  entryEvidence: readonly TurnReadEvidence[],
  phase: AIPhase,
): TurnContext {
  void phaseRunIds
  const readableIds = new Set(entryEvidence.map((evidence) => evidence.readId))
  const restored = {
    ...context,
    readLedger: {
      ...context.readLedger,
      committedReadIds: context.readLedger.committedReadIds.filter((readId) => readableIds.has(readId)),
      visiblePendingIds: context.readLedger.visiblePendingIds.filter((readId) => readableIds.has(readId)),
      returnedReadIds: context.readLedger.returnedReadIds.filter((readId) => readableIds.has(readId)),
      readReasons: Object.fromEntries(Object.entries(context.readLedger.readReasons)
        .filter(([readId]) => readableIds.has(readId))),
    },
  }
  if (phase !== "rule_assembly") return restored
  const { ruleSnapshotId: ignoredRuleSnapshotId, ...withoutRuleSnapshot } = restored
  void ignoredRuleSnapshotId
  return withoutRuleSnapshot
}

function throwIfExecutionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw executionCancellationReason(signal)
}

function executionCancellationReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason as unknown
  if (reason instanceof Error) return reason
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "Turn execution cancelled",
  )
  error.name = "AbortError"
  return error
}

function isMandatoryWorkspaceEntry(entry: WorkspaceCatalogEntry): boolean {
  if (entry.entryKind !== "file") return false
  return entry.relativePath === "设定集/readme.md"
    || entry.relativePath === "参考文件/readme.md"
    || entry.relativePath.startsWith("世界推演规则/用户规则/")
}

function filterInheritedModelEvidence(
  evidence: readonly TurnReadEvidence[],
  allowWorkspaceChapterReads: boolean,
): TurnReadEvidence[] {
  return allowWorkspaceChapterReads
    ? [...evidence]
    : evidence.filter((item) => item.ownerKind !== "workspace:chapters")
}

function resolveSelectedPresentationPaths(
  presentation: TurnOrchestratorInput["presentation"],
): readonly string[] {
  if (presentation === undefined) return []
  if (presentation.descriptionRulePath !== undefined
    && !presentation.descriptionRulePath.startsWith("表现输出/描写规则/")) {
    throw new Error(`Description rule must be inside 表现输出/描写规则: ${presentation.descriptionRulePath}`)
  }
  if (presentation.proseStyleRulePath !== undefined
    && !presentation.proseStyleRulePath.startsWith("表现输出/笔风规则/")) {
    throw new Error(`Prose style rule must be inside 表现输出/笔风规则: ${presentation.proseStyleRulePath}`)
  }
  return [
    presentation.descriptionRulePath ?? "表现输出/描写规则/默认描写规则.md",
    presentation.proseStyleRulePath ?? "表现输出/笔风规则/默认笔风规则.md",
  ]
}

function workspaceTurnEvidence(
  readId: string,
  entry: WorkspaceCatalogEntry,
  content: string,
): TurnReadEvidence {
  return {
    readId,
    visibility: "committed",
    ownerKind: `workspace:${entry.role}`,
    ownerId: entry.relativePath,
    exactKeys: [entry.relativePath, entry.relativePath.split("/").at(-1) ?? entry.relativePath],
    semanticText: content,
    sourceRefs: [{ sourceKind: "workspace", relativePath: entry.relativePath, version: entry.version }],
    digest: entry.digest,
  }
}

function looksLikeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function formatWebSearchHitEvidence(
  query: string,
  hit: Readonly<{ title: string; url: string; snippet: string }>,
): string {
  return [
    `# 联网检索结果`,
    ``,
    `- 查询：${query}`,
    `- 标题：${hit.title}`,
    `- URL：${hit.url}`,
    hit.snippet.length === 0 ? undefined : `- 摘要：${hit.snippet}`,
    ``,
    `说明：这是公开互联网资料，仅作背景参考，不能覆盖已提交世界图中的当前状态，也不能直接当作作品内已发生事实。`,
  ].filter((line): line is string => line !== undefined).join("\n")
}

function formatWebPageEvidence(page: Readonly<{ title: string; url: string; text: string }>): string {
  return [
    `# 联网页面摘录`,
    ``,
    `- 标题：${page.title}`,
    `- URL：${page.url}`,
    ``,
    page.text,
    ``,
    `说明：这是公开互联网资料，仅作背景参考，不能覆盖已提交世界图中的当前状态，也不能直接当作作品内已发生事实。`,
  ].join("\n")
}

function resolveGraphReadDirection(
  directions: readonly ("out" | "in" | "both")[],
): "out" | "in" | "both" {
  const unique = new Set(directions)
  if (unique.has("both") || unique.size !== 1) return "both"
  return unique.has("in") ? "in" : "out"
}

function resolveRuleSourceVersions(
  selectedWorkspacePaths: readonly string[],
  evidence: readonly TurnReadEvidence[],
): Readonly<Record<"userRules" | "settingSkills" | "references" | "presentationRules", readonly string[]>> {
  const evidenceByPath = new Map(evidence.map((item) => [item.ownerId, item]))
  const mandatoryPaths = evidence
    .filter((item) => item.ownerKind === "workspace:world_rules"
      || item.ownerId === "设定集/readme.md"
      || item.ownerId === "参考文件/readme.md"
      || item.ownerKind === "workspace:presentation")
    .map((item) => item.ownerId)
  const selected = new Set([...mandatoryPaths, ...selectedWorkspacePaths])
  for (const path of selected) {
    if (!evidenceByPath.has(path)) throw new Error(`Selected workspace path was not read in this turn: ${path}`)
  }
  const idsFor = (ownerKind: string): string[] => [...selected]
    .map((path) => evidenceByPath.get(path))
    .filter((item): item is TurnReadEvidence => item?.ownerKind === ownerKind)
    .map((item) => item.readId)
  return {
    userRules: idsFor("workspace:world_rules"),
    settingSkills: idsFor("workspace:settings"),
    references: idsFor("workspace:references"),
    presentationRules: idsFor("workspace:presentation"),
  }
}

function selectWorkspaceEntries(
  catalogSnapshot: WorkspaceCatalogSnapshot,
  request: PhaseResultEnvelope["requestedReads"][number],
  limit: number,
  allowWorkspaceChapterReads: boolean,
): WorkspaceCatalogEntry[] {
  const roles = new Set<WorkspaceCatalogEntry["role"]>()
  if (request.query.sourceKinds.includes("rule")) roles.add("world_rules")
  if (request.query.sourceKinds.includes("reference")) {
    roles.add("settings")
    roles.add("references")
  }
  if (allowWorkspaceChapterReads && request.query.sourceKinds.includes("source")) roles.add("chapters")
  if (roles.size === 0) return []
  const terms = [...request.query.exactKeys, ...request.query.semanticTexts]
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => term.length > 0)
  return catalogSnapshot.entries
    .filter((entry) => entry.entryKind === "file" && roles.has(entry.role))
    .map((entry) => {
      const path = entry.relativePath.toLocaleLowerCase()
      const filename = path.split("/").at(-1) ?? path
      const score = terms.length === 0 ? 1 : Math.max(0, ...terms.map((term) => (
        path === term ? 100 : filename === term ? 80 : path.includes(term) ? 20 : 0
      )))
      return { entry, score }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || left.entry.relativePath.localeCompare(right.entry.relativePath, "zh-CN"))
    .slice(0, limit)
    .map((candidate) => candidate.entry)
}

function requireSourceUnit(sourceUnitIds: readonly string[], index: number): string {
  const sourceUnitId = sourceUnitIds[index]
  if (sourceUnitId === undefined) throw new Error(`Source unit index is outside the current chapter: ${String(index)}`)
  return sourceUnitId
}

function mutationTargetId(mutation: GraphMutation | undefined): string | undefined {
  if (mutation === undefined) return undefined
  if ("node" in mutation) return mutation.node.id
  if ("link" in mutation) return mutation.link.id
  if ("nodeId" in mutation) return mutation.nodeId
  return mutation.linkId
}

function describeInheritedGraphValue(value: { content?: unknown }, fallback: string): string {
  const content = value.content
  if (typeof content === "string" && content.trim().length > 0) return content
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>
    const preferred = ["semanticText", "text", "summary", "name", "description"]
      .flatMap((key) => typeof record[key] === "string" ? [record[key]] : [])
    if (preferred.length > 0) return preferred.join("；")
  }
  return fallback
}

function resolveReadRevisionId(readId: string, readEvidence: readonly TurnReadEvidence[]): string | undefined {
  const evidence = readEvidence.find((item) => item.readId === readId)
  return evidence?.revisionId
}

type ExecutePhaseResult = Readonly<{
  phaseRunId: string
  context: TurnContext
  readEvidence: readonly TurnReadEvidence[]
  visibleEvidence: readonly TurnReadEvidence[]
  retrievalGaps: readonly TurnRetrievalGap[]
  artifact: unknown
  outcome: PhaseResultEnvelope["outcome"]
  reason: string
  selfReview: string
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; cacheHits: number; cacheMisses: number }
}>

type PhaseUsage = Readonly<{
  modelCalls: number
  inputTokens: number
  outputTokens: number
  cacheHits: number
  cacheMisses: number
}>

function emptyPhaseUsage(): PhaseUsage {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0 }
}

function cacheRateResult(usage: PhaseUsage): Readonly<{ kvCacheHitRate?: number }> {
  const totalCacheTokens = usage.cacheHits + usage.cacheMisses
  return totalCacheTokens === 0 ? {} : { kvCacheHitRate: usage.cacheHits / totalCacheTokens }
}

function assertEvolutionFrontierContinuity(readEvidence: readonly TurnReadEvidence[]): void {
  const frontiers = readEvidence.filter((evidence) => evidence.ownerKind === "frontier")
  if (frontiers.length === 0) return
  const currentGraphOwners = new Set(readEvidence
    .filter((evidence) => (evidence.ownerKind === "node" || evidence.ownerKind === "link")
      && evidence.stateRole === "current")
    .map((evidence) => `${evidence.ownerKind}:${evidence.ownerId}`))
  const hasResolvedFrontier = frontiers.some((frontier) => frontier.relatedOwnerRefs?.some((owner) => (
    currentGraphOwners.has(`${owner.ownerKind}:${owner.ownerId}`)
  )) === true)
  if (!hasResolvedFrontier) {
    throw new Error("committed frontier has no resolvable current graph anchor")
  }
}

function phaseUsageFromExecution(execution: PhaseModelExecution): PhaseUsage {
  return {
    modelCalls: execution.usage.modelCalls ?? 1,
    inputTokens: execution.usage.inputTokens,
    outputTokens: execution.usage.outputTokens,
    cacheHits: execution.usage.cacheHitInputTokens ?? 0,
    cacheMisses: execution.usage.cacheMissInputTokens ?? 0,
  }
}

function phaseUsageFromStored(value: unknown): PhaseUsage {
  if (typeof value !== "object" || value === null) return emptyPhaseUsage()
  const record = value as Record<string, unknown>
  const number = (key: string): number => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : 0
  return {
    modelCalls: number("modelCalls") || (number("inputTokens") > 0 || number("outputTokens") > 0 ? 1 : 0),
    inputTokens: number("inputTokens"),
    outputTokens: number("outputTokens"),
    cacheHits: number("cacheHitInputTokens"),
    cacheMisses: number("cacheMissInputTokens"),
  }
}

function readStoredTurnPhaseInput(value: unknown): TurnPhaseInput {
  if (typeof value !== "object" || value === null) throw new Error("The task checkpoint has invalid phase input")
  const record = value as Record<string, unknown>
  if (typeof record.userInput !== "string" || typeof record.chapterSequence !== "number") {
    throw new Error("The task checkpoint is missing turn input")
  }
  if (!Array.isArray(record.sourceUnitIds)
    || !Array.isArray(record.readEvidence)
    || !Array.isArray(record.retrievalGaps)
    || typeof record.artifacts !== "object"
    || record.artifacts === null) {
    throw new Error("The task checkpoint is missing dynamic turn state")
  }
  return record as unknown as TurnPhaseInput
}

function addPhaseUsage(left: PhaseUsage, right: PhaseUsage): PhaseUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheHits: left.cacheHits + right.cacheHits,
    cacheMisses: left.cacheMisses + right.cacheMisses,
  }
}

function isRecordWithRawResponse(error: unknown): error is { rawResponse: string } {
  return typeof error === "object"
    && error !== null
    && "rawResponse" in error
    && typeof error.rawResponse === "string"
}

function createBudget(input: TurnOrchestratorInput, nowMs: number, elapsedWindowWallTimeMs = 0): ModelCallBudget {
  const requestedCalls = input.maxModelCalls ?? defaultTurnExecutionProfile.maxTurnModelCalls
  const maxCalls = requestedCalls
  const maxInputTokens = input.maxInputTokens ?? Number.MAX_SAFE_INTEGER
  const maxOutputTokens = input.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
  return {
    maxCalls,
    remainingCalls: maxCalls,
    maxInputTokens,
    remainingInputTokens: maxInputTokens,
    maxOutputTokens,
    remainingOutputTokens: maxOutputTokens,
    deadlineAtMs: nowMs + Math.max(1, (input.deadlineMs ?? defaultTurnExecutionProfile.maxTurnWallTimeMs) - elapsedWindowWallTimeMs),
    modelRequestDeadlineAtMs: nowMs + (
      input.projectSettings?.execution.maxModelRequestTimeMs
      ?? defaultProjectSettings.execution.maxModelRequestTimeMs
    ),
    retrievalExecutionDeadlineAtMs: nowMs + (input.retrievalExecutionDeadlineMs ?? 15_000),
    retrievalPhaseDeadlineAtMs: nowMs + (input.retrievalPhaseDeadlineMs ?? 60_000),
  }
}

function resolveContextTokenLimit(
  modelContextWindowTokens: number,
  compactionThresholdRatio: number,
): number {
  const compactionThreshold = Math.max(1, Math.floor(modelContextWindowTokens * compactionThresholdRatio))
  return compactionThreshold
}

function requireModelContextWindowTokens(model: AIModelPort): number {
  const capacity = model.info?.contextWindowTokens
  if (capacity === undefined || !Number.isInteger(capacity) || capacity <= 0) {
    throw new Error("The active model profile does not declare a valid context window")
  }
  return capacity
}

function remainingBudget(
  budget: ModelCallBudget,
  usage: { modelCalls: number; inputTokens: number; outputTokens: number },
): ModelCallBudget {
  return {
    ...budget,
    remainingCalls: Math.max(0, budget.maxCalls - usage.modelCalls),
    remainingInputTokens: Math.max(0, budget.maxInputTokens - usage.inputTokens),
    remainingOutputTokens: Math.max(0, budget.maxOutputTokens - usage.outputTokens),
  }
}

function assertUsageWithinBudget(
  budget: ModelCallBudget,
  usage: { modelCalls: number; inputTokens: number; outputTokens: number },
  nowMs: number,
): void {
  if (usage.modelCalls > budget.maxCalls) throw new TurnBudgetExceededError("model_calls", "Model call budget exceeded")
  if (usage.inputTokens > budget.maxInputTokens) throw new TurnBudgetExceededError("input_tokens", "Model input token budget exceeded")
  if (usage.outputTokens > budget.maxOutputTokens) throw new TurnBudgetExceededError("output_tokens", "Model output token budget exceeded")
  if (nowMs > budget.deadlineAtMs) throw new TurnBudgetExceededError("wall_time", "Turn deadline exceeded")
}

function normalizeDeadlineInterruption(
  error: unknown,
  budget: ModelCallBudget,
  nowMs: number,
): unknown {
  if (error instanceof TurnBudgetExceededError || nowMs <= budget.deadlineAtMs) return error
  return new TurnBudgetExceededError("wall_time", "Turn deadline exceeded while the model request was in flight")
}

function createInterruptionRecord(
  error: unknown,
  phase: AIPhase | undefined,
  phaseRunId: string | undefined,
  interruptedAtMs: number,
): Readonly<Record<string, unknown>> {
  const message = error instanceof Error ? error.message : String(error)
  const blockedMetrics = error instanceof TurnBudgetExceededError ? [error.metric] : []
  return {
    kind: error instanceof GraphCapacityExceededError
      ? "graph_governance_limit_exhausted"
      : blockedMetrics.length === 0 ? "execution_error" : "limit_exhausted",
    message,
    recoverable: true,
    blockedMetrics,
    ...(phase === undefined ? {} : { phase }),
    ...(phaseRunId === undefined ? {} : { phaseRunId }),
    ...(error instanceof GraphCapacityExceededError ? { graphCapacityViolations: error.violations } : {}),
    interruptedAtMs,
  }
}

function readBlockedMetrics(error: unknown): readonly ("model_calls" | "input_tokens" | "output_tokens" | "wall_time")[] {
  if (typeof error !== "object" || error === null || !("blockedMetrics" in error)) return []
  const value = error.blockedMetrics
  if (!Array.isArray(value)) return []
  return value.filter((metric): metric is "model_calls" | "input_tokens" | "output_tokens" | "wall_time" => (
    metric === "model_calls" || metric === "input_tokens" || metric === "output_tokens" || metric === "wall_time"
  ))
}

function readInterruptionTimestamp(error: unknown): number {
  if (typeof error !== "object" || error === null || !("interruptedAtMs" in error)) return Number.MAX_SAFE_INTEGER
  const value = error.interruptedAtMs
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER
}

function readGraphCapacityFeedback(error: unknown): GraphCapacityFeedback | undefined {
  if (typeof error !== "object" || error === null || !("graphCapacityViolations" in error)) return undefined
  const violations = error.graphCapacityViolations
  if (!Array.isArray(violations)) return undefined
  const parsed = violations.flatMap((value) => {
    if (typeof value !== "object" || value === null) return []
    const record = value as Record<string, unknown>
    if (typeof record.nodeId !== "string"
      || typeof record.inDegree !== "number"
      || typeof record.outDegree !== "number"
      || !Array.isArray(record.exceeded)) return []
    const exceeded = record.exceeded.filter((direction): direction is "in" | "out" => (
      direction === "in" || direction === "out"
    ))
    return exceeded.length === 0 ? [] : [{
      nodeId: record.nodeId,
      inDegree: record.inDegree,
      outDegree: record.outDegree,
      exceeded,
    }]
  })
  if (parsed.length === 0) return undefined
  return {
    round: 1,
    nodeCount: 0,
    linkCount: 0,
    violations: parsed,
  }
}

function readRuntimeMetricLimit(
  snapshot: { metrics: readonly { metricId: string; limit: number | null }[] },
  metricId: "model_calls" | "input_tokens" | "output_tokens" | "wall_time",
): number | undefined {
  return snapshot.metrics.find((metric) => metric.metricId === metricId)?.limit ?? undefined
}

function finiteApplicationLimit(value: number): number | null {
  return value >= Number.MAX_SAFE_INTEGER ? null : value
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4))
}

function estimateRetrievalEvidenceTokens(evidence: Readonly<{
  ownerKind: string
  ownerId: string
  exactKeys: readonly string[]
  semanticText: string
  relatedOwnerRefs?: readonly RelatedOwnerRef[]
  sourcePosition?: TurnReadEvidence["sourcePosition"]
}>): number {
  return estimateTokens({
    ownerKind: evidence.ownerKind,
    ownerId: normalizeIdentityForTokenEstimate(evidence.ownerId),
    exactKeys: evidence.exactKeys,
    semanticText: evidence.semanticText,
    ...(evidence.relatedOwnerRefs === undefined ? {} : {
      relatedOwnerRefs: evidence.relatedOwnerRefs.map((relatedOwner) => ({
        ownerKind: relatedOwner.ownerKind,
        ownerId: normalizeIdentityForTokenEstimate(relatedOwner.ownerId),
        ...(relatedOwner.exactKeys === undefined ? {} : { exactKeys: relatedOwner.exactKeys }),
        ...(relatedOwner.semanticText === undefined ? {} : { semanticText: relatedOwner.semanticText }),
      })),
    }),
    ...(evidence.sourcePosition === undefined ? {} : {
      sourcePosition: {
        sourceRef: normalizeIdentityForTokenEstimate(evidence.sourcePosition.sourceRef),
        sequence: evidence.sourcePosition.sequence,
        firstSequence: evidence.sourcePosition.firstSequence,
        lastSequence: evidence.sourcePosition.lastSequence,
        unitCount: evidence.sourcePosition.unitCount,
        isStart: evidence.sourcePosition.isStart,
        isEnd: evidence.sourcePosition.isEnd,
      },
    }),
  })
}

function normalizeIdentityForTokenEstimate(value: string): string {
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:node|link|evidence|source|revision)_[1-9][0-9]*)$/iu.test(value)
    ? "00000000-0000-4000-8000-000000000000"
    : value
}

function sourceUnitIdsFromRefs(sourceRefs: readonly unknown[]): string[] {
  return [...new Set(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef) || typeof sourceRef.sourceUnitId !== "string") return []
    return [sourceRef.sourceUnitId]
  }))]
}

function sourceIdsFromRefs(sourceRefs: readonly unknown[]): string[] {
  return [...new Set(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef) || typeof sourceRef.sourceId !== "string") return []
    return [sourceRef.sourceId]
  }))]
}

function sourceSequenceAnchorsFromRefs(sourceRefs: readonly unknown[]): Array<{
  sourceId: string
  sequence: number
}> {
  return [...new Map(sourceRefs.flatMap((sourceRef) => {
    if (!isRecord(sourceRef)
      || typeof sourceRef.sourceId !== "string"
      || typeof sourceRef.sequence !== "number"
      || !Number.isSafeInteger(sourceRef.sequence)
      || sourceRef.sequence < 0) return []
    return [[`${sourceRef.sourceId}:${String(sourceRef.sequence)}`, {
      sourceId: sourceRef.sourceId,
      sequence: sourceRef.sequence,
    }] as const]
  })).values()]
}

function indexRelatedOwnersBySourceUnitId(
  settlements: readonly SettlementRecord[],
): ReadonlyMap<string, readonly { ownerKind: string; ownerId: string; revisionId?: string }[]> {
  const indexed = new Map<string, Array<{ ownerKind: string; ownerId: string; revisionId?: string }>>()
  for (const settlement of settlements) {
    const owners = indexed.get(settlement.sourceUnitId) ?? []
    if (Array.isArray(settlement.graphRefs)) {
      for (const graphRef of settlement.graphRefs) {
        if (!isRecord(graphRef)) continue
        const ownerKind = typeof graphRef.targetKind === "string"
          ? graphRef.targetKind
          : typeof graphRef.ownerKind === "string" ? graphRef.ownerKind : undefined
        const ownerId = typeof graphRef.targetId === "string"
          ? graphRef.targetId
          : typeof graphRef.ownerId === "string" ? graphRef.ownerId : undefined
        if (ownerKind === undefined || ownerId === undefined) continue
        owners.push({
          ownerKind,
          ownerId,
          ...(typeof graphRef.revisionId === "string" ? { revisionId: graphRef.revisionId } : {}),
        })
      }
    }
    indexed.set(settlement.sourceUnitId, owners)
  }
  return new Map(Array.from(indexed.entries()).map(([sourceUnitId, owners]) => [
    sourceUnitId,
    deduplicateRelatedOwners(owners),
  ]))
}

function relatedOwnersForProjection(
  sourceRefs: readonly unknown[],
  relatedOwnersBySourceUnitId: ReadonlyMap<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[]>,
): readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[] {
  return deduplicateRelatedOwners(sourceUnitIdsFromRefs(sourceRefs).flatMap((sourceUnitId) => (
    relatedOwnersBySourceUnitId.get(sourceUnitId) ?? []
  )))
}

async function enrichRelatedOwners(
  retrieval: RetrievalRepository,
  projectId: ProjectId,
  relatedOwnersBySourceUnitId: ReadonlyMap<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
  }[]>,
  maxOwnersPerSourceUnit: number,
): Promise<ReadonlyMap<string, readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[]>> {
  const enriched = new Map<string, readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[]>()
  for (const [sourceUnitId, owners] of relatedOwnersBySourceUnitId) {
    const selectedOwners = owners.slice(0, maxOwnersPerSourceUnit)
    const withProjections = await Promise.all(selectedOwners.map(async (owner) => {
      if ((owner.ownerKind !== "node" && owner.ownerKind !== "link") || owner.revisionId === undefined) return owner
      const projection = await retrieval.findForOwnerRevision(
        projectId,
        owner.ownerKind,
        owner.ownerId,
        owner.revisionId,
      )
      return projection === undefined
        ? owner
        : {
            ...owner,
            exactKeys: projection.exactKeys,
            semanticText: projection.semanticText,
          }
    }))
    enriched.set(sourceUnitId, withProjections)
  }
  return enriched
}

function deduplicateRelatedOwners(
  owners: readonly {
    ownerKind: string
    ownerId: string
    revisionId?: string
    exactKeys?: readonly string[]
    semanticText?: string
  }[],
): readonly {
  ownerKind: string
  ownerId: string
  revisionId?: string
  exactKeys?: readonly string[]
  semanticText?: string
}[] {
  return Array.from(new Map(owners.map((owner) => [
    `${owner.ownerKind}:${owner.ownerId}:${owner.revisionId ?? ""}`,
    owner,
  ])).values())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function countsAgainstRetrievalEvidenceBudget(evidence: TurnReadEvidence): boolean {
  return !isProtectedContextEvidence(evidence)
}

function profileTurnEvidence(evidence: readonly TurnReadEvidence[]): Record<string, unknown> {
  const byOwnerKind = new Map<string, { count: number; estimatedTokens: number; semanticCharacters: number }>()
  let estimatedTokens = 0
  let semanticCharacters = 0
  let relatedOwnerRefCount = 0
  for (const item of evidence) {
    const itemTokens = estimateRetrievalEvidenceTokens(item)
    estimatedTokens += itemTokens
    semanticCharacters += item.semanticText.length
    relatedOwnerRefCount += item.relatedOwnerRefs?.length ?? 0
    const current = byOwnerKind.get(item.ownerKind) ?? { count: 0, estimatedTokens: 0, semanticCharacters: 0 }
    byOwnerKind.set(item.ownerKind, {
      count: current.count + 1,
      estimatedTokens: current.estimatedTokens + itemTokens,
      semanticCharacters: current.semanticCharacters + item.semanticText.length,
    })
  }
  return {
    count: evidence.length,
    estimatedTokens,
    semanticCharacters,
    relatedOwnerRefCount,
    byOwnerKind: Object.fromEntries([...byOwnerKind.entries()].sort(([left], [right]) => left.localeCompare(right))),
  }
}

function profileRetrievalProjectionEvidence(projections: readonly RetrievalProjection[]): Record<string, unknown> {
  const evidence = projections.map((projection) => ({
    readId: projection.projectionId,
    visibility: projection.visibility === "pending" ? "pending" as const : "committed" as const,
    ownerKind: projection.ownerKind,
    ownerId: projection.ownerId,
    exactKeys: projection.exactKeys,
    semanticText: projection.semanticText,
    sourceRefs: projection.sourceRefs,
    digest: projection.digest,
    ...(projection.stateRole === undefined ? {} : { stateRole: projection.stateRole }),
    ...(projection.committedSequence === undefined ? {} : { committedSequence: projection.committedSequence }),
    ...(projection.sourcePosition === undefined ? {} : { sourcePosition: projection.sourcePosition }),
  }))
  return profileTurnEvidence(evidence)
}

function profileRetrievalCandidates(
  projections: readonly RetrievalProjection[],
  origins: Readonly<Record<"anchored" | "exact" | "semantic" | "sourceLiteral" | "sourceSemantic" | "sourceNeighborhood" | "sourceBoundary", readonly RetrievalProjection[]>>,
): readonly Record<string, unknown>[] {
  const originIds = Object.fromEntries(Object.entries(origins).map(([name, values]) => [
    name,
    new Set(values.map((projection) => projection.projectionId)),
  ])) as Record<string, Set<string>>
  return projections.map((projection, index) => ({
    rank: index + 1,
    projectionId: projection.projectionId,
    ownerKind: projection.ownerKind,
    stateRole: projection.stateRole,
    semanticCharacters: projection.semanticText.length,
    exactKeyCount: projection.exactKeys.length,
    sourceRefCount: projection.sourceRefs.length,
    estimatedTokens: estimateRetrievalEvidenceTokens({
      ownerKind: projection.ownerKind,
      ownerId: projection.ownerId,
      exactKeys: projection.exactKeys,
      semanticText: projection.semanticText,
      sourcePosition: projection.sourcePosition,
    }),
    origins: Object.entries(originIds).flatMap(([name, ids]) => ids.has(projection.projectionId) ? [name] : []),
  }))
}

function isProtectedContextEvidence(evidence: TurnReadEvidence): boolean {
  return evidence.ownerKind === "workspace:world_rules"
    || evidence.ownerKind === "workspace:presentation"
    || evidence.ownerId === "设定集/readme.md"
    || evidence.ownerId === "参考文件/readme.md"
}

function selectCarryForwardEvidence(
  phase: AIPhase,
  inheritedEvidence: readonly TurnReadEvidence[],
  evidence: readonly TurnReadEvidence[],
  citedReadIds: readonly string[],
): TurnReadEvidence[] {
  void phase
  void citedReadIds
  return uniqueTurnReadEvidence([...inheritedEvidence, ...evidence])
}

function uniqueTurnReadEvidence(evidence: readonly TurnReadEvidence[]): TurnReadEvidence[] {
  return mergeEvidenceVersions(evidence)
}

function reconcileCurrentGraphEvidence(
  evidence: readonly TurnReadEvidence[],
  currentRevisions: readonly CurrentGraphOwnerRevision[],
): TurnReadEvidence[] {
  const currentByOwner = new Map(currentRevisions.map((item) => [
    `${item.ownerKind}:${item.ownerId}`,
    item.revisionId,
  ]))
  if (currentByOwner.size === 0) return uniqueTurnReadEvidence(evidence)
  return uniqueTurnReadEvidence(evidence).map((item) => {
    const currentRevisionId = currentByOwner.get(`${item.ownerKind}:${item.ownerId}`)
    if (currentRevisionId === undefined || item.revisionId === currentRevisionId) return item
    return { ...item, stateRole: "historical" as const }
  })
}

function selectPhaseArtifacts(
  phase: AIPhase,
  artifacts: Partial<Record<AIPhase, unknown>>,
  dependencies: Record<AIPhase, readonly AIPhase[]>,
): Partial<Record<AIPhase, unknown>> {
  return Object.fromEntries(dependencies[phase].flatMap((dependency) => (
    artifacts[dependency] === undefined ? [] : [[dependency, artifacts[dependency]]]
  )))
}

function queryReviewDecision(result: Pick<PhaseResultEnvelope, "outcome" | "artifact" | "reason" | "selfReview">): Readonly<{
  requiresRevision: boolean
  review: Readonly<{
    evidenceClosed: boolean
    leaksUnobservedInformation: boolean
    requiresWorkflowUpgrade: boolean
  }>
  feedback: NonNullable<TurnPhaseInput["revisionFeedback"]>
}> {
  const review = parsePhaseArtifact("response_review", result.artifact) as {
    evidenceClosed: boolean
    leaksUnobservedInformation: boolean
    requiresWorkflowUpgrade: boolean
  }
  return {
    requiresRevision: result.outcome === "revise"
      || !review.evidenceClosed
      || review.leaksUnobservedInformation
      || review.requiresWorkflowUpgrade,
    review,
    feedback: {
      phase: "response_review",
      outcome: result.outcome,
      artifact: review,
      reason: result.reason,
      selfReview: result.selfReview,
    },
  }
}

function countFailedQueryReviews(runs: readonly { phase: AIPhase; status: string; result?: unknown }[]): number {
  return runs.filter((run) => {
    if (run.phase !== "response_review" || run.status !== "completed" || run.result === undefined) return false
    const result = phaseResultEnvelopeSchema.safeParse(run.result)
    return result.success && queryReviewDecision(result.data).requiresRevision
  }).length
}

function phaseUsesWorkspaceCatalog(phase: AIPhase): boolean {
  return workspaceCatalogPhases.has(phase)
}

function assertCitationsAreVisible(
  request: PhaseRequestEnvelope,
  citedReadIds: readonly string[],
): void {
  const visibleReadIds = new Set([...request.committedReadIds, ...request.visiblePendingIds])
  const invisibleReadIds = citedReadIds.filter((readId) => !visibleReadIds.has(readId))
  if (invisibleReadIds.length > 0) {
    throw new Error(`citedReadIds contains evidence outside the current model view: ${invisibleReadIds.join(", ")}`)
  }
}

function projectionMatchesRequestedSourceKinds(
  projection: { ownerKind: string },
  sourceKinds: readonly string[],
): boolean {
  if (projection.ownerKind === "source") return sourceKinds.includes("source")
  if (projection.ownerKind === "node" || projection.ownerKind === "link") {
    return sourceKinds.includes("graph") || sourceKinds.includes("revision")
  }
  return false
}

function evidenceSourceKindForProjection(
  projection: { ownerKind: string },
): "chapter" | "graph" | "revision" {
  if (projection.ownerKind === "source") return "chapter"
  if (projection.ownerKind === "revision") return "revision"
  return "graph"
}

function uniqueRetrievalProjections<T extends { projectionId: string }>(
  projections: readonly T[],
  limit: number,
): readonly T[] {
  return [...new Map(projections.map((projection) => [projection.projectionId, projection])).values()].slice(0, limit)
}

function selectRetrievalProjections<T extends { projectionId: string; ownerKind: string }>(
  candidates: readonly T[],
  limit: number,
  sourceKinds: readonly string[],
): readonly T[] {
  const uniqueCandidates = uniqueRetrievalProjections(candidates, candidates.length)
  const mixesGraphAndSource = sourceKinds.includes("source")
    && (sourceKinds.includes("graph") || sourceKinds.includes("revision"))
  if (!mixesGraphAndSource) return uniqueCandidates.slice(0, limit)

  const graphCandidates = uniqueCandidates.filter((candidate) => candidate.ownerKind !== "source")
  const sourceCandidates = uniqueCandidates.filter((candidate) => candidate.ownerKind === "source")
  const selected: T[] = []
  for (let index = 0; selected.length < limit; index += 1) {
    const graphCandidate = graphCandidates[index]
    const sourceCandidate = sourceCandidates[index]
    if (graphCandidate === undefined && sourceCandidate === undefined) break
    if (graphCandidate !== undefined) selected.push(graphCandidate)
    if (sourceCandidate !== undefined && selected.length < limit) selected.push(sourceCandidate)
  }
  return selected
}

function resolveEmbeddedGraphReferences(
  value: unknown,
  resolveReference: (reference: string) => string,
): unknown {
  if (typeof value === "string") {
    return /^local:[a-zA-Z0-9_.-]+$/u.test(value) ? resolveReference(value) : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEmbeddedGraphReferences(item, resolveReference))
  }
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    resolveEmbeddedGraphReferences(item, resolveReference),
  ]))
}

function splitSourceUnits(content: string): string[] {
  return content.split(/\n\s*\n/u).map((unit) => unit.trim()).filter((unit) => unit.length > 0)
}

function formatDeductionGoalTaxonomyPrefix(goal: TurnDeductionGoalBundle["activeGoals"][number]): string {
  const kind = goal.narrativeKind === "foreshadow"
    ? "伏笔"
    : goal.narrativeKind === "climax"
      ? "高潮"
      : "目标"
  const scale = goal.scale === "medium" ? "中" : goal.scale === "long" ? "长" : "短"
  if (goal.narrativeKind === "general" && goal.scale === "short") return ""
  return `[${kind}·${scale}] `
}

function formatDeductionGoalConstraintMarkdown(bundle: TurnDeductionGoalBundle): string {
  const progressByGoal = new Map(
    bundle.chapterProgress.map((item) => [item.goalId, item] as const),
  )
  const lines = bundle.activeGoals.map((goal) => {
    const progress = progressByGoal.get(goal.goalId)
    const expectation = progress === undefined || progress.summary.trim().length === 0
      ? "（未填写本章 planned）"
      : `${progress.summary}${progress.lockedAtMs === undefined ? "" : "（locked）"}`
    return `- ${formatDeductionGoalTaxonomyPrefix(goal)}${goal.content} — 本章预期：${expectation}`
  })
  if (lines.length === 0) {
    return `## 推演目标约束（第 ${String(bundle.chapterSequence)} 章）\n\n（本轮无活跃推演目标）`
  }
  return `## 推演目标约束（第 ${String(bundle.chapterSequence)} 章）\n\n${lines.join("\n")}`
}
