import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import process from "node:process"

import { auditGraphCostPairs } from "./lib/graph-cost-ab-audit.mjs"

const paths = process.argv.slice(2)
if (paths.length === 0) {
  throw new Error("Usage: node graph-cost-ab-compare.mjs <report.json> [...report.json]")
}

const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))))
const result = {
  generatedAt: new Date().toISOString(),
  reportPaths: paths.map((path) => resolve(path)),
  ...auditGraphCostPairs(reports),
}
const outputPath = process.env.WORLDSEED_ACCEPTANCE_AB_COMPARISON?.trim()
if (outputPath !== undefined && outputPath.length > 0) {
  const resolved = resolve(outputPath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
process.exitCode = result.status === "pass" ? 0 : 1
