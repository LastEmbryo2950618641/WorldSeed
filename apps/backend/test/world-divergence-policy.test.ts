import { describe, expect, it } from "vitest"

import {
  allowsSettingsCreate,
  resolveWorldDivergenceMode,
  worldDivergencePhaseAppendix,
} from "../src/application/settings/world-divergence-policy.js"
import { defaultProjectSettings } from "@worldseed/config"

describe("world divergence policy", () => {
  it("defaults to world_consistent", () => {
    expect(resolveWorldDivergenceMode(undefined)).toBe("world_consistent")
    expect(resolveWorldDivergenceMode(defaultProjectSettings)).toBe("world_consistent")
  })

  it("blocks create proposals only in strict mode", () => {
    expect(allowsSettingsCreate("strict")).toBe(false)
    expect(allowsSettingsCreate("world_consistent")).toBe(true)
    expect(allowsSettingsCreate("free")).toBe(true)
  })

  it("injects phase appendix for draft and settings_extraction only", () => {
    expect(worldDivergencePhaseAppendix("strict", "draft")).toContain("严格遵循设定")
    expect(worldDivergencePhaseAppendix("strict", "settings_extraction")).toContain("禁止")
    expect(worldDivergencePhaseAppendix("world_consistent", "draft")).toContain("基于世界观生成设定")
    expect(worldDivergencePhaseAppendix("free", "draft")).toContain("自由发挥")
    expect(worldDivergencePhaseAppendix("strict", "rule_assembly")).toBeUndefined()
  })
})
