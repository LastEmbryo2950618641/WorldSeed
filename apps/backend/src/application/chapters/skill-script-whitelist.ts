import { resolve } from "node:path"

import { listPlatformSkills } from "@worldseed/prompt-contracts"

/**
 * Resolve a skill script under prompt-contracts resources/skills/<id>/scripts/.
 * Returns absolute path only when the skill declares scriptsDir and the basename is allowed.
 */
export function resolveWhitelistedSkillScript(input: Readonly<{
  promptPackageRoot: string
  skillId: string
  scriptBasename: string
}>): string | undefined {
  const skill = listPlatformSkills().find((item) => item.id === input.skillId)
  if (skill?.scriptsDir === undefined) return undefined
  const basename = input.scriptBasename.trim().replaceAll("\\", "/")
  if (basename.length === 0 || basename.includes("/") || basename.includes("..")) {
    return undefined
  }
  if (!basename.endsWith(".mjs") && !basename.endsWith(".js")) return undefined
  const absolute = resolve(input.promptPackageRoot, skill.scriptsDir, basename)
  const scriptsRoot = resolve(input.promptPackageRoot, skill.scriptsDir)
  if (!absolute.startsWith(scriptsRoot)) return undefined
  return absolute
}

export function listWhitelistedSkillScripts(): readonly Readonly<{
  skillId: string
  scriptsDir: string
}>[] {
  return listPlatformSkills()
    .filter((skill) => skill.scriptsDir !== undefined)
    .map((skill) => ({ skillId: skill.id, scriptsDir: skill.scriptsDir! }))
}
