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

export type GraphDegreeEntry = Readonly<{
  nodeId: string
  inDegree: number
  outDegree: number
}>

export type GraphDegreeProfile = Readonly<{
  nodeCount: number
  linkCount: number
  entries: readonly GraphDegreeEntry[]
}>

export type CurrentGraphOwnerRevision = Readonly<{
  ownerKind: "node" | "link"
  ownerId: string
  revisionId: string
  status: "active" | "retired"
  committedSequence?: number
}>

export type PersistedGraphRevision = Readonly<GraphRevision>

export interface GraphRepository {
  stageRevisions(projectId: ProjectId, scopeId: ScopeId, revisions: readonly GraphRevision[]): Promise<void>
  getNode(scope: GraphReadScope, nodeId: string): Promise<GraphNode | undefined>
  getLink(scope: GraphReadScope, linkId: string): Promise<GraphLink | undefined>
  getNeighborhood(input: NeighborhoodRead): Promise<GraphSlice>
  getCurrentOwnerRevisions(scope: GraphReadScope, ownerIds: readonly string[]): Promise<readonly CurrentGraphOwnerRevision[]>
  getDegreeProfile(scope: GraphReadScope): Promise<GraphDegreeProfile>
  listRevisions(projectId: ProjectId, targetKind: "node" | "link", targetId: string): Promise<readonly PersistedGraphRevision[]>
}
