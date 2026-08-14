import type { Kysely } from "kysely"

import {
  formatPersistentId,
  persistentIdPrefixSchema,
  type PersistentIdPrefix,
  type ProjectId,
} from "@worldseed/contracts"

import type { ProjectIdAllocatorPort } from "../../../application/ids/index.js"
import type { ProjectDatabase } from "../database-types.js"

export class SqliteProjectIdAllocator implements ProjectIdAllocatorPort {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly now: () => number = Date.now,
  ) {}

  public async next(projectId: ProjectId, prefix: PersistentIdPrefix): Promise<string> {
    const validatedPrefix = persistentIdPrefixSchema.parse(prefix)
    const value = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction.selectFrom("id_counters").select("current_value")
        .where("project_id", "=", projectId)
        .where("prefix", "=", validatedPrefix)
        .executeTakeFirst()
      const nextValue = (existing?.current_value ?? 0) + 1
      if (existing === undefined) {
        await transaction.insertInto("id_counters").values({
          project_id: projectId,
          prefix: validatedPrefix,
          current_value: nextValue,
          updated_at: this.now(),
        }).executeTakeFirstOrThrow()
      } else {
        await transaction.updateTable("id_counters").set({
          current_value: nextValue,
          updated_at: this.now(),
        }).where("project_id", "=", projectId).where("prefix", "=", validatedPrefix)
          .executeTakeFirstOrThrow()
      }
      return nextValue
    })
    return formatPersistentId(validatedPrefix, value)
  }
}
