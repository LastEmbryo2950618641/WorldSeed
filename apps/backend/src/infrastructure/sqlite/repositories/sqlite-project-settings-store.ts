import type { Kysely } from "kysely"

import { defaultProjectSettings } from "@worldseed/config"
import { projectSettingsSchema, type ProjectId, type ProjectSettings } from "@worldseed/contracts"

import type { ProjectDatabase } from "../database-types.js"
import { decodeJson, encodeJson } from "../json-codec.js"

export class SqliteProjectSettingsStore {
  public constructor(
    private readonly database: Kysely<ProjectDatabase>,
    private readonly now: () => number,
  ) {}

  public async read(projectId: ProjectId): Promise<ProjectSettings> {
    const row = await this.database.selectFrom("project_settings")
      .select("settings_json")
      .where("project_id", "=", projectId)
      .executeTakeFirst()
    return row === undefined
      ? defaultProjectSettings
      : projectSettingsSchema.parse(decodeJson(row.settings_json))
  }

  public async save(projectId: ProjectId, settings: ProjectSettings): Promise<ProjectSettings> {
    const parsed = projectSettingsSchema.parse(settings)
    await this.database.insertInto("project_settings").values({
      project_id: projectId,
      settings_json: encodeJson(parsed),
      updated_at: this.now(),
    }).onConflict((conflict) => conflict.column("project_id").doUpdateSet({
      settings_json: encodeJson(parsed),
      updated_at: this.now(),
    })).executeTakeFirstOrThrow()
    return parsed
  }
}
