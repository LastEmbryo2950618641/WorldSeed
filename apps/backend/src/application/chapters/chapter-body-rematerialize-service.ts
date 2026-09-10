import type { ProjectId } from "@worldseed/contracts"

import type { ChapterIndexRecord } from "../../infrastructure/sqlite/repositories/sqlite-chapter-index-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"
import type { DocumentRepository } from "../turns/ports/document-repository.js"
import type { InternalStorePort, WorkspacePort } from "../workspace/index.js"
import type { ChapterSynopsisService } from "./chapter-synopsis-service.js"

export type ChapterBodyRematerializeResult = Readonly<{
  checked: number
  restored: number
  aligned: number
  headsRepaired: number
  skipped: number
  paths: readonly string[]
}>

export type ChapterBodyRematerializeServiceDependencies = Readonly<{
  chapterIndex: {
    list(projectId: ProjectId): Promise<readonly ChapterIndexRecord[]>
  }
  documents: DocumentRepository
  internalStore: InternalStorePort
  workspace: WorkspacePort
  chapterSynopsis: ChapterSynopsisService
}>

/**
 * Product recovery: when chapter_index points at a formal body path that is missing
 * on disk, rewrite that .md from the immutable contentRef and align planning titles.
 * Also repairs missing active_document_heads when document_versions still exist.
 * Does not start a new formal turn.
 */
export class ChapterBodyRematerializeService {
  public constructor(private readonly dependencies: ChapterBodyRematerializeServiceDependencies) {}

  public async rematerializeMissingBodies(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
  }>): Promise<ChapterBodyRematerializeResult> {
    const indices = await this.dependencies.chapterIndex.list(input.projectId)
    const restoredPaths: string[] = []
    let aligned = 0
    let headsRepaired = 0
    let skipped = 0

    for (const index of indices) {
      const publishPath = index.currentPublishPath.trim()
      if (publishPath.length === 0) {
        skipped += 1
        continue
      }

      const version = await this.resolveDocumentVersion(input.projectId, index)
      if (version === undefined) {
        runtimeLog("warn", "chapter-body-rematerialize", "missing_content_ref", {
          projectId: input.projectId,
          chapterId: index.chapterId,
          sequence: index.sequence,
          publishPath,
          currentSourceId: index.currentSourceId,
        })
        skipped += 1
        continue
      }

      const currentHead = await this.dependencies.documents.findCurrentChapter(input.projectId, index.chapterId)
      if (currentHead === undefined) {
        try {
          await this.dependencies.documents.ensureActiveDocumentHead(version)
          headsRepaired += 1
          runtimeLog("info", "chapter-body-rematerialize", "head_repaired", {
            projectId: input.projectId,
            chapterId: index.chapterId,
            sequence: index.sequence,
            sourceId: version.sourceId,
            documentVersionId: version.id,
          })
        } catch (error) {
          runtimeLog("warn", "chapter-body-rematerialize", "head_repair_failed", {
            projectId: input.projectId,
            chapterId: index.chapterId,
            sequence: index.sequence,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const existing = await this.tryReadPublishedBody(input.workspaceRootRef, publishPath)
      if (existing !== undefined) {
        skipped += 1
        continue
      }

      let content: string
      try {
        content = await this.dependencies.internalStore.readDocument(version.contentRef)
      } catch (error) {
        runtimeLog("warn", "chapter-body-rematerialize", "read_document_failed", {
          projectId: input.projectId,
          chapterId: index.chapterId,
          sequence: index.sequence,
          publishPath,
          contentRef: version.contentRef,
          error: error instanceof Error ? error.message : String(error),
        })
        skipped += 1
        continue
      }

      if (content.trim().length === 0) {
        skipped += 1
        continue
      }

      try {
        await this.dependencies.workspace.publishChapter(input.workspaceRootRef, publishPath, content)
      } catch (error) {
        runtimeLog("warn", "chapter-body-rematerialize", "publish_failed", {
          projectId: input.projectId,
          chapterId: index.chapterId,
          sequence: index.sequence,
          publishPath,
          error: error instanceof Error ? error.message : String(error),
        })
        skipped += 1
        continue
      }

      restoredPaths.push(publishPath)

      // Prefer on-disk publish path stem (same as linkAfterPublish) so planning titles
      // match the rematerialized formal body filename.
      const pathHeading = publishPath
        .replaceAll("\\", "/")
        .split("/")
        .at(-1)
        ?.replace(/\.md$/u, "")
        ?.trim()
      const heading = (pathHeading !== undefined && pathHeading.length > 0)
        ? pathHeading
        : version.heading.trim()
      if (heading.length > 0) {
        try {
          await this.dependencies.chapterSynopsis.alignPlanningTitlesToPublishedHeading({
            projectId: input.projectId,
            workspaceRootRef: input.workspaceRootRef,
            chapterSequence: index.sequence,
            chapterHeading: heading,
            chapterPath: publishPath,
          })
          aligned += 1
        } catch (error) {
          runtimeLog("warn", "chapter-body-rematerialize", "align_planning_failed", {
            projectId: input.projectId,
            chapterId: index.chapterId,
            sequence: index.sequence,
            publishPath,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    const result = {
      checked: indices.length,
      restored: restoredPaths.length,
      aligned,
      headsRepaired,
      skipped,
      paths: restoredPaths,
    }
    if (restoredPaths.length > 0 || headsRepaired > 0) {
      runtimeLog("info", "chapter-body-rematerialize", "restored", {
        projectId: input.projectId,
        ...result,
      })
    } else {
      runtimeLog("debug", "chapter-body-rematerialize", "noop", {
        projectId: input.projectId,
        ...result,
      })
    }
    return result
  }

  private async resolveDocumentVersion(projectId: ProjectId, index: ChapterIndexRecord) {
    const byChapter = await this.dependencies.documents.findCurrentChapter(projectId, index.chapterId)
    if (byChapter !== undefined) return byChapter
    return this.dependencies.documents.findStoredVersion(projectId, index.currentSourceId)
  }

  private async tryReadPublishedBody(workspaceRootRef: string, relativePath: string): Promise<string | undefined> {
    try {
      return await this.dependencies.workspace.readMarkdown(workspaceRootRef, relativePath)
    } catch {
      return undefined
    }
  }
}
