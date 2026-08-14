import type { ReadRequest } from "@worldseed/contracts"
import {
  graphGovernanceArtifactSchema,
  type GraphGovernanceArtifact,
} from "@worldseed/prompt-contracts"

import { digest } from "../../core/index.js"
import type { VerificationProbeExecution } from "./ports/ai-model-port.js"

export type ReadExecutionRecord = Readonly<{
  requestId: string
  operationId: string
  returnedReadRefs: readonly string[]
  returnedGraphRefs: readonly string[]
  returnedProposalRefs?: readonly string[]
  resultDigest: string
}>

export class VerificationProbeCoordinator {
  public planDigest(request: ReadRequest, governanceInput: unknown): string {
    return digest({
      descriptor: request.verificationProbe,
      query: request.query,
      governance: graphGovernanceArtifactSchema.parse(governanceInput),
    })
  }

  public createExecutions(
    requests: readonly ReadRequest[],
    readExecutions: readonly ReadExecutionRecord[],
    governanceInput: unknown,
    startIndex = 0,
  ): VerificationProbeExecution[] {
    const governance = graphGovernanceArtifactSchema.parse(governanceInput)
    const executionByRequestId = new Map(readExecutions.map((execution) => [execution.requestId, execution]))
    return requests.flatMap((request) => {
      if (request.verificationProbe === undefined) return []
      const execution = executionByRequestId.get(request.requestId)
      if (execution === undefined) throw new Error(`Verification probe was not executed: ${request.requestId}`)
      const returnedProposalRefs = execution.returnedProposalRefs ?? queryProposalOverlay(request, governance)
      return [{
        probeIndex: 0,
        requestId: request.requestId,
        operationId: execution.operationId,
        descriptor: request.verificationProbe,
        status: "completed" as const,
        returnedReadRefs: execution.returnedReadRefs,
        returnedGraphRefs: execution.returnedGraphRefs,
        returnedProposalRefs,
        resultDigest: digest({
          readResultDigest: execution.resultDigest,
          returnedProposalRefs,
        }),
      }]
    }).map((execution, probeIndex) => ({ ...execution, probeIndex: startIndex + probeIndex }))
  }

  public assertAssessments(
    artifact: unknown,
    executions: readonly VerificationProbeExecution[],
  ): void {
    const review = parseVerificationProbeAssessmentCarrier(artifact)
    if (executions.length === 0) {
      throw new Error("AI must define at least one verification probe before graph review can finish")
    }
    const assessedIndexes = review.verificationProbeAssessments.map((assessment) => assessment.probeIndex)
    if (assessedIndexes.length !== executions.length
      || new Set(assessedIndexes).size !== assessedIndexes.length
      || executions.some((execution) => !assessedIndexes.includes(execution.probeIndex))) {
      throw new Error("Graph review must assess every application-executed verification probe exactly once")
    }
  }
}

function parseVerificationProbeAssessmentCarrier(value: unknown): Readonly<{
  verificationProbeAssessments: readonly Readonly<{ probeIndex: number }>[]
}> {
  if (typeof value !== "object" || value === null || !("verificationProbeAssessments" in value)) {
    throw new Error("Graph review artifact is missing verificationProbeAssessments")
  }
  const assessments: unknown = value.verificationProbeAssessments
  if (!Array.isArray(assessments)) {
    throw new Error("Graph review verificationProbeAssessments must contain non-negative integer probe indexes")
  }
  const parsed = (assessments as unknown[]).map((assessment) => {
    if (typeof assessment !== "object" || assessment === null || !("probeIndex" in assessment)) {
      throw new Error("Graph review verificationProbeAssessments must contain non-negative integer probe indexes")
    }
    const probeIndex: unknown = assessment.probeIndex
    if (typeof probeIndex !== "number" || !Number.isInteger(probeIndex) || probeIndex < 0) {
      throw new Error("Graph review verificationProbeAssessments must contain non-negative integer probe indexes")
    }
    return { probeIndex }
  })
  return { verificationProbeAssessments: parsed }
}

function queryProposalOverlay(request: ReadRequest, governance: GraphGovernanceArtifact): string[] {
  if (!request.query.sourceKinds.some((kind) => kind === "graph" || kind === "revision")) return []
  const proposalRefs = new Set(governance.mutations.flatMap((mutation) => proposalMutationRef(mutation) ?? []))
  const selected = new Set<string>()
  for (const anchorId of request.query.anchorIds) {
    if (proposalRefs.has(anchorId)) selected.add(anchorId)
  }
  const exactKeys = request.query.exactKeys.map(normalizeSearchText).filter((value) => value.length > 0)
  const semanticTexts = request.query.semanticTexts.map(normalizeSearchText).filter((value) => value.length > 0)
  for (const projection of governance.retrievalProjections) {
    const ownerRef = proposalProjectionOwnerRef(projection, governance)
    if (ownerRef === undefined) continue
    const exactMatch = exactKeys.some((key) => projection.exactKeys.some((candidate) => normalizeSearchText(candidate) === key))
    const semantic = normalizeSearchText(projection.semanticText)
    const semanticMatch = semanticTexts.some((text) => semantic.includes(text) || text.includes(semantic))
    if (exactMatch || semanticMatch || request.query.anchorIds.includes(ownerRef)) selected.add(ownerRef)
  }
  for (let depth = 0; depth < request.query.maxDepth; depth += 1) {
    const current = [...selected]
    for (const mutation of governance.mutations) {
      if (mutation.operation !== "create_link" && mutation.operation !== "edit_link") continue
      const followsOut = request.query.directions.includes("out") || request.query.directions.includes("both")
      const followsIn = request.query.directions.includes("in") || request.query.directions.includes("both")
      if (followsOut && current.includes(mutation.fromRef)) {
        selected.add(mutation.operation === "create_link" ? mutation.ref : mutation.linkRef)
        selected.add(mutation.toRef)
      }
      if (followsIn && current.includes(mutation.toRef)) {
        selected.add(mutation.operation === "create_link" ? mutation.ref : mutation.linkRef)
        selected.add(mutation.fromRef)
      }
    }
  }
  return [...selected].slice(0, request.query.maxCandidates)
}

function proposalProjectionOwnerRef(
  projection: GraphGovernanceArtifact["retrievalProjections"][number],
  governance: GraphGovernanceArtifact,
): string | undefined {
  if (projection.ownerRef !== undefined) return projection.ownerRef
  if (projection.ownerMutationIndex === undefined) return undefined
  return proposalMutationRef(governance.mutations[projection.ownerMutationIndex])
}

function proposalMutationRef(mutation: GraphGovernanceArtifact["mutations"][number] | undefined): string | undefined {
  if (mutation === undefined) return undefined
  switch (mutation.operation) {
    case "create_node":
    case "create_link": return mutation.ref
    case "edit_node":
    case "retire_node": return mutation.nodeRef
    case "edit_link":
    case "retire_link": return mutation.linkRef
  }
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}
