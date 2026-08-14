import type { Kysely } from "kysely"

import type { ModelProfile, ModelProfilesReadResult, ModelProfilesSavePayload } from "@worldseed/contracts"

import type { ModelProfileStorePort } from "../../../application/index.js"
import type { RegistryDatabase } from "../database-types.js"
import { runtimeLog } from "../../diagnostics/index.js"

const defaultProfiles = Object.freeze([
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", credentialRef: "model-profile:deepseek-v4-flash", contextWindowTokens: 1_000_000, thinkingModeEnabled: true, reasoningEffort: "high", jsonModeEnabled: false },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", credentialRef: "model-profile:deepseek-v4-pro", contextWindowTokens: 1_000_000, thinkingModeEnabled: true, reasoningEffort: "high", jsonModeEnabled: false },
] satisfies readonly ModelProfile[])

export class SqliteModelProfileStore implements ModelProfileStorePort {
  public constructor(
    private readonly database: Kysely<RegistryDatabase>,
    private readonly now: () => number = Date.now,
  ) {}

  public async read(): Promise<ModelProfilesReadResult> {
    const rows = await this.database.selectFrom("model_profiles")
      .selectAll()
      .orderBy("position", "asc")
      .execute()
    if (rows.length === 0) return this.save({ profiles: [...defaultProfiles], activeProfileId: defaultProfiles[0]?.id ?? "deepseek-v4-flash" })
    const profiles = rows.map(mapProfile)
    const active = rows.find((profile) => profile.is_active === 1) ?? rows[0]
    if (active === undefined) throw new Error("Model profile registry is empty")
    return { profiles, activeProfileId: active.id }
  }

  public async save(input: ModelProfilesSavePayload): Promise<ModelProfilesReadResult> {
    const timestamp = this.now()
    await this.database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("model_profiles").execute()
      await transaction.insertInto("model_profiles").values(input.profiles.map((profile, position) => ({
        id: profile.id,
        name: profile.name,
        base_url: profile.baseUrl,
        model: profile.model,
        credential_ref: profile.credentialRef,
        context_window_tokens: profile.contextWindowTokens,
        is_active: profile.id === input.activeProfileId ? 1 : 0,
        position,
        created_at: timestamp,
        updated_at: timestamp,
        thinking_mode_enabled: profile.thinkingModeEnabled ? 1 : 0,
        reasoning_effort: profile.reasoningEffort,
        json_mode_enabled: profile.jsonModeEnabled ? 1 : 0,
      }))).execute()
    })
    runtimeLog("debug", "model-profile-store", "profiles.saved", {
      activeProfileId: input.activeProfileId,
      profiles: input.profiles.map((profile) => ({ id: profile.id, model: profile.model, baseUrl: profile.baseUrl })),
    })
    return { profiles: input.profiles, activeProfileId: input.activeProfileId }
  }
}

function mapProfile(row: RegistryDatabase["model_profiles"]): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    credentialRef: row.credential_ref,
    contextWindowTokens: row.context_window_tokens,
    thinkingModeEnabled: row.thinking_mode_enabled === 1,
    reasoningEffort: row.reasoning_effort === "max" ? "max" : row.reasoning_effort === "low" ? "low" : "high",
    jsonModeEnabled: row.json_mode_enabled === 1,
  }
}
