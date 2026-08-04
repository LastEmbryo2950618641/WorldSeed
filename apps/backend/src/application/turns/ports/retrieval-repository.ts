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
}>

export type RetrievalSearchScope = Readonly<{
  projectId: ProjectId
  pendingScopeId?: ScopeId
}>

export interface RetrievalRepository {
  stageProjection(projection: Omit<RetrievalProjection, "visibility">): Promise<RetrievalProjection>
  searchExact(scope: RetrievalSearchScope, keys: readonly string[], limit: number): Promise<readonly RetrievalProjection[]>
  searchText(scope: RetrievalSearchScope, expression: string, limit: number): Promise<readonly RetrievalProjection[]>
}
