import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { resolve, sep } from "node:path"
import process from "node:process"

const [databasePathRef, runtimeRootRef, projectId] = process.argv.slice(2)
if (databasePathRef === undefined || runtimeRootRef === undefined || projectId === undefined) {
  throw new Error("Usage: node rebase-runtime-content-refs.mjs <database> <runtime-root> <project-id>")
}

const databasePath = resolve(databasePathRef)
const runtimeRoot = resolve(runtimeRootRef)
const objectRoot = resolve(runtimeRoot, "projects", projectId, "objects", "documents")
const require = createRequire(import.meta.url)
const Database = require(resolve(import.meta.dirname, "../../apps/backend/node_modules/better-sqlite3"))
const database = new Database(databasePath, { fileMustExist: true })

try {
  const tables = ["canonical_chapter_messages", "model_context_messages"]
  const updates = []
  database.transaction(() => {
    for (const table of tables) {
      const rows = database.prepare(`select rowid, content_ref contentRef from ${table}`).all()
      const update = database.prepare(`update ${table} set content_ref = ? where rowid = ?`)
      for (const row of rows) {
        if (typeof row.contentRef !== "string" || row.contentRef.length === 0) continue
        const marker = `${sep}objects${sep}documents${sep}`
        const markerIndex = row.contentRef.lastIndexOf(marker)
        if (markerIndex < 0) throw new Error(`Unsupported content_ref in ${table}: ${row.contentRef}`)
        const rebased = resolve(objectRoot, row.contentRef.slice(markerIndex + marker.length))
        if (!rebased.startsWith(`${objectRoot}${sep}`) || !existsSync(rebased)) {
          throw new Error(`Rebased content_ref is missing or outside the runtime: ${rebased}`)
        }
        if (rebased !== row.contentRef) {
          update.run(rebased, row.rowid)
          updates.push({ table, rowid: row.rowid, from: row.contentRef, to: rebased })
        }
      }
    }
  })()
  process.stdout.write(`${JSON.stringify({ databasePath, objectRoot, updated: updates.length }, null, 2)}\n`)
} finally {
  database.close()
}
