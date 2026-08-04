import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { SchemaMigrationRow } from "../database-types.js"
import type { SqlMigrationDefinition } from "./migration-definition.js"

export class SqliteMigrationError extends Error {
  public constructor(
    public readonly code: "database_too_new" | "migration_mismatch" | "migration_sequence_invalid",
    message: string,
  ) {
    super(message)
  }
}

async function migrationTableExists<Database>(database: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
  `.execute(database)
  return result.rows.length > 0
}

function validateMigrationSequence<Database>(migrations: readonly SqlMigrationDefinition<Database>[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1
    if (migration.version !== expectedVersion) {
      throw new SqliteMigrationError(
        "migration_sequence_invalid",
        `Expected migration version ${String(expectedVersion)}, received ${String(migration.version)}`,
      )
    }
  }
}

export async function migrateSqliteDatabase<Database>(
  database: Kysely<Database>,
  migrations: readonly SqlMigrationDefinition<Database>[],
  now: () => number = Date.now,
): Promise<void> {
  validateMigrationSequence(migrations)
  const hasMigrationTable = await migrationTableExists(database)
  const applied = hasMigrationTable
    ? (await sql<SchemaMigrationRow>`
        SELECT version, name, digest, applied_at FROM schema_migrations ORDER BY version
      `.execute(database)).rows
    : []
  const latestVersion = migrations.at(-1)?.version ?? 0
  const currentVersion = applied.at(-1)?.version ?? 0

  if (currentVersion > latestVersion) {
    throw new SqliteMigrationError(
      "database_too_new",
      `Database version ${String(currentVersion)} is newer than supported version ${String(latestVersion)}`,
    )
  }

  for (const row of applied) {
    const definition = migrations[row.version - 1]
    if (definition === undefined || definition.name !== row.name || definition.digest !== row.digest) {
      throw new SqliteMigrationError(
        "migration_mismatch",
        `Applied migration ${String(row.version)} does not match the bundled definition`,
      )
    }
  }

  for (const migration of migrations.slice(currentVersion)) {
    await database.transaction().execute(async (transaction) => {
      await migration.up(transaction)
      await sql`
        INSERT INTO schema_migrations(version, name, digest, applied_at)
        VALUES (${migration.version}, ${migration.name}, ${migration.digest}, ${now()})
      `.execute(transaction)
    })
  }
}
