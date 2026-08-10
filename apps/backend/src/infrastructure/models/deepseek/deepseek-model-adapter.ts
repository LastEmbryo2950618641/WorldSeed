import OpenAI from "openai"
import { ProxyAgent } from "undici"

import {
  PROTOCOL_VERSION,
  type PhaseRequestEnvelope,
} from "@worldseed/contracts"
import type { DeepSeekRuntimeConfig } from "@worldseed/config"

import type {
  AIModelPort,
  ModelExecutionOptions,
  PhaseModelExecution,
  PromptResourcePort,
} from "../../../application/index.js"
import {
  assembleModelPhaseResult,
  phaseModelResultJsonSchema,
  parseModelPhaseResult,
} from "./model-phase-result-assembler.js"
import { createModelReferenceView, type ModelReferenceView } from "./model-reference-view.js"
import { errorDetails, runtimeLog } from "../../diagnostics/index.js"

export type SecretProvider = Readonly<{
  getSecret(reference: string): Promise<string>
}>

export type DeepSeekCompletionClient = Readonly<{
  complete(input: DeepSeekCompletionInput): Promise<DeepSeekCompletionResponse>
}>

export type DeepSeekCompletionInput = Readonly<{
  model: string
  messages: readonly DeepSeekMessage[]
  responseFormat?: { type: "json_object" }
  maxTokens?: number
  signal?: AbortSignal
  thinking?: { type: "enabled" | "disabled" }
  reasoningEffort?: "low" | "high" | "max"
}>

export type DeepSeekMessage = Readonly<{
  role: "system" | "user" | "assistant"
  content: string
}>

export type DeepSeekCompletionResponse = Readonly<{
  content: string | null
  reasoningContent?: string | null
  finishReason?: string | null
  responseId?: string
  messageFieldNames?: readonly string[]
  usage?: unknown
}>

export class DeepSeekModelError extends Error {
  public constructor(
    public readonly kind: "configuration" | "network" | "response" | "schema",
    message: string,
    public readonly rawResponse?: string,
  ) {
    super(message)
  }
}

export class DeepSeekAiModelAdapter implements AIModelPort {
  private readonly clientPromise: Promise<DeepSeekCompletionClient>
  public readonly info

  public constructor(
    private readonly config: DeepSeekRuntimeConfig,
    private readonly secrets: SecretProvider,
    private readonly prompts: PromptResourcePort,
    client?: DeepSeekCompletionClient,
  ) {
    this.info = {
      provider: config.provider,
      model: config.model,
      available: true,
      contextWindowTokens: config.contextWindowTokens,
    } as const
    this.clientPromise = client === undefined ? this.createClient() : Promise.resolve(client)
  }

  public async execute(request: PhaseRequestEnvelope, options?: ModelExecutionOptions): Promise<PhaseModelExecution> {
    const referenceView = createModelReferenceView(request)
    runtimeLog("debug", "deepseek-model", "execution.started", {
      taskId: request.taskId,
      phase: request.phase,
      envelopeId: request.envelopeId,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      modelReferenceAliasCount: referenceView.aliasCount,
      deadlineRemainingMs: request.remainingBudget.deadlineAtMs - Date.now(),
    })
    const [baseRules, phasePrompt, client] = await Promise.all([
      this.prompts.loadBaseRules(),
      this.prompts.loadPhase(request.phase),
      this.clientPromise,
    ])
    const messages: DeepSeekMessage[] = [
      { role: "system", content: baseRules.text },
      { role: "system", content: phasePrompt.text },
      {
        role: "system",
        content: [
          `Worldseed protocol ${PROTOCOL_VERSION}.`,
          `Current phase: ${request.phase}.`,
          "Return exactly one JSON object and no Markdown fences or commentary.",
          "The final user message contains the complete mandatory output contract.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
           "Current model-facing turn request JSON (reference values are aliases; do not invent aliases):",
           JSON.stringify(referenceView.request),
           buildOutputReminder(request, referenceView),
        ].join("\n\n"),
      },
    ]
    let lastError: unknown
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let cacheHitInputTokens = 0
    let cacheMissInputTokens = 0
    let hasCacheHit = false
    let hasCacheMiss = false
    let lastRawResponse: string | undefined
    const startedAt = Date.now()

    for (let repairAttempt = 0; repairAttempt <= this.config.maxSchemaRepairAttempts; repairAttempt += 1) {
      const requestStartedAtMs = Date.now()
      const timeoutMs = Math.min(
        this.config.timeoutMs,
        request.remainingBudget.modelRequestDeadlineAtMs === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.max(1, request.remainingBudget.modelRequestDeadlineAtMs - Date.now()),
        Math.max(1, request.remainingBudget.deadlineAtMs - Date.now()),
      )
      const completionInput: DeepSeekCompletionInput = {
        model: this.config.model,
        messages,
        ...(this.config.jsonModeEnabled ? { responseFormat: { type: "json_object" as const } } : {}),
        signal: mergeExecutionSignals(options?.signal, AbortSignal.timeout(timeoutMs)),
        thinking: { type: this.config.thinkingModeEnabled ? "enabled" : "disabled" },
        ...(this.config.thinkingModeEnabled ? { reasoningEffort: this.config.reasoningEffort } : {}),
      }
      runtimeLog("debug", "deepseek-model", "completion.requested", {
        taskId: request.taskId,
        phase: request.phase,
        envelopeId: request.envelopeId,
        repairAttempt: repairAttempt + 1,
        messageCount: messages.length,
        messageCharacters: messages.reduce((total, message) => total + message.content.length, 0),
        timeoutMs,
        thinkingEnabled: this.config.thinkingModeEnabled,
        reasoningEffort: this.config.thinkingModeEnabled ? this.config.reasoningEffort : undefined,
        jsonModeEnabled: this.config.jsonModeEnabled,
        maxTokens: completionInput.maxTokens,
      })
      const response = await this.completeWithRetry(client, completionInput)
      const usage = readUsage(response.usage)
      runtimeLog("debug", "deepseek-model", "completion.received", {
        taskId: request.taskId,
        phase: request.phase,
        envelopeId: request.envelopeId,
        repairAttempt: repairAttempt + 1,
        elapsedMs: Date.now() - requestStartedAtMs,
        contentCharacters: response.content?.length ?? 0,
        reasoningCharacters: response.reasoningContent?.length ?? 0,
        contentState: response.content === null ? "null" : response.content.trim().length === 0 ? "empty" : "present",
        finishReason: response.finishReason,
        responseId: response.responseId,
        messageFieldNames: response.messageFieldNames,
        ...((response.content === null || response.content.trim().length === 0) && response.reasoningContent
          ? { emptyContentReasoningTail: response.reasoningContent.slice(-2_000) }
          : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        estimatedContentTokens: Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0)),
        completionTokenDetailKeys: usage.completionTokenDetailKeys,
        cacheHitInputTokens: usage.cacheHitInputTokens,
        cacheMissInputTokens: usage.cacheMissInputTokens,
      })
      if (response.finishReason === "length") {
        runtimeLog("warn", "deepseek-model", "completion.output_truncated", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          repairAttempt: repairAttempt + 1,
          maxTokens: completionInput.maxTokens,
          contentCharacters: response.content?.length ?? 0,
          reasoningCharacters: response.reasoningContent?.length ?? 0,
          estimatedContentTokens: Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0)),
          contentPrefix: response.content?.slice(0, 1_000) ?? "",
          contentSuffix: response.content?.slice(-1_000) ?? "",
        })
      }
      totalInputTokens += usage.inputTokens
      totalOutputTokens += usage.outputTokens
      if (usage.cacheHitInputTokens !== undefined) {
        cacheHitInputTokens += usage.cacheHitInputTokens
        hasCacheHit = true
      }
      if (usage.cacheMissInputTokens !== undefined) {
        cacheMissInputTokens += usage.cacheMissInputTokens
        hasCacheMiss = true
      }
      try {
        if (response.finishReason === "length") {
          throw new SyntaxError("Provider stopped at the output token limit before completing a bounded phase result")
        }
        const selectedOutput = selectModelOutput(response)
        lastRawResponse = selectedOutput.raw
        if (selectedOutput.source === "reasoning") {
          runtimeLog("warn", "deepseek-model", "completion.reasoning_fallback_accepted", {
            taskId: request.taskId,
            phase: request.phase,
            envelopeId: request.envelopeId,
            repairAttempt: repairAttempt + 1,
            jsonCharacters: selectedOutput.raw.length,
          })
        }
        const modelResult = selectedOutput.modelResult
        const result = assembleModelPhaseResult(referenceView.restore(modelResult), request)
        runtimeLog("debug", "deepseek-model", "execution.completed", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          repairAttempts: repairAttempt,
          outcome: result.outcome,
          requestedReadCount: result.requestedReads.length,
          citedReadCount: result.citedReadIds.length,
        })
        return {
          result,
          usage: {
            modelCalls: repairAttempt + 1,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            latencyMs: Math.max(0, Date.now() - startedAt),
            ...(hasCacheHit ? { cacheHitInputTokens } : {}),
            ...(hasCacheMiss ? { cacheMissInputTokens } : {}),
            provider: "deepseek",
            model: this.config.model,
            ...(response.reasoningContent === undefined || response.reasoningContent === null
              ? {}
              : { reasoningContent: response.reasoningContent }),
          },
        }
      } catch (error) {
        lastError = error
        runtimeLog(repairAttempt >= this.config.maxSchemaRepairAttempts ? "error" : "warn", "deepseek-model", "response.validation_failed", {
          taskId: request.taskId,
          phase: request.phase,
          envelopeId: request.envelopeId,
          repairAttempt: repairAttempt + 1,
          maxSchemaRepairAttempts: this.config.maxSchemaRepairAttempts,
          error: errorDetails(error),
        })
        if (repairAttempt >= this.config.maxSchemaRepairAttempts) break
        const repairMessage = {
          role: "user" as const,
          content: [
            error instanceof SyntaxError
              ? "The previous response was truncated or syntactically incomplete. Regenerate the complete object from the original request; do not continue or echo the partial response."
              : "The previous response failed validation. Regenerate the complete object from the original request; do not echo the invalid response.",
            `Validation error: ${referenceView.toModelText(formatValidationError(error))}`,
            ...(error instanceof SyntaxError
              ? ["Use compact JSON. Keep prose fields to one short sentence, avoid repeated evidence summaries, and finish below the provider's configured output limit."]
              : []),
            buildOutputReminder(request, referenceView),
          ].join("\n"),
        }
        messages.push(repairMessage)
      }
    }
    runtimeLog("error", "deepseek-model", "execution.failed", {
      taskId: request.taskId,
      phase: request.phase,
      envelopeId: request.envelopeId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: errorDetails(lastError),
    })
    throw new DeepSeekModelError(
      "schema",
      `DeepSeek response could not satisfy the phase contract: ${formatError(lastError)}`,
      lastRawResponse,
    )
  }

  private async createClient(): Promise<DeepSeekCompletionClient> {
    const apiKey = await this.secrets.getSecret(this.config.apiKeyRef)
    if (apiKey.trim().length === 0) {
      throw new DeepSeekModelError("configuration", "DeepSeek API key is empty")
    }
    const dispatcher = this.config.proxyUrl === undefined ? undefined : new ProxyAgent(this.config.proxyUrl)
    const clientOptions = {
      apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      maxRetries: 0,
      ...(dispatcher === undefined ? {} : { fetchOptions: { dispatcher } }),
    } as unknown as ConstructorParameters<typeof OpenAI>[0]
    const client = new OpenAI(clientOptions)
    return {
      complete: async (input) => {
        const requestBody = {
          model: input.model,
          messages: [...input.messages],
          ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat }),
          ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
          ...(input.thinking === undefined ? {} : { extra_body: { thinking: input.thinking } }),
          ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
        }
        const response = await client.chat.completions.create(
          requestBody as Parameters<typeof client.chat.completions.create>[0],
          input.signal === undefined ? undefined : { signal: input.signal },
        ) as OpenAI.Chat.Completions.ChatCompletion
        const message = asRecord(response.choices[0]?.message)
        const reasoningContent = readString(message.reasoning_content)
        return {
          content: response.choices[0]?.message.content ?? null,
          finishReason: response.choices[0]?.finish_reason ?? null,
          responseId: response.id,
          messageFieldNames: Object.keys(message),
          ...(reasoningContent === undefined ? {} : { reasoningContent }),
          usage: response.usage,
        }
      },
    }
  }

  private async completeWithRetry(
    client: DeepSeekCompletionClient,
    input: DeepSeekCompletionInput,
  ): Promise<DeepSeekCompletionResponse> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await client.complete(input)
      } catch (error) {
        runtimeLog(input.signal?.aborted || attempt >= this.config.maxAttempts || !isRetryable(error) ? "error" : "warn", "deepseek-model", "completion.attempt_failed", {
          model: input.model,
          attempt,
          maxAttempts: this.config.maxAttempts,
          aborted: input.signal?.aborted ?? false,
          retryable: isRetryable(error),
          error: errorDetails(error),
        })
        if (input.signal?.aborted || attempt >= this.config.maxAttempts || !isRetryable(error)) {
          throw new DeepSeekModelError("network", `DeepSeek request failed: ${formatError(error)}`)
        }
      }
    }
  }
}

function mergeExecutionSignals(executionSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
  return executionSignal === undefined ? timeoutSignal : AbortSignal.any([executionSignal, timeoutSignal])
}

function buildModelResultRules(request: PhaseRequestEnvelope, referenceView: ModelReferenceView): string {
  const declaredLocalReferences = collectDeclaredLocalReferences(request)
  const localReferenceRule = request.phase === "graph_governance"
    ? "- For a new graph identity, use a local:* reference and reuse that same reference throughout this artifact; the backend resolves it once."
    : declaredLocalReferences.length > 0
      ? `- This phase may reuse only local:* handles already declared by graph_governance (${declaredLocalReferences.join(", ")}); it must not declare or invent another local:* handle.`
      : "- Do not use local:* references in this phase. If this phase plans a new graph identity, leave graph identity reference arrays empty and describe the intended new content in reason; only graph_governance declares local:* handles."
  const graphGovernanceReferenceRule = request.phase === "graph_governance"
    ? [
        "- The complete graph_governance JSON must finish below the provider's configured output limit. Keep every reason, explanation, selfReview, semanticText, content, and metadata value concise; do not repeat source prose across fields.",
        "- In graph_governance, graph reference fields accept only node-*, link-*, or a local:* handle declared by a create mutation. Never put read-* in a graph reference field.",
        "- predecessorRevisionReadRefs is the exception: it accepts only revision-bearing read-* evidence aliases, never node-* or link-*.",
        `- Revision-bearing evidence aliases available here: ${referenceView.revisionReadTokens.join(", ") || "none"}.`,
      ].join("\n")
    : "- read-* aliases identify evidence; node-* and link-* aliases identify existing graph objects. Do not substitute one role for the other."
  const crossPhaseChecklist = buildCrossPhaseChecklist(request)
  return [
    "Model result rules:",
    "- Treat the model-facing request as read-only input. Do not copy, restate, summarize, or serialize the request, read evidence, catalog, prior artifacts, or schemas into the result unless the phase schema explicitly requires that value.",
    "- Completeness means one valid result for this phase, not a complete transcript of the input or a complete listing of the world. Each array item must represent one distinct required item; never repeat items to signal completeness.",
    "- Keep all prose fields concise and specific. The only field intended for long-form narrative is draft.artifact.contentMarkdown; do not echo it into reason, selfReview, metadata, or other fields.",
    "- Once the single top-level JSON object is complete and syntactically closed, stop generating immediately. Do not append a second object, explanation, or repeated continuation.",
    `- This is phase ${request.phase}; do not return protocol, envelope, task, context, scope, request, dependency, or artifact-list IDs.`,
    "- Return outcome, artifact, requestedReads, citedReadIds, unresolvedDependencies, reason, and selfReview.",
    "- Use outcome=request_read if and only if requestedReads is non-empty. Every other outcome requires requestedReads=[].",
    localReferenceRule,
    graphGovernanceReferenceRule,
    crossPhaseChecklist,
    "- Do not emit technical UUID fields. The backend creates technical IDs for chapters, sources, revisions, projections, settlements, decisions, and other records.",
    "- For an existing graph identity, copy only the exact reference present in this request's readable evidence. Never invent an existing graph reference.",
    `- Read-evidence to graph-owner alias map: ${referenceView.graphReferencePairs.join(", ") || "none"}.`,
    "- Read requests contain semantic query intent only. Omit query fields that are not useful; infrastructure supplies bounded defaults.",
    "- sourceKinds source means the internal committed immutable source-unit projection. It is not a request to read Markdown from the workspace chapter directory, so a workspace chapter-read prohibition does not exclude source projections.",
    "- For an exact quotation, title, or other exact persisted wording, provide exactKeys. When the same request searches graph or revision evidence, include source as well; summaries and semanticTexts must not impersonate exact source wording.",
    "- Source evidence may expose relatedOwnerRefs with bounded graph projection summaries: these are the graph owners mechanically linked to that exact immutable source unit by settlement. Use those summaries first when reconstructing the source unit's time, place, state, or causal context; do not replace them with an unrelated graph candidate that merely has similar wording, and do not request every related owner again unless the summary is insufficient.",
    `- citedReadIds may contain only model aliases in committedReadIds (${referenceView.committedReadTokens.join(", ") || "none"}) or visiblePendingIds (${referenceView.visiblePendingTokens.join(", ") || "none"}).`,
    "- citedReadIds must include every visible evidence item that materially supports the returned artifact, reason, or selfReview. Evidence omitted from citedReadIds is not carried forward as a factual dependency.",
    "- input.retrievalGaps are notices that a bounded retrieval attempt found no readable evidence; they are not sources and must never be copied into citedReadIds.",
    "- Unresolved dependencies contain description, requiredFor, and disposition only.",
  ].join("\n")
}

function collectDeclaredLocalReferences(request: PhaseRequestEnvelope): string[] {
  const input = asRecord(request.input)
  const artifacts = asRecord(input.artifacts)
  const governance = asRecord(artifacts.graph_governance)
  const mutations = Array.isArray(governance.mutations) ? governance.mutations : []
  return mutations.flatMap((mutation) => {
    const record = asRecord(mutation)
    return (record.operation === "create_node" || record.operation === "create_link")
      && typeof record.ref === "string"
      && record.ref.startsWith("local:")
      ? [record.ref]
      : []
  })
}

function buildCrossPhaseChecklist(request: PhaseRequestEnvelope): string {
  const input = asRecord(request.input)
  const artifacts = asRecord(input.artifacts)
  if (request.phase === "rule_assembly") {
    const readableWorkspacePathCount = Array.isArray(input.readEvidence)
      ? input.readEvidence.filter((evidence) => {
          const record = asRecord(evidence)
          return typeof record.ownerKind === "string" && record.ownerKind.startsWith("workspace:")
        }).length
      : 0
    return [
      `- rule_assembly currently has ${String(readableWorkspacePathCount)} readable workspace path(s). Select only from those read-evidence paths and never enumerate workspaceCatalog as output.`,
      "- selectedWorkspacePaths must contain unique paths. selectionReasons must have exactly the same path keys, with one short sentence per selected path.",
      "- This phase has no long-text field. Never place file contents, rules, catalog entries, or repeated explanations inside any string field.",
      "- Do not copy file contents, catalog entries, evidence payloads, prior artifacts, schemas, or the request into artifact fields. Return the smallest complete JSON result.",
      '- If no additional workspace file is needed, return this compact artifact shape: {"selectedWorkspacePaths":[],"selectionReasons":{},"unresolvedRuleConflicts":[]}.',
    ].join("\n")
  }
  if (request.phase === "semantic_review") {
    const governance = asRecord(artifacts.graph_governance)
    const frontiers = Array.isArray(governance.affectedFrontierRefs)
      ? governance.affectedFrontierRefs.filter((value): value is string => typeof value === "string")
      : []
    return [
      "- semantic_review is advisory. Report only indexes and references for which you have an actual review conclusion; do not enumerate no-opinion items.",
      `- affected frontiers available for review: ${frontiers.join(", ") || "none"}.`,
    ].join("\n")
  }
  if (request.phase === "graph_governance") {
    const dependency = asRecord(artifacts.dependency_audit)
    const scenes = Array.isArray(dependency.sceneContinuity) ? dependency.sceneContinuity : []
    const sourceUnitIds = Array.isArray(input.sourceUnitIds) ? input.sourceUnitIds : []
    return [
      "- Finalize mutations first, then make mutationSpacetimeSettlements cover every zero-based index in your returned mutations array exactly once. Do not use one-based numbering, omit the final index, or infer a fixed mutation count from the input.",
      "- decisionRecords is advisory detail. Omit repetitive per-mutation decisions; uncovered mutations inherit this phase result's reason and selfReview.",
      `- settlementRecords is an optional mechanical projection. Omit it when it would repeat the scene and mutation settlement data; the backend derives missing source-unit return entries. If you provide it, use zero-based sourceUnitIndex values and do not repeat indexes.`,
      `- Required dependency-audit scene indexes are exactly: ${indexList(scenes.length)}. Return one sceneSpacetimeBinding for each listed index, with no missing, duplicate, or extra scene index.`,
      `- Required narrative source unit indexes are exactly: ${indexList(sourceUnitIds.length)}. Their union across sceneSpacetimeBindings.sourceUnitIndexes must equal this list exactly once, with no missing, duplicate, negative, or extra index.`,
      sourceUnitIds.length === 0
        ? "- This is a background evolution with no narrative source units, so every sourceUnitIndexes array must be empty."
        : "- Every dependency-audit scene in this turn is a narrative scene and must bind at least one source unit index, even when that scene has no new graph mutation. Never return an empty sourceUnitIndexes array for one of these scenes.",
      "- For each sceneSpacetimeBinding, copy predecessorSceneIndexes exactly from dependency_audit. The first scene may therefore have an empty predecessorSceneIndexes array; never invent scene 0 or another current-turn index just to satisfy predecessorRequired.",
      "- When predecessorRequired is true but predecessorSceneIndexes is empty, the predecessor is outside this turn. Bind it through predecessorSceneAnchorRefs using the exact existing graph-owner aliases mapped from the dependency evidence, and provide the actual transitionPathRefs that connect the prior state to this scene.",
      "- dependency_audit predecessorSceneRefs are evidence aliases, not graph-owner fields. Convert them through the supplied read-evidence-to-graph-owner alias map before placing them in predecessorSceneAnchorRefs or transitionPathRefs; do not copy raw evidence IDs or invent graph IDs.",
      "- historicalReturnRefs are graph paths only: use node-*, link-*, or local:*; never use read-*. Raw chapter/source return is already preserved by settlementRecords.",
    ].join("\n")
  }
  if (request.phase === "frontier_settlement") {
    const review = asRecord(artifacts.semantic_review)
    const approvedFrontiers = Array.isArray(review.approvedAffectedFrontierRefs)
      ? review.approvedAffectedFrontierRefs.filter((value): value is string => typeof value === "string")
      : []
    return [
      `- frontier_settlement must settle each approved frontier exactly once. Exact frontier list: ${approvedFrontiers.join(", ") || "none"}.`,
      "- A frontier is an independently resumable and discoverable local continuation boundary. It is not a mutation index and not a list of every node or link touched by graph governance; multiple mutations may belong to one frontier.",
      "- Do not manufacture one frontier per mutation or copy the same spacetime anchors into many frontier records. If the approved list is empty, return an empty frontiers array.",
      "- For every non-archived approved frontier, return that frontier's own last scene, time, and location anchors plus a non-empty revisitCondition. Use graph or local references already established in this request; do not invent technical IDs.",
    ].join("\n")
  }
  return "- Preserve every exact cross-phase checklist item supplied in the model-facing request."
}

function indexList(length: number): string {
  return length === 0 ? "none" : Array.from({ length }, (_, index) => String(index)).join(", ")
}

function buildOutputReminder(request: PhaseRequestEnvelope, referenceView: ModelReferenceView): string {
  return [
    "MANDATORY OUTPUT CONTRACT - this is the final and highest-priority instruction for this request:",
    buildModelResultRules(request, referenceView),
    "The response must match this complete model-facing result schema:",
    JSON.stringify(phaseModelResultJsonSchema(request.phase)),
    "Only outcome, artifact, requestedReads, citedReadIds, unresolvedDependencies, reason, and selfReview may appear at the top level.",
    "Use outcome=request_read if and only if requestedReads is non-empty; otherwise requestedReads must be an empty array.",
    `All ${request.phase} phase fields defined by the schema must be nested inside artifact.`,
    "Return one JSON object only. Do not add Markdown fences, commentary, or a custom outcome value.",
    "FINAL OUTPUT DISCIPLINE: Treat all request data as read-only input; never echo or enumerate it. Return only the smallest valid phase result, with no duplicate array items or repeated prose. Close the one JSON object and stop immediately.",
    'Required top-level shape: {"outcome":"continue","artifact":{},"requestedReads":[],"citedReadIds":[],"unresolvedDependencies":[],"reason":"...","selfReview":"..."}',
  ].join("\n")
}

function parseFirstJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const start = raw.search(/\S/u)
    if (start < 0 || raw[start] !== "{") throw error
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
      } else if (character === "{") {
        depth += 1
      } else if (character === "}") {
        depth -= 1
        if (depth === 0) {
          const firstObjectEnd = index + 1
          const trailing = raw.slice(firstObjectEnd).trim()
          if (trailing.startsWith(",")) {
            try {
              return JSON.parse(raw.slice(start, index) + trailing)
            } catch {
              return JSON.parse(raw.slice(start, firstObjectEnd))
            }
          }
          return JSON.parse(raw.slice(start, firstObjectEnd))
        }
      }
    }
    throw error
  }
}

function selectModelOutput(response: DeepSeekCompletionResponse): {
  raw: string
  modelResult: ReturnType<typeof parseModelPhaseResult>
  source: "content" | "reasoning"
} {
  const content = response.content?.trim()
  if (content !== undefined && content.length > 0) {
    return {
      raw: content,
      modelResult: parseModelPhaseResult(parseFirstJsonObject(content)),
      source: "content",
    }
  }

  const reasoning = response.reasoningContent?.trim()
  if (reasoning !== undefined && reasoning.length > 0) {
    const fallback = parseLastValidModelResult(reasoning)
    if (fallback !== undefined) return { ...fallback, source: "reasoning" }
  }

  throw new DeepSeekModelError(
    "response",
    "DeepSeek returned reasoning without final content",
  )
}

function parseLastValidModelResult(raw: string): {
  raw: string
  modelResult: ReturnType<typeof parseModelPhaseResult>
} | undefined {
  const objectEnd = raw.lastIndexOf("}")
  if (objectEnd < 0) return undefined
  let objectStart = raw.lastIndexOf("{", objectEnd)
  while (objectStart >= 0) {
    const candidate = raw.slice(objectStart, objectEnd + 1)
    try {
      return {
        raw: candidate,
        modelResult: parseModelPhaseResult(JSON.parse(candidate)),
      }
    } catch {
      // Continue toward the enclosing object until the complete phase result is found.
    }
    if (objectStart === 0) break
    objectStart = raw.lastIndexOf("{", objectStart - 1)
  }
  return undefined
}

function formatValidationError(error: unknown): string {
  return formatError(error)
}

export class EnvironmentSecretProvider implements SecretProvider {
  public constructor(private readonly values: NodeJS.ProcessEnv = process.env) {}

  public getSecret(reference: string): Promise<string> {
    const value = reference === "deepseek-api-key" ? this.values.DEEPSEEK_API_KEY : this.values[reference]
    return Promise.resolve(value ?? "")
  }
}

function readUsage(value: unknown): {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  completionTokenDetailKeys?: readonly string[]
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
} {
  const usage = asRecord(value)
  const promptTokens = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens) ?? 0
  const completionTokens = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens) ?? 0
  const completionTokenDetails = asRecord(usage.completion_tokens_details)
  const reasoningTokens = readNumber(completionTokenDetails.reasoning_tokens)
  const cacheHit = readNumber(usage.prompt_cache_hit_tokens)
  const cacheMiss = readNumber(usage.prompt_cache_miss_tokens)
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(Object.keys(completionTokenDetails).length === 0 ? {} : { completionTokenDetailKeys: Object.keys(completionTokenDetails) }),
    ...(cacheHit === undefined ? {} : { cacheHitInputTokens: cacheHit }),
    ...(cacheMiss === undefined ? {} : { cacheMissInputTokens: cacheMiss }),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true
  if (error instanceof TypeError) return true
  if (!(error instanceof OpenAI.APIError)) return false
  return error.status === 408
    || error.status === 409
    || error.status === 429
    || (error.status !== undefined && error.status >= 500)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
