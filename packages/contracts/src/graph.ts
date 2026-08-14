import { z } from "zod"

import {
  graphObjectIdSchema,
  linkObjectIdSchema,
  nodeObjectIdSchema,
  sourceObjectIdSchema,
} from "./persistent-id.js"

export const sourceRefSchema = z.object({
  sourceId: sourceObjectIdSchema,
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
  id: nodeObjectIdSchema,
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const graphLinkDataSchema = z.object({
  fromNodeId: nodeObjectIdSchema,
  toNodeId: nodeObjectIdSchema,
  content: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRefs: z.array(sourceRefSchema).optional(),
})
export type GraphLinkData = z.infer<typeof graphLinkDataSchema>

export const graphLinkSchema = graphLinkDataSchema.extend({
  id: linkObjectIdSchema,
})
export type GraphLink = z.infer<typeof graphLinkSchema>

export const graphMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_node"), node: graphNodeSchema }),
  z.object({ operation: z.literal("edit_node"), nodeId: nodeObjectIdSchema, next: graphNodeDataSchema }),
  z.object({ operation: z.literal("retire_node"), nodeId: nodeObjectIdSchema, archiveOutletIds: z.array(graphObjectIdSchema).min(1) }),
  z.object({ operation: z.literal("create_link"), link: graphLinkSchema }),
  z.object({ operation: z.literal("edit_link"), linkId: linkObjectIdSchema, next: graphLinkDataSchema }),
  z.object({ operation: z.literal("retire_link"), linkId: linkObjectIdSchema, archiveOutletIds: z.array(graphObjectIdSchema).min(1) }),
])
export type GraphMutation = z.infer<typeof graphMutationSchema>
