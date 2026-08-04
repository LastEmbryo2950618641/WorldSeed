import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry)
    return statSync(path).isDirectory() ? listTypeScriptFiles(path) : path.endsWith(".ts") ? [path] : []
  })
}

describe("backend architecture", () => {
  it("does not introduce fixed world-domain services or repositories", () => {
    const sourceRoot = resolve(process.cwd(), "apps/backend/src")
    const source = listTypeScriptFiles(sourceRoot).map((file) => readFileSync(file, "utf8")).join("\n")
    const forbiddenIdentifiers = [
      "CharacterRepository",
      "FactionRepository",
      "LocationRepository",
      "EventRepository",
      "CharacterService",
      "FactionService",
      "LocationService",
      "EventService",
    ]

    for (const identifier of forbiddenIdentifiers) {
      expect(source, identifier).not.toContain(identifier)
    }
  })

  it("keeps the pure core free of database, desktop, model, and filesystem SDK imports", () => {
    const coreRoot = resolve(process.cwd(), "apps/backend/src/core")
    const imports = listTypeScriptFiles(coreRoot).map((file) => readFileSync(file, "utf8")).join("\n")

    expect(imports).not.toMatch(/from ["'](?:better-sqlite3|kysely|electron|openai|node:fs|node:path)["']/u)
  })
})
