import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sql } from "kysely"
import { afterEach, describe, expect, it } from "vitest"

import {
  openProjectDatabase,
  openRegistryDatabase,
} from "../src/index.js"
import type { SqliteMigrationError } from "../src/index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "worldseed-sqlite-"))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("SQLite migrations", () => {
  it("creates and reopens the isolated registry database", async () => {
    const path = temporaryDatabasePath("registry.sqlite")
    const first = await openRegistryDatabase(path)
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `.execute(first)
    const migrations = await first.selectFrom("schema_migrations").selectAll().execute()

    expect(tables.rows.map((row) => row.name)).toEqual(["registered_projects", "schema_migrations"])
    expect(migrations).toHaveLength(1)
    await first.destroy()

    const reopened = await openRegistryDatabase(path)
    expect(await reopened.selectFrom("schema_migrations").selectAll().execute()).toHaveLength(1)
    await reopened.destroy()
  })

  it("applies project migrations 001 through 007 with required SQLite pragmas", async () => {
    const path = temporaryDatabasePath("project.sqlite")
    const database = await openProjectDatabase(path)
    const migrations = await database.selectFrom("schema_migrations").selectAll().orderBy("version").execute()
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `.execute(database)
    const tableNames = new Set(tables.rows.map((row) => row.name))
    const journalMode = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(database)
    const foreignKeys = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(database)
    const busyTimeout = await sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(database)

    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(tableNames).toEqual(expect.objectContaining(new Set([
      "projects",
      "project_manifests",
      "workspace_operations",
      "artifact_scopes",
      "tasks",
      "operation_events",
      "turn_contexts",
      "context_segments",
      "phase_runs",
      "kv_usage",
      "nodes",
      "links",
      "node_heads",
      "link_heads",
      "graph_revisions",
      "document_versions",
      "source_units",
      "settlement_records",
      "retrieval_projections",
      "retrieval_exact_keys",
      "retrieval_fts",
      "rule_snapshots",
      "ai_decision_records",
      "frontier_refs",
    ])))
    expect(journalMode.rows[0]?.journal_mode).toBe("wal")
    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1)
    expect(busyTimeout.rows[0]?.timeout).toBe(5000)

    await sql`INSERT INTO retrieval_fts(projection_id, project_id, scope_id, visibility, semantic_text)
      VALUES ('projection', 'project', 'scope', 'committed', 'old bridge hidden key')`.execute(database)
    const match = await sql<{ projection_id: string }>`
      SELECT projection_id FROM retrieval_fts WHERE retrieval_fts MATCH 'bridge'
    `.execute(database)
    expect(match.rows).toEqual([{ projection_id: "projection" }])
    await database.destroy()
  })

  it("rejects databases newer than the running application", async () => {
    const path = temporaryDatabasePath("newer.sqlite")
    const database = await openProjectDatabase(path)
    await database.insertInto("schema_migrations").values({
      version: 999,
      name: "future",
      digest: "future",
      applied_at: Date.now(),
    }).execute()
    await database.destroy()

    await expect(openProjectDatabase(path)).rejects.toMatchObject<Partial<SqliteMigrationError>>({
      code: "database_too_new",
    })
  })

  it("rejects an altered applied migration digest", async () => {
    const path = temporaryDatabasePath("altered.sqlite")
    const database = await openProjectDatabase(path)
    await database.updateTable("schema_migrations")
      .set({ digest: "altered" })
      .where("version", "=", 1)
      .execute()
    await database.destroy()

    await expect(openProjectDatabase(path)).rejects.toMatchObject<Partial<SqliteMigrationError>>({
      code: "migration_mismatch",
    })
  })
})
