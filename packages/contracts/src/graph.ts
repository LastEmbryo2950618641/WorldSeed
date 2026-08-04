import { z } from "zod"

import { idSchema } from "./ids.js"

export const sourceRefSchema = z.object({
  sourceId: idSchema,
  locator: z.unknown().optional(),
})
export type SourceRef = z.infer<typeof sourceRefSchema>

export const graphNodeDataSchema = z.object({
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRefs: z.array(sourceRefSchema).optional(),
})
export type GraphNodeData = z.infer<typeof graphNodeDataSchema>

export const graphNodeSchema = graphNodeDataSchema.extend({
  id: idSchema,
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const graphLinkDataSchema = z.object({
  fromNodeId: idSchema,
  toNodeId: idSchema,
  content: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRefs: z.array(sourceRefSchema).optional(),
})
export type GraphLinkData = z.infer<typeof graphLinkDataSchema>

export const graphLinkSchema = graphLinkDataSchema.extend({
  id: idSchema,
})
export type GraphLink = z.infer<typeof graphLinkSchema>

export const graphMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_node"), node: graphNodeSchema }),
  z.object({ operation: z.literal("edit_node"), nodeId: idSchema, next: graphNodeDataSchema }),
  z.object({ operation: z.literal("retire_node"), nodeId: idSchema, archiveOutletIds: z.array(idSchema).min(1) }),
  z.object({ operation: z.literal("create_link"), link: graphLinkSchema }),
  z.object({ operation: z.literal("edit_link"), linkId: idSchema, next: graphLinkDataSchema }),
  z.object({ operation: z.literal("retire_link"), linkId: idSchema, archiveOutletIds: z.array(idSchema).min(1) }),
])
export type GraphMutation = z.infer<typeof graphMutationSchema>
