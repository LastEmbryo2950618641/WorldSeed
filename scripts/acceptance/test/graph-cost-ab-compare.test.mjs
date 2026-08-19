import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("graph cost A/B comparison CLI", () => {
  it("resolves every report path independently", () => {
    const directory = mkdtempSync(join(tmpdir(), "worldseed-ab-compare-"))
    directories.push(directory)
    const baselinePath = join(directory, "baseline.json")
    const optimizedPath = join(directory, "optimized.json")
    writeFileSync(baselinePath, JSON.stringify({ pairId: "pair-1", variant: "baseline" }))
    writeFileSync(optimizedPath, JSON.stringify({ pairId: "pair-1", variant: "optimized" }))

    let output = ""
    try {
      output = execFileSync(process.execPath, [
        resolve("scripts/acceptance/graph-cost-ab-compare.mjs"),
        baselinePath,
        optimizedPath,
      ], { cwd: resolve("."), encoding: "utf8" })
    } catch (error) {
      output = error.stdout
    }

    const report = JSON.parse(output)
    expect(report.status).toBe("fail")
    expect(report.reportPaths).toEqual([resolve(baselinePath), resolve(optimizedPath)])
  })
})
