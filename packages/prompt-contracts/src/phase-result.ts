import { phaseResultEnvelopeSchema, type AIPhase, type PhaseResultEnvelope } from "@worldseed/contracts"

import { phaseArtifactSchemas } from "./phase-schemas/artifacts.js"

export function parsePhaseArtifact(phase: AIPhase, input: unknown): unknown {
  return phaseArtifactSchemas[phase].parse(input)
}

export function parsePhaseResult(phase: AIPhase, input: unknown): PhaseResultEnvelope {
  const result = phaseResultEnvelopeSchema.parse(input)

  if (result.phase !== phase) {
    throw new Error(`Phase mismatch: expected ${phase}, received ${result.phase}`)
  }

  if (result.artifact !== undefined) {
    parsePhaseArtifact(phase, result.artifact)
  }

  return result
}
