import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import {
  PLATFORM_BASE_RULE_RESOURCES,
  WEBNOVEL_VENDOR_WRITE_RULE_RESOURCES,
  defaultSkillIdsForPhase,
} from "@worldseed/prompt-contracts"

import { resolveWhitelistedSkillScript } from "../src/application/chapters/skill-script-whitelist.js"
import { NodePromptResourceAdapter } from "../src/infrastructure/prompts/node-prompt-resource-adapter.js"

const packageRoot = resolve(process.cwd(), "packages/prompt-contracts")

describe("skill selective loading", () => {
  it("keeps platform system composites free of vendor fulltext", () => {
    for (const vendor of WEBNOVEL_VENDOR_WRITE_RULE_RESOURCES) {
      expect(PLATFORM_BASE_RULE_RESOURCES).not.toContain(vendor)
    }
    expect(PLATFORM_BASE_RULE_RESOURCES.some((path) => path.includes("skill-index"))).toBe(true)
  })

  it("loads skill bodies and default packs from adapter", async () => {
    const adapter = new NodePromptResourceAdapter(packageRoot)
    const system = await adapter.loadTurnSystemRules()
    expect(system.text).toContain("平台 Skill 索引")
    expect(system.text).not.toContain("# 去 AI 味（deslop）")

    const skill = await adapter.loadSkill("webnovel-deslop", { includeReferences: false })
    expect(skill.skillId).toBe("webnovel-deslop")
    expect(skill.text).toContain("【skill:webnovel-deslop】")
    expect(skill.text).toContain("去 AI 味")

    const pack = await adapter.loadDefaultSkillPack("synopsis_discuss")
    for (const id of defaultSkillIdsForPhase("synopsis_discuss")) {
      expect(pack.text).toContain(`【skill:${id}】`)
    }
  })

  it("resolves whitelisted skill scripts only", () => {
    const ok = resolveWhitelistedSkillScript({
      promptPackageRoot: packageRoot,
      skillId: "webnovel-deslop",
      scriptBasename: "scan-template-tells.mjs",
    })
    expect(ok?.replaceAll("\\", "/")).toContain("webnovel-deslop/scripts/scan-template-tells.mjs")
    expect(resolveWhitelistedSkillScript({
      promptPackageRoot: packageRoot,
      skillId: "webnovel-deslop",
      scriptBasename: "../secret.mjs",
    })).toBeUndefined()
  })
})
