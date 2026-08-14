import { z } from "zod"

import { idSchema } from "./ids.js"

export const backendErrorCodeValues = [
  "validation_error",
  "scope_violation",
  "budget_exhausted",
  "stale_base",
  "index_unavailable",
  "model_failure",
  "workspace_failure",
  "storage_failure",
  "protocol_mismatch",
  "history_busy",
  "history_corrupt",
  "history_not_found",
  "checkpoint_unavailable",
] as const
export const backendErrorCodeSchema = z.enum(backendErrorCodeValues)
export type BackendErrorCode = z.infer<typeof backendErrorCodeSchema>

export const backendErrorSchema = z.object({
  code: backendErrorCodeSchema,
  message: z.string().min(1),
  recoverable: z.boolean(),
  diagnosticId: idSchema,
  details: z.record(z.string(), z.unknown()).optional(),
})
export type BackendError = z.infer<typeof backendErrorSchema>
