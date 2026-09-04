import { describe, expect, it } from "vitest"

import {
  compareSemver,
  isUpdateAvailable,
  parseUpdateManifest,
  shouldAutoCheck,
  type LocalAppIdentity,
  type UpdateManifest,
} from "../src/main/app-update.js"

const local: LocalAppIdentity = {
  productName: "WorldSeed",
  version: "0.1.0",
  buildNumber: "1",
}

describe("app update compare", () => {
  it("treats any version or build change as available in any_change mode", () => {
    const sameBuildNewVersion: UpdateManifest = {
      version: "0.1.1",
      buildNumber: "1",
      downloadUrl: "https://example.com/setup.exe",
    }
    const sameVersionNewBuild: UpdateManifest = {
      version: "0.1.0",
      buildNumber: "2",
      downloadUrl: "https://example.com/setup.exe",
    }
    expect(isUpdateAvailable(local, sameBuildNewVersion, "any_change")).toBe(true)
    expect(isUpdateAvailable(local, sameVersionNewBuild, "any_change")).toBe(true)
    expect(isUpdateAvailable(local, {
      version: "0.1.0",
      buildNumber: "1",
      downloadUrl: "https://example.com/setup.exe",
    }, "any_change")).toBe(false)
  })

  it("only accepts greater semver in semver mode", () => {
    expect(isUpdateAvailable(local, {
      version: "0.2.0",
      buildNumber: "1",
      downloadUrl: "https://example.com/setup.exe",
    }, "semver")).toBe(true)
    expect(isUpdateAvailable(local, {
      version: "0.1.0",
      buildNumber: "99",
      downloadUrl: "https://example.com/setup.exe",
    }, "semver")).toBe(false)
    expect(isUpdateAvailable(local, {
      version: "0.0.9",
      buildNumber: "99",
      downloadUrl: "https://example.com/setup.exe",
    }, "semver")).toBe(false)
  })

  it("compares semver numbers", () => {
    expect(compareSemver("0.2.0", "0.1.9")).toBeGreaterThan(0)
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0)
    expect(compareSemver("0.1.0", "0.1.1")).toBeLessThan(0)
  })

  it("parses update manifests", () => {
    expect(parseUpdateManifest({
      version: "0.1.1",
      buildNumber: 12,
      downloadUrl: "https://example.com/WorldSeed-0.1.1-Setup.exe",
      productName: "WorldSeed",
    })).toEqual({
      version: "0.1.1",
      buildNumber: "12",
      downloadUrl: "https://example.com/WorldSeed-0.1.1-Setup.exe",
      productName: "WorldSeed",
    })
  })

  it("gates auto checks by interval", () => {
    const now = 1_000_000
    expect(shouldAutoCheck({ updateUrl: "https://example.com/latest.json" }, now)).toBe(false)
    expect(shouldAutoCheck({
      updateUrl: "https://example.com/latest.json",
      checkIntervalHours: 24,
    }, now)).toBe(true)
    expect(shouldAutoCheck({
      updateUrl: "https://example.com/latest.json",
      checkIntervalHours: 1,
      lastCheckedAtMs: now - 30 * 60 * 1000,
    }, now)).toBe(false)
    expect(shouldAutoCheck({
      updateUrl: "https://example.com/latest.json",
      checkIntervalHours: 1,
      lastCheckedAtMs: now - 2 * 60 * 60 * 1000,
    }, now)).toBe(true)
  })
})
