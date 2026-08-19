import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import process from "node:process"

const [databasePathRef, runtimeRootRef, workspaceRootRef, projectId] = process.argv.slice(2)
if (databasePathRef === undefined || runtimeRootRef === undefined || workspaceRootRef === undefined || projectId === undefined) {
  throw new Error("Usage: node frozen-start-audit.mjs <database> <runtime-root> <workspace> <project-id>")
}

const repositoryRoot = resolve(import.meta.dirname, "../..")
const require = createRequire(import.meta.url)
const Database = require(resolve(repositoryRoot, "apps/backend/node_modules/better-sqlite3"))
const databasePath = resolve(databasePathRef)
const runtimeRoot = resolve(runtimeRootRef)
const workspaceRoot = resolve(workspaceRootRef)
const database = new Database(databasePath, { readonly: true, fileMustExist: true })

try {
  const chains = database.prepare(`
    select id, message_count messageCount, token_estimate tokenEstimate
    from model_context_chains where project_id = ? order by id
  `).all(projectId)
  const messages = database.prepare(`
    select chain_id chainId, sequence_no sequenceNo, content_digest contentDigest, hidden_at hiddenAt
    from model_context_messages where project_id = ? order by chain_id, sequence_no
  `).all(projectId)
  const settings = database.prepare(
    "select settings_json settingsJson from project_settings where project_id = ?",
  ).get(projectId)
  const markdownFiles = (await walk(workspaceRoot))
    .filter((path) => path.toLowerCase().endsWith(".md"))
    .sort()
  const markdownRecords = []
  for (const path of markdownFiles) {
    markdownRecords.push({
      path: relative(workspaceRoot, path).replaceAll("\\", "/"),
      digest: digest(await readFile(path)),
    })
  }
  const references = ["canonical_chapter_messages", "model_context_messages"].flatMap((table) => (
    database.prepare(`select content_ref contentRef from ${table} where content_ref is not null`).all().map((row) => ({
      table,
      contentRef: row.contentRef,
      exists: existsSync(row.contentRef),
      insideRuntime: resolve(row.contentRef).startsWith(`${runtimeRoot}${sep}`),
    }))
  ))
  const result = {
    contextDigest: digest(JSON.stringify({ chains, messages })),
    workspaceDigest: digest(JSON.stringify(markdownRecords)),
    settingsDigest: digest(settings?.settingsJson ?? ""),
    chapterCount: markdownFiles.filter((path) => basename(dirname(path)) === "章节正文").length,
    references: {
      count: references.length,
      missing: references.filter((item) => !item.exists).length,
      outsideRuntime: references.filter((item) => !item.insideRuntime).length,
    },
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  database.close()
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return nested.flat()
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}
