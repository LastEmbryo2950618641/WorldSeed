import type {
  ChapterRevision,
  ChapterRevisionFinalization,
  ChapterRevisionDecision,
  ChapterRevisionReview,
  ProjectId,
} from "@worldseed/contracts"

export type StoredChapterRevision = ChapterRevision & Readonly<{
  contentRef: string
  contentScopeId: string
  baseContentDigest: string
}> 

export interface ChapterRevisionRepository {
  create(input: StoredChapterRevision): Promise<void>
  find(revisionTaskId: string): Promise<StoredChapterRevision | undefined>
  findByGraphSyncTaskId(graphSyncTaskId: string): Promise<StoredChapterRevision | undefined>
  findActive(projectId: ProjectId, chapterId: string, baseSourceId: string): Promise<StoredChapterRevision | undefined>
  findActiveForChapter(projectId: ProjectId, chapterId: string): Promise<StoredChapterRevision | undefined>
  createFinalization(input: Readonly<{
    finalizationId: string
    revisionTaskId: string
    projectId: ProjectId
    proposedSourceId: string
    contentScopeId: string
    contentDigest: string
    createdAtMs: number
  }>): Promise<ChapterRevisionFinalization>
  updateFinalization(input: Readonly<{
    revisionTaskId: string
    status: ChapterRevisionFinalization["status"]
    graphSyncTaskId?: string
    updatedAtMs: number
  }>): Promise<ChapterRevisionFinalization>
  updateProposed(input: Readonly<{
    revisionTaskId: string
    proposedSourceId: string
    heading: string
    contentRef: string
    contentDigest: string
    predecessorSourceId: string
    updatedAtMs: number
  }>): Promise<StoredChapterRevision>
  saveReview(review: ChapterRevisionReview): Promise<StoredChapterRevision>
  saveDecision(input: ChapterRevisionDecision): Promise<StoredChapterRevision>
  updateState(input: Readonly<{
    revisionTaskId: string
    status: ChapterRevision["status"]
    decision?: ChapterRevision["decision"]
    submissionMode?: ChapterRevision["submissionMode"]
    graphSyncStatus?: ChapterRevision["graphSyncStatus"]
    graphSyncTaskId?: string
    contentScopeId?: string
    updatedAtMs: number
  }>): Promise<StoredChapterRevision>
}
