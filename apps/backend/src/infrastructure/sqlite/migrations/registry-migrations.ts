import type { RegistryDatabase } from "../database-types.js"
import { defineSqlMigration } from "./migration-definition.js"

export const registryMigrations = Object.freeze([
  defineSqlMigration<RegistryDatabase>(1, "r001_registered_projects", [
    `CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
    `CREATE TABLE registered_projects (
      project_id TEXT PRIMARY KEY,
      workspace_root_ref TEXT NOT NULL UNIQUE,
      internal_store_ref TEXT NOT NULL,
      last_opened_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ]),
  defineSqlMigration<RegistryDatabase>(2, "r002_model_profiles", [
    `CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]),
  defineSqlMigration<RegistryDatabase>(3, "r003_model_protocol_settings", [
    `ALTER TABLE model_profiles ADD COLUMN thinking_mode_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE model_profiles ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high'`,
    `ALTER TABLE model_profiles ADD COLUMN json_mode_enabled INTEGER NOT NULL DEFAULT 0`,
  ]),
  defineSqlMigration<RegistryDatabase>(4, "r004_model_context_window", [
    `ALTER TABLE model_profiles ADD COLUMN context_window_tokens INTEGER NOT NULL DEFAULT 1000000`,
  ]),
])
