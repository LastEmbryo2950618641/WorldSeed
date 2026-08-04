import { z } from "zod"

import { backendMethodSchema } from "./backend-methods.js"
import { backendErrorSchema } from "./errors.js"
import { idSchema } from "./ids.js"
import { protocolVersionSchema } from "./version.js"

export const clientRequestSchema = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: idSchema,
  method: backendMethodSchema,
  payload: z.unknown(),
})
export type ClientRequest = z.infer<typeof clientRequestSchema>

export const clientResponseSchema = z.discriminatedUnion("ok", [
  z.object({ protocolVersion: protocolVersionSchema, requestId: idSchema, ok: z.literal(true), data: z.unknown() }),
  z.object({ protocolVersion: protocolVersionSchema, requestId: idSchema, ok: z.literal(false), error: backendErrorSchema }),
])
export type ClientResponse = z.infer<typeof clientResponseSchema>
