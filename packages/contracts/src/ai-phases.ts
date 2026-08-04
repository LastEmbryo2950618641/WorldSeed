import { z } from "zod"

import { modelCallBudgetSchema } from "./budgets.js"
import { aiPhaseSchema } from "./common.js"
import { idSchema } from "./ids.js"
import { readRequestSchema, unresolvedDependencySchema } from "./reads.js"
import { schemaVersionSchema } from "./version.js"

export const phaseOutcomeValues = ["continue", "request_read", "approve", "revise", "reject", "retire"] as const
export const phaseOutcomeSchema = z.enum(phaseOutcomeValues)
export type PhaseOutcome = z.infer<typeof phaseOutcomeSchema>

export const phaseRequestEnvelopeSchema = z.object({
  schemaVersion: schemaVersionSchema,
  envelopeId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  turnId: idSchema,
  contextId: idSchema,
  scopeId: idSchema,
  phase: aiPhaseSchema,
  protocolVersion: z.string().min(1),
  promptRef: z.string().min(1),
  promptDigest: z.string().min(1),
  contextViewRef: z.string().min(1),
  committedReadIds: z.array(idSchema),
  visiblePendingIds: z.array(idSchema),
  remainingBudget: modelCallBudgetSchema,
  input: z.unknown(),
})
export type PhaseRequestEnvelope = z.infer<typeof phaseRequestEnvelopeSchema>

export const phaseResultEnvelopeSchema = z.object({
  schemaVersion: schemaVersionSchema,
  envelopeId: idSchema,
  contextId: idSchema,
  phase: aiPhaseSchema,
  outcome: phaseOutcomeSchema,
  artifact: z.unknown().optional(),
  requestedReads: z.array(readRequestSchema),
  citedReadIds: z.array(idSchema),
  producedArtifactIds: z.array(idSchema),
  decisionRecordIds: z.array(idSchema),
  unresolvedDependencies: z.array(unresolvedDependencySchema),
  reason: z.string().min(1),
  selfReview: z.string().min(1),
}).superRefine((result, context) => {
  if (result.outcome === "request_read" && result.requestedReads.length === 0) {
    context.addIssue({
      code: "custom",
      message: "request_read requires at least one requested read",
      path: ["requestedReads"],
    })
  }
})
export type PhaseResultEnvelope = z.infer<typeof phaseResultEnvelopeSchema>
