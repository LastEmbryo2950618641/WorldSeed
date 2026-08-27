import type { ModelContextMessage, ProjectId } from "@worldseed/contracts"

import { estimateModelMessageTokens } from "../context/context-window-manager.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"
import type { DocumentRepository } from "../turns/ports/document-repository.js"
import type { TurnPersistencePort } from "../turns/ports/turn-persistence.js"
import type { InternalStorePort } from "../workspace/ports/workspace-port.js"

export type HydratedModelContextMessage = ModelContextMessage & Readonly<{
  content: string
  tokenEstimate: number
}>

export type ChapterContextResolverDependencies = Readonly<{
  documents: DocumentRepository
  internalStore: InternalStorePort
  persistence: TurnPersistencePort
}>

const NARRATIVE_CHAPTER_KINDS = new Set<ModelContextMessage["kind"]>(["canonical_chapter", "chapter_revision"])

export function isNarrativeChapterMessageKind(kind: ModelContextMessage["kind"]): boolean {
  return NARRATIVE_CHAPTER_KINDS.has(kind)
}

export class ChapterContextResolver {
  public constructor(private readonly dependencies: ChapterContextResolverDependencies) {}

  public async hydrateNarrativeMessages(
    projectId: ProjectId,
    messages: readonly ModelContextMessage[],
  ): Promise<readonly HydratedModelContextMessage[]> {
    const heads = new Map(
      (await this.dependencies.documents.listCommittedChapters(projectId)).map((chapter) => [chapter.chapterId, chapter]),
    )
    const canonicalSources = await this.dependencies.persistence.listCanonicalChapterMessageSources(projectId)
    const canonicalByMessageId = new Map(canonicalSources.map((entry) => [entry.messageId, entry]))
    const revisionSummaryCache = new Map<string, Awaited<ReturnType<TurnPersistencePort["findChapterRevisionSummaryByTaskId"]>>>()

    return Promise.all(messages.map(async (message) => {
      const rawContent = message.content ?? await this.dependencies.internalStore.readDocument(message.contentRef as string)
      if (!isNarrativeChapterMessageKind(message.kind)) {
        return {
          ...message,
          content: rawContent,
          tokenEstimate: estimateModelMessageTokens(rawContent),
        }
      }

      const chapterBinding = await this.resolveChapterBinding(
        message,
        canonicalByMessageId,
        revisionSummaryCache,
      )
      if (chapterBinding === undefined) {
        return {
          ...message,
          content: rawContent,
          tokenEstimate: estimateModelMessageTokens(rawContent),
        }
      }

      const head = heads.get(chapterBinding.chapterId)
      if (head === undefined || head.sourceId === chapterBinding.sourceId) {
        return {
          ...message,
          content: rawContent,
          tokenEstimate: estimateModelMessageTokens(rawContent),
        }
      }

      const resolvedContent = await this.dependencies.internalStore.readDocument(head.contentRef)
      runtimeLog("debug", "chapter-context-resolver", "narrative.superseded", {
        messageId: message.messageId,
        kind: message.kind,
        chapterId: chapterBinding.chapterId,
        chainSourceId: chapterBinding.sourceId,
        headSourceId: head.sourceId,
        chainDigest: message.contentDigest,
        headDigest: head.digest,
      })
      return {
        ...message,
        content: resolvedContent,
        tokenEstimate: estimateModelMessageTokens(resolvedContent),
      }
    }))
  }

  private async resolveChapterBinding(
    message: ModelContextMessage,
    canonicalByMessageId: ReadonlyMap<string, { messageId: string; sourceId: string; contentDigest: string }>,
    revisionSummaryCache: Map<string, Awaited<ReturnType<TurnPersistencePort["findChapterRevisionSummaryByTaskId"]>>>,
  ): Promise<Readonly<{ chapterId: string; sourceId: string }> | undefined> {
    if (message.kind === "canonical_chapter") {
      const registration = canonicalByMessageId.get(message.messageId)
      if (registration === undefined) return undefined
      const version = await this.dependencies.documents.findStoredVersion(message.projectId, registration.sourceId)
      if (version === undefined) return undefined
      return { chapterId: version.chapterId, sourceId: registration.sourceId }
    }

    if (message.kind !== "chapter_revision" || message.taskId === undefined) return undefined
    let summary = revisionSummaryCache.get(message.taskId)
    if (summary === undefined) {
      summary = await this.dependencies.persistence.findChapterRevisionSummaryByTaskId(message.taskId)
      revisionSummaryCache.set(message.taskId, summary)
    }
    if (summary === undefined) return undefined
    return { chapterId: summary.chapterId, sourceId: summary.proposedSourceId }
  }
}
