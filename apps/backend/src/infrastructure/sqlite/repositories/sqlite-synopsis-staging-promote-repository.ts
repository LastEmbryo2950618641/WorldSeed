import type { Kysely } from "kysely"

import type {
  SynopsisStagingPromoteProposal,
  SynopsisStagingPromoteStatus,
} from "@worldseed/contracts"
import { synopsisStagingPromoteProposalSchema } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteSynopsisStagingPromoteRepository {
  public constructor(private readonly database: Kysely<ProjectDatabase>) {}

  public async listPendingByProject(projectId: string): Promise<readonly SynopsisStagingPromoteProposal[]> {
    const rows = await this.database.selectFrom("synopsis_staging_promote_proposals").selectAll()
      .where("project_id", "=", projectId)
      .where("status", "=", "pending")
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapProposal)
  }

  public async listPendingBySession(sessionId: string): Promise<readonly SynopsisStagingPromoteProposal[]> {
    const rows = await this.database.selectFrom("synopsis_staging_promote_proposals").selectAll()
      .where("session_id", "=", sessionId)
      .where("status", "=", "pending")
      .orderBy("created_at_ms", "asc")
      .execute()
    return rows.map(mapProposal)
  }

  public async find(proposalId: string): Promise<SynopsisStagingPromoteProposal | undefined> {
    const row = await this.database.selectFrom("synopsis_staging_promote_proposals").selectAll()
      .where("proposal_id", "=", proposalId)
      .executeTakeFirst()
    return row === undefined ? undefined : mapProposal(row)
  }

  public async insert(proposal: SynopsisStagingPromoteProposal): Promise<void> {
    await this.database.insertInto("synopsis_staging_promote_proposals").values({
      proposal_id: proposal.proposalId,
      project_id: proposal.projectId,
      session_id: proposal.sessionId,
      status: proposal.status,
      settings_writes_json: encodeJson(proposal.settingsWrites),
      goal_proposals_json: proposal.goalProposals === undefined ? null : encodeJson(proposal.goalProposals),
      reason: proposal.reason ?? null,
      source_message_id: proposal.sourceMessageId ?? null,
      created_at_ms: proposal.createdAtMs,
      resolved_at_ms: proposal.resolvedAtMs ?? null,
    }).executeTakeFirstOrThrow()
  }

  public async resolve(
    proposalId: string,
    status: Exclude<SynopsisStagingPromoteStatus, "pending">,
    resolvedAtMs: number,
  ): Promise<void> {
    await this.database.updateTable("synopsis_staging_promote_proposals").set({
      status,
      resolved_at_ms: resolvedAtMs,
    }).where("proposal_id", "=", proposalId).executeTakeFirstOrThrow()
  }
}

function mapProposal(row: {
  proposal_id: string
  project_id: string
  session_id: string
  status: string
  settings_writes_json: string
  goal_proposals_json: string | null
  reason: string | null
  source_message_id: string | null
  created_at_ms: number
  resolved_at_ms: number | null
}): SynopsisStagingPromoteProposal {
  return synopsisStagingPromoteProposalSchema.parse({
    proposalId: row.proposal_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    status: row.status,
    settingsWrites: decodeJson(row.settings_writes_json),
    ...(row.goal_proposals_json === null ? {} : { goalProposals: decodeJson(row.goal_proposals_json) }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    createdAtMs: row.created_at_ms,
    ...(row.resolved_at_ms === null ? {} : { resolvedAtMs: row.resolved_at_ms }),
  })
}
