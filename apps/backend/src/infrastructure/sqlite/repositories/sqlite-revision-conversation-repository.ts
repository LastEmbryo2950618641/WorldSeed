import type { Kysely } from "kysely"

import type {
  ChapterRevisionConversationMessage,
  ChapterRevisionConversationProposal,
  ProjectId,
} from "@worldseed/contracts"
import { chapterRevisionConversationProposalSchema } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteRevisionConversationRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async listByRevision(revisionTaskId: string): Promise<readonly ChapterRevisionConversationMessage[]> {
    const rows = await this.database.selectFrom("revision_conversation_messages").selectAll()
      .where("revision_task_id", "=", revisionTaskId)
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map((row) => mapMessage(row))
  }

  public async findMessage(messageId: string): Promise<ChapterRevisionConversationMessage | undefined> {
    const row = await this.database.selectFrom("revision_conversation_messages").selectAll()
      .where("id", "=", messageId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapMessage(row)
  }

  public async append(input: Readonly<{
    messageId: string
    projectId: ProjectId
    revisionTaskId: string
    role: ChapterRevisionConversationMessage["role"]
    content: string
    proposal?: ChapterRevisionConversationProposal
    createdAtMs: number
  }>): Promise<ChapterRevisionConversationMessage> {
    await this.database.insertInto("revision_conversation_messages").values({
      id: input.messageId,
      project_id: input.projectId,
      revision_task_id: input.revisionTaskId,
      role: input.role,
      content_text: input.content,
      proposal_json: input.proposal === undefined ? null : encodeJson(input.proposal),
      created_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()
    return {
      messageId: input.messageId,
      projectId: input.projectId,
      revisionTaskId: input.revisionTaskId,
      role: input.role,
      content: input.content,
      ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
      createdAtMs: input.createdAtMs,
    }
  }
}

function mapMessage(row: {
  id: string
  project_id: string
  revision_task_id: string
  role: "user" | "assistant" | "system"
  content_text: string
  proposal_json: string | null
  created_at_ms: number
}): ChapterRevisionConversationMessage {
  const proposal = row.proposal_json === null
    ? undefined
    : chapterRevisionConversationProposalSchema.parse(decodeJson(row.proposal_json))
  return {
    messageId: row.id,
    projectId: row.project_id,
    revisionTaskId: row.revision_task_id,
    role: row.role,
    content: row.content_text,
    ...(proposal === undefined ? {} : { proposal }),
    createdAtMs: row.created_at_ms,
  }
}
