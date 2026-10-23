#!/usr/bin/env node
/**
 * Read-only heuristic: flag common Chinese AI-template tells in stdin or a file path arg.
 * Whitelisted for discuss bash via skill script path under prompt-contracts resources.
 *
 * Usage:
 *   node scan-template-tells.mjs [path.md]
 *   type chapter.md | node scan-template-tells.mjs
 */
import { readFileSync } from "node:fs"

const PATTERNS = [
  [/眼中闪过|眸光|目光如炬/u, "眼神套话"],
  [/嘴角勾起一抹|嘴角微扬|扯出一抹笑/u, "嘴角套话"],
  [/心中涌起一股|不禁|不由自主/u, "情绪标签"],
  [/空气仿佛凝固|时间在这一刻静止/u, "氛围万能句"],
  [/不是.+而是|不是.+他是/u, "不是A而是B"],
  [/担什么|什么意思？|不懂什么/u, "对白乒乓嫌疑"],
]

const source = process.argv[2]
const text = source === undefined
  ? readFileSync(0, "utf8")
  : readFileSync(source, "utf8")

const hits = []
for (const [re, label] of PATTERNS) {
  const match = text.match(re)
  if (match) hits.push({ label, sample: match[0] })
}

if (hits.length === 0) {
  console.log(JSON.stringify({ ok: true, hits: [] }, null, 2))
  process.exit(0)
}
console.log(JSON.stringify({ ok: false, hits }, null, 2))
process.exit(1)
