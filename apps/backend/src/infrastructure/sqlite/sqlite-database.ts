import BetterSqlite3 from "better-sqlite3"
import { Kysely, SqliteDialect } from "kysely"

import type { ProjectDatabase, RegistryDatabase } from "./database-types.js"
import { migrateSqliteDatabase } from "./migrations/migration-runner.js"
import { projectMigrations } from "./migrations/project-migrations.js"
import { registryMigrations } from "./migrations/registry-migrations.js"

export const SQLITE_BUSY_TIMEOUT_MS = 5000

function createSqliteDatabase<Database>(path: string): Kysely<Database> {
  const nativeDatabase = new BetterSqlite3(path)
  nativeDatabase.pragma("foreign_keys = ON")
  nativeDatabase.pragma(`busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)}`)
  nativeDatabase.pragma("journal_mode = WAL")

  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: nativeDatabase }),
  })
}

export async function openRegistryDatabase(path: string): Promise<Kysely<RegistryDatabase>> {
  const database = createSqliteDatabase<RegistryDatabase>(path)
  try {
    await migrateSqliteDatabase(database, registryMigrations)
    return database
  } catch (error) {
    await database.destroy()
    throw error
  }
}

export async function openProjectDatabase(path: string): Promise<Kysely<ProjectDatabase>> {
  const database = createSqliteDatabase<ProjectDatabase>(path)
  try {
    await migrateSqliteDatabase(database, projectMigrations)
    return database
  } catch (error) {
    await database.destroy()
    throw error
  }
}
