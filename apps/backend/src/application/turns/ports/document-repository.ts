import type { ProjectId, ScopeId, Visibility } from "@worldseed/contracts"

export type DocumentVersion = Readonly<{
  id: string
  projectId: ProjectId
  scopeId: ScopeId
  sourceId: string
  chapterId: string
  visibility: Visibility
  contentRef: string
  heading: string
  publishPath: string
  digest: string
  predecessorSourceId?: string
  createdAtMs: number
}>

export type SourceUnit = Readonly<{
  id: string
  projectId: ProjectId
  sourceId: string
  sequence: number
  contentRef: string
  digest: string
  createdAtMs: number
}>

export interface DocumentRepository {
  stageVersion(version: Omit<DocumentVersion, "visibility">): Promise<DocumentVersion>
  stageSourceUnits(units: readonly SourceUnit[]): Promise<void>
  /**
   * Idempotent staging for uncommitted sources: deletes existing units (and FK dependents)
   * for the sourceId, then inserts `units`. Throws if the sourceId is already committed.
   */
  replaceUncommittedSourceUnits(projectId: ProjectId, sourceId: string, units: readonly SourceUnit[]): Promise<void>
  /** Deletes units for uncommitted sourceIds only; committed sources are skipped. */
  clearUncommittedSourceUnits(projectId: ProjectId, sourceIds: readonly string[]): Promise<void>
  listSourceUnits(projectId: ProjectId, sourceId: string): Promise<readonly SourceUnit[]>
  findVersion(projectId: ProjectId, sourceId: string, pendingScopeId?: ScopeId): Promise<DocumentVersion | undefined>
  findStoredVersion(projectId: ProjectId, sourceId: string): Promise<DocumentVersion | undefined>
  findCurrentChapter(projectId: ProjectId, chapterId: string): Promise<DocumentVersion | undefined>
  listCommittedChapters(projectId: ProjectId): Promise<readonly DocumentVersion[]>
}
