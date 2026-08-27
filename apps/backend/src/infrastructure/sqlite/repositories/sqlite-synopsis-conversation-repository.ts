import type { Kysely } from "kysely"

import type {
  ProjectId,
  SynopsisConversationMessage,
  SynopsisConversationSession,
} from "@worldseed/contracts"
import { synopsisConversationChoiceSchema } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteSynopsisConversationRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async findActiveSession(projectId: ProjectId): Promise<SynopsisConversationSession | undefined> {
    const row = await this.database.selectFrom("synopsis_conversation_sessions").selectAll()
      .where("project_id", "=", projectId)
      .where("status", "=", "active")
      .orderBy("updated_at_ms", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : mapSession(row)
  }

  public async findSession(sessionId: string): Promise<SynopsisConversationSession | undefined> {
    const row = await this.database.selectFrom("synopsis_conversation_sessions").selectAll()
      .where("session_id", "=", sessionId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapSession(row)
  }

  public async findBySequence(projectId: ProjectId, chapterSequence: number): Promise<SynopsisConversationSession | undefined> {
    const row = await this.database.selectFrom("synopsis_conversation_sessions").selectAll()
      .where("project_id", "=", projectId)
      .where("chapter_sequence", "=", chapterSequence)
      .executeTakeFirst()
    return row === undefined ? undefined : mapSession(row)
  }

  public async createSession(input: Readonly<{
    sessionId: string
    projectId: ProjectId
    chapterSequence: number
    synopsisPath: string
    title: string
    createdAtMs: number
  }>): Promise<SynopsisConversationSession> {
    await this.database.insertInto("synopsis_conversation_sessions").values({
      session_id: input.sessionId,
      project_id: input.projectId,
      chapter_sequence: input.chapterSequence,
      synopsis_path: input.synopsisPath,
      title: input.title,
      last_agent_digest: null,
      turn_bootstrap_input: null,
      status: "active",
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()
    return (await this.findSession(input.sessionId)) as SynopsisConversationSession
  }

  public async updateSession(input: Readonly<{
    sessionId: string
    synopsisPath?: string
    title?: string
    lastAgentDigest?: string | null
    turnBootstrapInput?: string | null
    status?: SynopsisConversationSession["status"]
    updatedAtMs: number
  }>): Promise<void> {
    await this.database.updateTable("synopsis_conversation_sessions").set({
      ...(input.synopsisPath === undefined ? {} : { synopsis_path: input.synopsisPath }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.lastAgentDigest === undefined ? {} : { last_agent_digest: input.lastAgentDigest }),
      ...(input.turnBootstrapInput === undefined ? {} : { turn_bootstrap_input: input.turnBootstrapInput }),
      ...(input.status === undefined ? {} : { status: input.status }),
      updated_at_ms: input.updatedAtMs,
    }).where("session_id", "=", input.sessionId).executeTakeFirstOrThrow()
  }

  public async listMessages(sessionId: string): Promise<readonly SynopsisConversationMessage[]> {
    const rows = await this.database.selectFrom("synopsis_conversation_messages").selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapMessage)
  }

  public async appendMessage(input: Readonly<{
    messageId: string
    projectId: ProjectId
    sessionId: string
    role: SynopsisConversationMessage["role"]
    content: string
    choices?: SynopsisConversationMessage["choices"]
    createdAtMs: number
  }>): Promise<SynopsisConversationMessage> {
    await this.database.insertInto("synopsis_conversation_messages").values({
      id: input.messageId,
      project_id: input.projectId,
      session_id: input.sessionId,
      role: input.role,
      content_text: input.content,
      choices_json: input.choices === undefined ? null : encodeJson(input.choices),
      created_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()
    return {
      messageId: input.messageId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      ...(input.choices === undefined ? {} : { choices: input.choices }),
      createdAtMs: input.createdAtMs,
    }
  }
}

function mapSession(row: {
  session_id: string
  project_id: string
  chapter_sequence: number
  synopsis_path: string
  title: string
  last_agent_digest: string | null
  turn_bootstrap_input: string | null
  status: "active" | "completed"
  created_at_ms: number
  updated_at_ms: number
}): SynopsisConversationSession {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    chapterSequence: row.chapter_sequence,
    synopsisPath: row.synopsis_path,
    title: row.title,
    ...(row.last_agent_digest === null ? {} : { lastAgentDigest: row.last_agent_digest }),
    ...(row.turn_bootstrap_input === null ? {} : { turnBootstrapInput: row.turn_bootstrap_input }),
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapMessage(row: {
  id: string
  project_id: string
  session_id: string
  role: "user" | "assistant" | "system"
  content_text: string
  choices_json: string | null
  created_at_ms: number
}): SynopsisConversationMessage {
  const choices = row.choices_json === null
    ? undefined
    : parseChoices(decodeJson(row.choices_json))
  return {
    messageId: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content_text,
    ...(choices === undefined ? {} : { choices }),
    createdAtMs: row.created_at_ms,
  }
}

function parseChoices(value: unknown): SynopsisConversationMessage["choices"] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => synopsisConversationChoiceSchema.parse(item))
}
