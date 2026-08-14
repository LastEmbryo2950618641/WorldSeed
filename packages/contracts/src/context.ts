import { z } from "zod"

import { idSchema } from "./ids.js"
import {
  evidenceObjectIdSchema,
  storedObjectReferenceIdSchema,
} from "./persistent-id.js"
import { protocolVersionSchema } from "./version.js"

export const contextSegmentKindValues = [
  "system_principles",
  "protocol",
  "rule_snapshot",
  "user_input",
  "presentation_rules",
  "committed_read",
  "pending_artifact",
  "phase_result",
] as const

export const contextSegmentRefSchema = z.object({
  segmentId: idSchema,
  kind: z.enum(contextSegmentKindValues),
  ownerIds: z.array(storedObjectReferenceIdSchema),
  visibility: z.enum(["committed", "pending"]),
  canonicalDigest: z.string().min(1),
  tokenEstimate: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
})
export type ContextSegmentRef = z.infer<typeof contextSegmentRefSchema>

export const contextReadLedgerSchema = z.object({
  committedReadIds: z.array(evidenceObjectIdSchema),
  visiblePendingIds: z.array(evidenceObjectIdSchema),
  requestedReadIds: z.array(idSchema),
  returnedReadIds: z.array(evidenceObjectIdSchema),
  rejectedReadIds: z.array(evidenceObjectIdSchema),
  readReasons: z.record(evidenceObjectIdSchema, z.string().min(1)),
})
export type ContextReadLedger = z.infer<typeof contextReadLedgerSchema>

export const contextBudgetSnapshotSchema = z.object({
  maxTokens: z.number().int().positive(),
  usedTokens: z.number().int().nonnegative(),
})
export type ContextBudgetSnapshot = z.infer<typeof contextBudgetSnapshotSchema>

export const turnContextSchema = z.object({
  contextId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  turnId: idSchema,
  taskKind: z.enum(["turn", "query", "evolution", "revision"]),
  protocolVersion: protocolVersionSchema,
  ruleSnapshotId: idSchema.optional(),
  baseCommittedSequence: z.number().int().nonnegative(),
  segments: z.array(contextSegmentRefSchema),
  readLedger: contextReadLedgerSchema,
  budget: contextBudgetSnapshotSchema,
})
export type TurnContext = z.infer<typeof turnContextSchema>
