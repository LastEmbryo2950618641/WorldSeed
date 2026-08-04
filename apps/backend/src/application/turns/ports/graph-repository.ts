import type { GraphLink, GraphNode, ProjectId, ScopeId } from "@worldseed/contracts"

import type { GraphRevision } from "../../../core/index.js"

export type GraphReadScope = Readonly<{
  projectId: ProjectId
  pendingScopeId?: ScopeId
}>

export type NeighborhoodRead = Readonly<{
  scope: GraphReadScope
  anchorIds: readonly string[]
  direction: "out" | "in" | "both"
  maxDepth: number
  maxNodes: number
  maxLinks: number
}>

export type GraphSlice = Readonly<{
  nodes: readonly GraphNode[]
  links: readonly GraphLink[]
  visitedNodeIds: readonly string[]
  truncated: boolean
}>

export type PersistedGraphRevision = Readonly<Omit<GraphRevision, "selfReview">>

export interface GraphRepository {
  stageRevisions(projectId: ProjectId, scopeId: ScopeId, revisions: readonly GraphRevision[]): Promise<void>
  getNode(scope: GraphReadScope, nodeId: string): Promise<GraphNode | undefined>
  getLink(scope: GraphReadScope, linkId: string): Promise<GraphLink | undefined>
  getNeighborhood(input: NeighborhoodRead): Promise<GraphSlice>
  listRevisions(projectId: ProjectId, targetKind: "node" | "link", targetId: string): Promise<readonly PersistedGraphRevision[]>
}
