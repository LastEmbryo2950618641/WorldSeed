import type { ChapterSynopsis, ProjectId } from "@worldseed/contracts"

import type { WorkspacePort } from "../workspace/index.js"
import type { SqliteChapterSynopsisRepository } from "../../infrastructure/sqlite/repositories/sqlite-chapter-synopsis-repository.js"
import type { SqliteSynopsisConversationRepository } from "../../infrastructure/sqlite/repositories/sqlite-synopsis-conversation-repository.js"
import { runtimeLog } from "../../infrastructure/diagnostics/index.js"

export type ChapterSynopsisServiceDependencies = Readonly<{
  synopsis: SqliteChapterSynopsisRepository
  conversation: SqliteSynopsisConversationRepository
  workspace: WorkspacePort
  now: () => number
}>

export class ChapterSynopsisService {
  public constructor(private readonly dependencies: ChapterSynopsisServiceDependencies) {}

  public async get(input: Readonly<{
    projectId: ProjectId
    chapterId?: string
    publishPath?: string
  }>): Promise<ChapterSynopsis | undefined> {
    if (input.chapterId !== undefined) {
      return this.dependencies.synopsis.findByChapterId(input.projectId, input.chapterId)
    }
    if (input.publishPath !== undefined) {
      return this.dependencies.synopsis.findByChapterPath(input.projectId, input.publishPath)
    }
    return undefined
  }

  public async linkAfterPublish(input: Readonly<{
    projectId: ProjectId
    workspaceRootRef: string
    chapterId: string
    chapterSequence: number
    chapterPath: string
  }>): Promise<void> {
    const session = await this.dependencies.conversation.findBySequence(input.projectId, input.chapterSequence)
    if (session === undefined) return

    const synopsisMarkdown = await this.resolveArchiveMarkdown(input.workspaceRootRef, session)
    if (synopsisMarkdown.trim().length === 0) {
      await this.cleanupSynopsisFile(input.workspaceRootRef, session.synopsisPath)
      await this.completeSession(session.sessionId)
      return
    }

    const source = await this.resolveArchiveSource(input.workspaceRootRef, session)
    await this.dependencies.synopsis.upsert(input.projectId, {
      chapterId: input.chapterId,
      chapterSequence: input.chapterSequence,
      chapterPath: input.chapterPath,
      synopsisMarkdown,
      source,
      originalSynopsisPath: session.synopsisPath,
      ...(session.turnBootstrapInput === undefined ? {} : { turnBootstrapInput: session.turnBootstrapInput }),
      linkedAtMs: this.dependencies.now(),
    })
    await this.cleanupSynopsisFile(input.workspaceRootRef, session.synopsisPath)
    await this.completeSession(session.sessionId)
    runtimeLog("debug", "chapter-synopsis", "linked", {
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterSequence: input.chapterSequence,
      source,
    })
  }

  private async resolveArchiveMarkdown(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findBySequence"]>>>,
  ): Promise<string> {
    try {
      const fileContent = await this.dependencies.workspace.readMarkdown(workspaceRootRef, session.synopsisPath)
      if (fileContent.trim().length > 0) return fileContent
    } catch {
      // fall through
    }
    if (session.turnBootstrapInput !== undefined && session.turnBootstrapInput.trim().length > 0) {
      return session.turnBootstrapInput
    }
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    if (messages.length === 0) return ""
    return messages.map((message) => {
      const speaker = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : "系统"
      return `${speaker}：${message.content}`
    }).join("\n\n")
  }

  private async resolveArchiveSource(
    workspaceRootRef: string,
    session: NonNullable<Awaited<ReturnType<SqliteSynopsisConversationRepository["findBySequence"]>>>,
  ): Promise<ChapterSynopsis["source"]> {
    try {
      const fileContent = await this.dependencies.workspace.readMarkdown(workspaceRootRef, session.synopsisPath)
      if (fileContent.trim().length > 0) return "synopsis_file"
    } catch {
      // fall through
    }
    const messages = await this.dependencies.conversation.listMessages(session.sessionId)
    if (messages.length > 0) return "conversation"
    return "turn_input"
  }

  private async cleanupSynopsisFile(workspaceRootRef: string, synopsisPath: string): Promise<void> {
    try {
      await this.dependencies.workspace.removeSynopsisMarkdown(workspaceRootRef, synopsisPath)
    } catch {
      // file may already be removed
    }
  }

  private async completeSession(sessionId: string): Promise<void> {
    await this.dependencies.conversation.updateSession({
      sessionId,
      status: "completed",
      updatedAtMs: this.dependencies.now(),
    })
  }
}
