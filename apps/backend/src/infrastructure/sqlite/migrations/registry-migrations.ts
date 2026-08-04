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
])
