import { describe, expect, it } from "vitest"

import { environmentAcceptanceState } from "../lib/acceptance-manifest.mjs"

describe("acceptance manifest environment evidence", () => {
  it("uses persisted baseline and UI evidence during aggregate-only verification", () => {
    expect(environmentAcceptanceState([], {
      baseline: { status: "pass" },
      ui: { passed: true },
    })).toBe("pass")
  })

  it("does not pass aggregate-only verification when baseline evidence is absent", () => {
    expect(environmentAcceptanceState([], {
      ui: { passed: true },
    })).toBe("insufficient")
  })

  it("prefers failed current execution evidence over stale persisted success", () => {
    expect(environmentAcceptanceState([
      { id: "baseline", status: "fail" },
      { id: "electron", status: "pass" },
    ], {
      baseline: { status: "pass" },
      ui: { passed: true },
    })).toBe("fail")
  })
})
