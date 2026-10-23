#!/usr/bin/env node
/**
 * Read-only: detect naive A→B「什么/担什么」→A explain ping-pong in dialogue quotes.
 * Usage: node scan-dialogue-pingpong.mjs [path.md]
 */
import { readFileSync } from "node:fs"

const source = process.argv[2]
const text = source === undefined
  ? readFileSync(0, "utf8")
  : readFileSync(source, "utf8")

const lines = text.split(/\r?\n/u)
const hits = []
for (let i = 0; i < lines.length - 1; i += 1) {
  const a = lines[i] ?? ""
  const b = lines[i + 1] ?? ""
  if (/[“"].+[”"]/u.test(a) && /[“"](?:担什么|什么|什么意思|不懂什么)[？”"]/u.test(b)) {
    hits.push({ line: i + 1, a: a.trim(), b: b.trim() })
  }
}

if (hits.length === 0) {
  console.log(JSON.stringify({ ok: true, hits: [] }, null, 2))
  process.exit(0)
}
console.log(JSON.stringify({ ok: false, hits }, null, 2))
process.exit(1)
