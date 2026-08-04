import type { Kysely } from "kysely"
import { sql } from "kysely"

import { digest } from "../../../core/index.js"

export type SqlMigrationDefinition<Database> = Readonly<{
  version: number
  name: string
  digest: string
  up: (database: Kysely<Database>) => Promise<void>
}>

export function defineSqlMigration<Database>(
  version: number,
  name: string,
  statements: readonly string[],
): SqlMigrationDefinition<Database> {
  return Object.freeze({
    version,
    name,
    digest: digest({ version, name, statements }),
    async up(database) {
      for (const statement of statements) {
        await sql.raw(statement).execute(database)
      }
    },
  })
}
