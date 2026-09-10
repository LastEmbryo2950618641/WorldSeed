import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"

import type {
  ModelContextMessage,
  ModelContextMessageDraft,
  ProjectId,
  SynopsisConversationChoice,
  SynopsisConversationMessage,
  SynopsisConversationSession,
  SynopsisConversationStreamUsage,
} from "@worldseed/contracts"
import {
  aiPhaseSchema,
  modelContextMessageDraftSchema,
  modelContextMessageKindSchema,
  modelContextMessageSchema,
  synopsisConversationChoiceSchema,
  synopsisConversationStreamEditSchema,
  synopsisConversationStreamSearchSchema,
  synopsisConversationThinkingRoundSchema,
} from "@worldseed/contracts"

import { digest } from "../../../core/index.js"
import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export type DiscussContextDigests = Readonly<{
  synopsis?: string
  outline?: string
  bootstrap?: string
}>

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
      .orderBy("status", "asc")
      .orderBy("updated_at_ms", "desc")
      .executeTakeFirst()
    return row === undefined ? undefined : mapSession(row)
  }

  public async maxChapterSequence(projectId: ProjectId): Promise<number | undefined> {
    const row = await this.database.selectFrom("synopsis_conversation_sessions")
      .select((eb) => eb.fn.max("chapter_sequence").as("max_sequence"))
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    const raw = row?.max_sequence
    const value = typeof raw === "number" ? raw : Number(raw)
    return Number.isFinite(value) ? value : undefined
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
      synopsis_confirmed_at_ms: null,
      last_outline_agent_digest: null,
      last_context_synopsis_digest: null,
      last_context_outline_digest: null,
      last_context_bootstrap_digest: null,
      focus_kind: "plot_synopsis",
      status: "active",
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()
    return (await this.findSession(input.sessionId)) as SynopsisConversationSession
  }

  public async updateSession(input: Readonly<{
    sessionId: string
    chapterSequence?: number
    synopsisPath?: string
    title?: string
    lastAgentDigest?: string | null
    lastOutlineAgentDigest?: string | null
    turnBootstrapInput?: string | null
    synopsisConfirmedAtMs?: number | null
    focusKind?: SynopsisConversationSession["focusKind"]
    status?: SynopsisConversationSession["status"]
    updatedAtMs: number
  }>): Promise<void> {
    await this.database.updateTable("synopsis_conversation_sessions").set({
      ...(input.chapterSequence === undefined ? {} : { chapter_sequence: input.chapterSequence }),
      ...(input.synopsisPath === undefined ? {} : { synopsis_path: input.synopsisPath }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.lastAgentDigest === undefined ? {} : { last_agent_digest: input.lastAgentDigest }),
      ...(input.lastOutlineAgentDigest === undefined
        ? {}
        : { last_outline_agent_digest: input.lastOutlineAgentDigest }),
      ...(input.turnBootstrapInput === undefined ? {} : { turn_bootstrap_input: input.turnBootstrapInput }),
      ...(input.synopsisConfirmedAtMs === undefined
        ? {}
        : { synopsis_confirmed_at_ms: input.synopsisConfirmedAtMs }),
      ...(input.focusKind === undefined ? {} : { focus_kind: input.focusKind }),
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

  public async listMessagesForProject(projectId: ProjectId): Promise<readonly SynopsisConversationMessage[]> {
    const rows = await this.database.selectFrom("synopsis_conversation_messages").selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapMessage)
  }

  public async findMessage(messageId: string): Promise<SynopsisConversationMessage | undefined> {
    const row = await this.database.selectFrom("synopsis_conversation_messages").selectAll()
      .where("id", "=", messageId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapMessage(row)
  }

  /** Deletes the last visible user message and every message after it in the session. */
  public async deleteLastVisibleUserTurn(sessionId: string): Promise<number> {
    const messages = await this.listMessages(sessionId)
    let lastUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message !== undefined && message.role === "user" && message.hidden !== true) {
        lastUserIndex = index
        break
      }
    }
    if (lastUserIndex < 0) return 0
    const ids = messages.slice(lastUserIndex).map((message) => message.messageId)
    if (ids.length === 0) return 0
    await this.database.deleteFrom("synopsis_conversation_messages")
      .where("id", "in", ids)
      .execute()
    return ids.length
  }

  public async appendMessage(input: Readonly<{
    messageId: string
    projectId: ProjectId
    sessionId: string
    role: SynopsisConversationMessage["role"]
    content: string
    reasoningContent?: string
    thinkingRounds?: SynopsisConversationMessage["thinkingRounds"]
    searching?: SynopsisConversationMessage["searching"]
    editing?: SynopsisConversationMessage["editing"]
    choices?: SynopsisConversationMessage["choices"]
    hidden?: boolean
    createdAtMs: number
  }>): Promise<SynopsisConversationMessage> {
    await this.database.insertInto("synopsis_conversation_messages").values({
      id: input.messageId,
      project_id: input.projectId,
      session_id: input.sessionId,
      role: input.role,
      content_text: input.content,
      reasoning_content: input.reasoningContent ?? null,
      thinking_rounds_json: input.thinkingRounds === undefined ? null : encodeJson(input.thinkingRounds),
      searching_json: input.searching === undefined ? null : encodeJson(input.searching),
      editing_json: input.editing === undefined ? null : encodeJson(input.editing),
      choices_json: input.choices === undefined ? null : encodeJson(input.choices),
      hidden: input.hidden === true ? 1 : 0,
      created_at_ms: input.createdAtMs,
    }).executeTakeFirstOrThrow()
    return {
      messageId: input.messageId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      ...(input.reasoningContent === undefined ? {} : { reasoningContent: input.reasoningContent }),
      ...(input.thinkingRounds === undefined ? {} : { thinkingRounds: input.thinkingRounds }),
      ...(input.searching === undefined ? {} : { searching: input.searching }),
      ...(input.editing === undefined ? {} : { editing: input.editing }),
      ...(input.choices === undefined ? {} : { choices: input.choices }),
      ...(input.hidden === true ? { hidden: true } : {}),
      createdAtMs: input.createdAtMs,
    }
  }

  public async updateMessageChoices(
    messageId: string,
    choices: readonly SynopsisConversationChoice[],
  ): Promise<void> {
    await this.database.updateTable("synopsis_conversation_messages").set({
      choices_json: encodeJson(choices),
    }).where("id", "=", messageId).executeTakeFirstOrThrow()
  }

  public async loadDiscussUsage(projectId: ProjectId): Promise<SynopsisConversationStreamUsage | undefined> {
    const row = await this.database.selectFrom("synopsis_discuss_usage").selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    if (row === undefined) return undefined
    return mapDiscussUsage(row)
  }

  public async saveDiscussUsage(input: Readonly<{
    projectId: ProjectId
    usage: SynopsisConversationStreamUsage
    updatedAtMs: number
  }>): Promise<void> {
    const values = {
      project_id: input.projectId,
      input_tokens: input.usage.inputTokens ?? 0,
      output_tokens: input.usage.outputTokens ?? 0,
      cache_hit_input_tokens: input.usage.cacheHitInputTokens ?? 0,
      cache_miss_input_tokens: input.usage.cacheMissInputTokens ?? 0,
      last_request_input_tokens: input.usage.lastRequestInputTokens ?? null,
      updated_at_ms: input.updatedAtMs,
    }
    await this.database.insertInto("synopsis_discuss_usage").values(values)
      .onConflict((oc) => oc.column("project_id").doUpdateSet({
        input_tokens: values.input_tokens,
        output_tokens: values.output_tokens,
        cache_hit_input_tokens: values.cache_hit_input_tokens,
        cache_miss_input_tokens: values.cache_miss_input_tokens,
        last_request_input_tokens: values.last_request_input_tokens,
        updated_at_ms: values.updated_at_ms,
      }))
      .executeTakeFirstOrThrow()
  }

  public async listDiscussContextMessages(sessionId: string): Promise<readonly ModelContextMessage[]> {
    const rows = await this.database.selectFrom("synopsis_discuss_context_messages").selectAll()
      .where("session_id", "=", sessionId)
      .where("hidden_at", "is", null)
      .orderBy("sequence_no", "asc")
      .execute()
    return rows.map(mapDiscussContextMessage)
  }

  public async appendDiscussContextMessages(input: Readonly<{
    sessionId: string
    projectId: ProjectId
    createdAtMs: number
    messages: readonly ModelContextMessageDraft[]
  }>): Promise<void> {
    if (input.messages.length === 0) return
    const drafts = input.messages.map((message) => modelContextMessageDraftSchema.parse(message))
    await this.database.transaction().execute(async (transaction) => {
      const latest = await transaction.selectFrom("synopsis_discuss_context_messages")
        .select("sequence_no")
        .where("session_id", "=", input.sessionId)
        .orderBy("sequence_no", "desc")
        .executeTakeFirst()
      const startSequence = latest === undefined ? 0 : latest.sequence_no + 1
      await transaction.insertInto("synopsis_discuss_context_messages").values(
        drafts.map((message, index) => {
          const content = message.content
          if (content === undefined) throw new Error("Discuss context message requires inline content")
          return {
            id: randomUUID(),
            project_id: input.projectId,
            session_id: input.sessionId,
            sequence_no: startSequence + index,
            role: message.role,
            kind: message.kind,
            task_id: message.taskId ?? null,
            turn_id: message.turnId ?? null,
            phase: message.phase ?? null,
            content_text: content,
            content_digest: digest(content),
            token_estimate: estimateDiscussContextTokens(content),
            hidden_at: null,
            created_at_ms: input.createdAtMs,
          }
        }),
      ).execute()
    })
  }

  public async hideDiscussContextMessages(
    sessionId: string,
    messageIds: readonly string[],
    hiddenAtMs: number,
  ): Promise<void> {
    if (messageIds.length === 0) return
    await this.database.updateTable("synopsis_discuss_context_messages").set({ hidden_at: hiddenAtMs })
      .where("session_id", "=", sessionId)
      .where("id", "in", [...messageIds])
      .where("hidden_at", "is", null)
      .execute()
  }

  public async deleteDiscussContextMessagesForTurn(sessionId: string, turnId: string): Promise<void> {
    await this.database.deleteFrom("synopsis_discuss_context_messages")
      .where("session_id", "=", sessionId)
      .where("turn_id", "=", turnId)
      .execute()
  }

  public async deleteLastDiscussContextTurn(sessionId: string): Promise<void> {
    const last = await this.database.selectFrom("synopsis_discuss_context_messages")
      .select("turn_id")
      .where("session_id", "=", sessionId)
      .where("kind", "=", "phase_request")
      .where("turn_id", "is not", null)
      .orderBy("sequence_no", "desc")
      .executeTakeFirst()
    if (last?.turn_id === undefined || last.turn_id === null) return
    await this.deleteDiscussContextMessagesForTurn(sessionId, last.turn_id)
  }

  public async readDiscussContextDigests(sessionId: string): Promise<DiscussContextDigests> {
    const row = await this.database.selectFrom("synopsis_conversation_sessions")
      .select([
        "last_context_synopsis_digest",
        "last_context_outline_digest",
        "last_context_bootstrap_digest",
      ])
      .where("session_id", "=", sessionId)
      .executeTakeFirst()
    return {
      ...(row?.last_context_synopsis_digest === undefined || row.last_context_synopsis_digest === null
        ? {}
        : { synopsis: row.last_context_synopsis_digest }),
      ...(row?.last_context_outline_digest === undefined || row.last_context_outline_digest === null
        ? {}
        : { outline: row.last_context_outline_digest }),
      ...(row?.last_context_bootstrap_digest === undefined || row.last_context_bootstrap_digest === null
        ? {}
        : { bootstrap: row.last_context_bootstrap_digest }),
    }
  }

  public async saveDiscussContextDigests(input: Readonly<{
    sessionId: string
    synopsisDigest?: string | null
    outlineDigest?: string | null
    bootstrapDigest?: string | null
    updatedAtMs: number
  }>): Promise<void> {
    await this.database.updateTable("synopsis_conversation_sessions").set({
      ...(input.synopsisDigest === undefined ? {} : { last_context_synopsis_digest: input.synopsisDigest }),
      ...(input.outlineDigest === undefined ? {} : { last_context_outline_digest: input.outlineDigest }),
      ...(input.bootstrapDigest === undefined ? {} : { last_context_bootstrap_digest: input.bootstrapDigest }),
      updated_at_ms: input.updatedAtMs,
    }).where("session_id", "=", input.sessionId).executeTakeFirstOrThrow()
  }
}

function mapSession(row: {
  session_id: string
  project_id: string
  chapter_sequence: number
  synopsis_path: string
  title: string
  last_agent_digest: string | null
  last_outline_agent_digest: string | null
  turn_bootstrap_input: string | null
  synopsis_confirmed_at_ms: number | null
  focus_kind?: string | null
  status: "active" | "completed"
  created_at_ms: number
  updated_at_ms: number
}): SynopsisConversationSession {
  const focusKind = row.focus_kind === "plot_outline" || row.focus_kind === "chapter_body"
    ? row.focus_kind
    : "plot_synopsis"
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    chapterSequence: row.chapter_sequence,
    synopsisPath: row.synopsis_path,
    title: row.title,
    ...(row.last_agent_digest === null ? {} : { lastAgentDigest: row.last_agent_digest }),
    ...(row.last_outline_agent_digest === null
      ? {}
      : { lastOutlineAgentDigest: row.last_outline_agent_digest }),
    ...(row.turn_bootstrap_input === null ? {} : { turnBootstrapInput: row.turn_bootstrap_input }),
    ...(row.synopsis_confirmed_at_ms === null
      ? {}
      : { synopsisConfirmedAtMs: row.synopsis_confirmed_at_ms }),
    focusKind,
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapDiscussContextMessage(row: {
  id: string
  project_id: string
  session_id: string
  sequence_no: number
  role: "system" | "user" | "assistant"
  kind: string
  task_id: string | null
  turn_id: string | null
  phase: string | null
  content_text: string
  content_digest: string
  token_estimate: number
  created_at_ms: number
}): ModelContextMessage {
  return modelContextMessageSchema.parse({
    messageId: row.id,
    chainId: row.session_id,
    projectId: row.project_id,
    sequence: row.sequence_no,
    role: row.role,
    kind: modelContextMessageKindSchema.parse(row.kind),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.phase === null ? {} : { phase: aiPhaseSchema.parse(row.phase) }),
    content: row.content_text,
    contentDigest: row.content_digest,
    tokenEstimate: row.token_estimate,
    createdAtMs: row.created_at_ms,
  })
}

function estimateDiscussContextTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4))
}

function mapDiscussUsage(row: {
  input_tokens: number
  output_tokens: number
  cache_hit_input_tokens: number
  cache_miss_input_tokens: number
  last_request_input_tokens: number | null
}): SynopsisConversationStreamUsage | undefined {
  const usage: SynopsisConversationStreamUsage = {
    ...(row.input_tokens === 0 ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === 0 ? {} : { outputTokens: row.output_tokens }),
    ...(row.cache_hit_input_tokens === 0 ? {} : { cacheHitInputTokens: row.cache_hit_input_tokens }),
    ...(row.cache_miss_input_tokens === 0 ? {} : { cacheMissInputTokens: row.cache_miss_input_tokens }),
    ...(row.last_request_input_tokens === null
      ? {}
      : { lastRequestInputTokens: row.last_request_input_tokens }),
  }
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  if (total === 0 && (usage.cacheHitInputTokens ?? 0) + (usage.cacheMissInputTokens ?? 0) === 0) {
    return undefined
  }
  return usage
}

function mapMessage(row: {
  id: string
  project_id: string
  session_id: string
  role: "user" | "assistant" | "system"
  content_text: string
  reasoning_content: string | null
  searching_json: string | null
  editing_json: string | null
  thinking_rounds_json: string | null
  choices_json: string | null
  hidden: number
  created_at_ms: number
}): SynopsisConversationMessage {
  const choices = row.choices_json === null
    ? undefined
    : parseChoices(decodeJson(row.choices_json))
  const searching = row.searching_json === null
    ? undefined
    : parseSearching(decodeJson(row.searching_json))
  const editing = row.editing_json === null
    ? undefined
    : parseEditing(decodeJson(row.editing_json))
  const thinkingRounds = row.thinking_rounds_json === null
    ? undefined
    : parseThinkingRounds(decodeJson(row.thinking_rounds_json))
  return {
    messageId: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content_text,
    ...(row.reasoning_content === null || row.reasoning_content.length === 0
      ? {}
      : { reasoningContent: row.reasoning_content }),
    ...(thinkingRounds === undefined ? {} : { thinkingRounds }),
    ...(searching === undefined ? {} : { searching }),
    ...(editing === undefined ? {} : { editing }),
    ...(choices === undefined ? {} : { choices }),
    ...(row.hidden === 1 ? { hidden: true } : {}),
    createdAtMs: row.created_at_ms,
  }
}

function parseChoices(value: unknown): SynopsisConversationMessage["choices"] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => synopsisConversationChoiceSchema.parse(item))
}

function parseSearching(value: unknown): SynopsisConversationMessage["searching"] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => synopsisConversationStreamSearchSchema.parse(item))
}

function parseEditing(value: unknown): SynopsisConversationMessage["editing"] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => synopsisConversationStreamEditSchema.parse(item))
}

function parseThinkingRounds(value: unknown): SynopsisConversationMessage["thinkingRounds"] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => synopsisConversationThinkingRoundSchema.parse(item))
}
