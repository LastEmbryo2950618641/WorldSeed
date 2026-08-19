import type { Kysely } from "kysely"

import type { ModelProfile, ModelProfilesReadResult, ModelProfilesSavePayload } from "@worldseed/contracts"

import type { ModelProfileStorePort } from "../../../application/index.js"
import type { RegistryDatabase } from "../database-types.js"
import { runtimeLog } from "../../diagnostics/index.js"

const defaultProfiles = Object.freeze([
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", credentialRef: "model-profile:deepseek", apiProtocol: "openai_chat_completions", contextWindowTokens: 1_000_000, thinkingModeEnabled: true, reasoningEffort: "high", jsonModeEnabled: false, disableResponseStorage: true, serviceTier: "auto" },
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
    if (rows.length === 0) return this.save({ profiles: [...defaultProfiles], activeProfileId: defaultProfiles[0]?.id ?? "deepseek" })
    const migratedDefaults = migrateLegacyDefaultProfiles(rows)
    if (migratedDefaults !== undefined) return this.save({ profiles: [migratedDefaults], activeProfileId: migratedDefaults.id })
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
        api_protocol: profile.apiProtocol,
        context_window_tokens: profile.contextWindowTokens,
        is_active: profile.id === input.activeProfileId ? 1 : 0,
        position,
        created_at: timestamp,
        updated_at: timestamp,
        thinking_mode_enabled: profile.thinkingModeEnabled ? 1 : 0,
        reasoning_effort: profile.reasoningEffort,
        json_mode_enabled: profile.jsonModeEnabled ? 1 : 0,
        disable_response_storage: profile.disableResponseStorage ? 1 : 0,
        service_tier: profile.serviceTier,
      }))).execute()
    })
    runtimeLog("debug", "model-profile-store", "profiles.saved", {
      activeProfileId: input.activeProfileId,
      profiles: input.profiles.map((profile) => ({ id: profile.id, model: profile.model, baseUrl: profile.baseUrl })),
    })
    return { profiles: input.profiles, activeProfileId: input.activeProfileId }
  }
}

function migrateLegacyDefaultProfiles(rows: readonly RegistryDatabase["model_profiles"][]): ModelProfile | undefined {
  if (rows.length === 0 || !rows.every(isLegacyDefaultProfile)) return undefined
  const source = rows.find((row) => row.model === "deepseek-v4-flash" || row.id === "deepseek-chat") ?? rows[0]
  if (source === undefined) return undefined
  const profile = mapProfile(source)
  return {
    ...profile,
    id: "deepseek",
    name: "DeepSeek",
    model: profile.model === "deepseek-v4-flash" ? "deepseek-chat" : profile.model,
  }
}

function isLegacyDefaultProfile(row: RegistryDatabase["model_profiles"]): boolean {
  return row.id === "deepseek-chat"
    || row.id === "deepseek-reasoner"
    || row.id === "deepseek-v4-flash"
    || row.id === "deepseek-v4-pro"
    || row.name === "DeepSeek Flash"
    || row.name === "DeepSeek V4 Flash"
    || row.name === "DeepSeek Reasoner"
    || row.name === "DeepSeek V4 Pro"
}

function mapProfile(row: RegistryDatabase["model_profiles"]): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    credentialRef: row.credential_ref,
    apiProtocol: row.api_protocol === "openai_responses" ? "openai_responses" : "openai_chat_completions",
    contextWindowTokens: row.context_window_tokens,
    thinkingModeEnabled: row.thinking_mode_enabled === 1,
    reasoningEffort: readReasoningEffort(row.reasoning_effort),
    jsonModeEnabled: row.json_mode_enabled === 1,
    disableResponseStorage: row.disable_response_storage === 1,
    serviceTier: readServiceTier(row.service_tier),
  }
}

function readReasoningEffort(value: string): ModelProfile["reasoningEffort"] {
  return value === "none" || value === "minimal" || value === "low" || value === "medium"
    || value === "xhigh" || value === "max" ? value : "high"
}

function readServiceTier(value: string): ModelProfile["serviceTier"] {
  return value === "default" || value === "flex" || value === "priority" || value === "fast" ? value : "auto"
}
