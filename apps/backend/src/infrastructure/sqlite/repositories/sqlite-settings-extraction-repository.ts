import type { Kysely } from "kysely"

import type {
  SettingsExtractionProposal,
  SettingsProposalStatus,
} from "@worldseed/contracts"
import { settingsProposalPayloadSchema } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteSettingsExtractionRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async listByTask(taskId: string): Promise<readonly SettingsExtractionProposal[]> {
    const rows = await this.database.selectFrom("settings_extraction_proposals").selectAll()
      .where("task_id", "=", taskId)
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapProposal)
  }

  public async listPendingByTask(taskId: string): Promise<readonly SettingsExtractionProposal[]> {
    const rows = await this.database.selectFrom("settings_extraction_proposals").selectAll()
      .where("task_id", "=", taskId)
      .where("status", "=", "pending")
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapProposal)
  }

  public async find(proposalId: string): Promise<SettingsExtractionProposal | undefined> {
    const row = await this.database.selectFrom("settings_extraction_proposals").selectAll()
      .where("proposal_id", "=", proposalId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapProposal(row)
  }

  public async insert(proposal: SettingsExtractionProposal): Promise<void> {
    await this.database.insertInto("settings_extraction_proposals").values({
      proposal_id: proposal.proposalId,
      project_id: proposal.projectId,
      task_id: proposal.taskId,
      kind: proposal.kind,
      payload_json: encodeJson(proposal.payload),
      status: proposal.status,
      phase_run_id: proposal.phaseRunId ?? null,
      reason: proposal.reason ?? null,
      conflict_notes: proposal.conflictNotes ?? null,
      created_at_ms: proposal.createdAtMs,
      resolved_at_ms: proposal.resolvedAtMs ?? null,
    }).executeTakeFirstOrThrow()
  }

  public async resolve(
    proposalId: string,
    status: Exclude<SettingsProposalStatus, "pending">,
    resolvedAtMs: number,
  ): Promise<void> {
    await this.database.updateTable("settings_extraction_proposals").set({
      status,
      resolved_at_ms: resolvedAtMs,
    }).where("proposal_id", "=", proposalId).executeTakeFirstOrThrow()
  }
}

function mapProposal(row: {
  proposal_id: string
  project_id: string
  task_id: string
  kind: string
  payload_json: string
  status: string
  phase_run_id: string | null
  reason: string | null
  conflict_notes: string | null
  created_at_ms: number
  resolved_at_ms: number | null
}): SettingsExtractionProposal {
  return {
    proposalId: row.proposal_id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind as SettingsExtractionProposal["kind"],
    payload: settingsProposalPayloadSchema.parse(decodeJson(row.payload_json)),
    status: row.status as SettingsExtractionProposal["status"],
    ...(row.phase_run_id === null ? {} : { phaseRunId: row.phase_run_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.conflict_notes === null ? {} : { conflictNotes: row.conflict_notes }),
    createdAtMs: row.created_at_ms,
    ...(row.resolved_at_ms === null ? {} : { resolvedAtMs: row.resolved_at_ms }),
  }
}
