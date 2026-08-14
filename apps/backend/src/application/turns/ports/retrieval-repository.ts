import type { ProjectId, ScopeId, Visibility } from "@worldseed/contracts"

export type RetrievalProjection = Readonly<{
  projectionId: string
  projectId: ProjectId
  scopeId: ScopeId
  ownerKind: string
  ownerId: string
  ownerRevisionId: string
  visibility: Visibility
  exactKeys: readonly string[]
  semanticText: string
  sourceRefs: readonly unknown[]
  digest: string
  stateRole?: "current" | "historical"
  committedSequence?: number
  sourcePosition?: SourcePosition
}>

export type SourcePosition = Readonly<{
  sourceRef: string
  sequence: number
  firstSequence: number
  lastSequence: number
  unitCount: number
  isStart: boolean
  isEnd: boolean
}>

export type RetrievalSearchScope = Readonly<{
  projectId: ProjectId
  pendingScopeId?: ScopeId
}>

export type SourceSequenceAnchor = Readonly<{
  sourceId: string
  sequence: number
}>

export interface RetrievalRepository {
  stageProjection(projection: Omit<RetrievalProjection, "visibility">): Promise<RetrievalProjection>
  findForOwnerRevision(
    projectId: ProjectId,
    ownerKind: "node" | "link",
    ownerId: string,
    ownerRevisionId: string,
  ): Promise<RetrievalProjection | undefined>
  findCurrentForOwners(
    scope: RetrievalSearchScope,
    ownerIds: readonly string[],
    limit: number,
  ): Promise<readonly RetrievalProjection[]>
  searchExact(scope: RetrievalSearchScope, keys: readonly string[], limit: number): Promise<readonly RetrievalProjection[]>
  searchText(scope: RetrievalSearchScope, expression: string, limit: number): Promise<readonly RetrievalProjection[]>
  searchSourceText(
    scope: RetrievalSearchScope,
    expression: string,
    limit: number,
    sourceIds?: readonly string[],
  ): Promise<readonly RetrievalProjection[]>
  expandSourceNeighborhood(
    scope: RetrievalSearchScope,
    anchors: readonly SourceSequenceAnchor[],
    maxDistance: number,
    limit: number,
  ): Promise<readonly RetrievalProjection[]>
  readSourceBoundary(
    scope: RetrievalSearchScope,
    sourceRefs: readonly string[],
    boundary: "start" | "end",
    limit: number,
  ): Promise<readonly RetrievalProjection[]>
}
