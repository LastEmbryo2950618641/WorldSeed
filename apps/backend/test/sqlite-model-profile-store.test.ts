import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { openRegistryDatabase, SqliteModelProfileStore } from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createRegistryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-model-profile-store-"))
  temporaryDirectories.push(directory)
  return join(directory, "registry.sqlite")
}

describe("SqliteModelProfileStore", () => {
  it("seeds one generic DeepSeek profile for a new registry", async () => {
    const database = await openRegistryDatabase(createRegistryPath())
    const store = new SqliteModelProfileStore(database)

    await expect(store.read()).resolves.toMatchObject({
      activeProfileId: "deepseek",
      profiles: [{ id: "deepseek", name: "DeepSeek", model: "deepseek-chat" }],
    })

    await database.destroy()
  })

  it("collapses only the legacy built-in profiles while preserving the configured key reference", async () => {
    const database = await openRegistryDatabase(createRegistryPath())
    await database.insertInto("model_profiles").values([
      {
        id: "deepseek-chat",
        name: "DeepSeek Flash",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        credential_ref: "model-profile:deepseek-chat",
        api_protocol: "openai_chat_completions",
        context_window_tokens: 1_000_000,
        is_active: 1,
        position: 0,
        created_at: 1,
        updated_at: 1,
        thinking_mode_enabled: 1,
        reasoning_effort: "max",
        json_mode_enabled: 1,
        disable_response_storage: 1,
        service_tier: "auto",
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        base_url: "https://api.deepseek.com",
        model: "deepseek-reasoner",
        credential_ref: "model-profile:deepseek-reasoner",
        api_protocol: "openai_chat_completions",
        context_window_tokens: 1_000_000,
        is_active: 0,
        position: 1,
        created_at: 1,
        updated_at: 1,
        thinking_mode_enabled: 1,
        reasoning_effort: "high",
        json_mode_enabled: 0,
        disable_response_storage: 1,
        service_tier: "auto",
      },
    ]).execute()
    const store = new SqliteModelProfileStore(database)

    await expect(store.read()).resolves.toMatchObject({
      activeProfileId: "deepseek",
      profiles: [{
        id: "deepseek",
        name: "DeepSeek",
        model: "deepseek-chat",
        credentialRef: "model-profile:deepseek-chat",
        reasoningEffort: "max",
        jsonModeEnabled: true,
      }],
    })
    await expect(database.selectFrom("model_profiles").select(["id"]).execute()).resolves.toEqual([{ id: "deepseek" }])

    await database.destroy()
  })

  it("migrates a registry containing one legacy built-in profile", async () => {
    const database = await openRegistryDatabase(createRegistryPath())
    await database.insertInto("model_profiles").values({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      credential_ref: "model-profile:deepseek-v4-flash",
      api_protocol: "openai_chat_completions",
      context_window_tokens: 1_000_000,
      is_active: 1,
      position: 0,
      created_at: 1,
      updated_at: 1,
      thinking_mode_enabled: 1,
      reasoning_effort: "high",
      json_mode_enabled: 0,
      disable_response_storage: 1,
      service_tier: "auto",
    }).execute()
    const store = new SqliteModelProfileStore(database)

    await expect(store.read()).resolves.toMatchObject({
      activeProfileId: "deepseek",
      profiles: [{ id: "deepseek", name: "DeepSeek", model: "deepseek-chat" }],
    })

    await database.destroy()
  })
})
