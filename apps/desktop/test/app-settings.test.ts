import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  addWorkDirectory,
  readAppSettings,
  removeWorkDirectory,
  setActiveWorkDirectory,
} from "../src/main/app-settings.js"

describe("app settings work directories", () => {
  it("migrates legacy single workDirectory field", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-app-settings-"))
    const legacyPath = join(root, "legacy-work")
    await mkdir(legacyPath, { recursive: true })
    await writeFile(
      join(root, "app-settings.json"),
      `${JSON.stringify({ workDirectory: legacyPath }, null, 2)}\n`,
      "utf8",
    )

    const stored = await readAppSettings(root)
    expect(stored).toEqual({
      workDirectories: [legacyPath.replace(/[\\/]+$/u, "")],
      activeWorkDirectory: legacyPath.replace(/[\\/]+$/u, ""),
    })
  })

  it("adds, activates, and removes directories while optionally deleting data", async () => {
    const root = await mkdtemp(join(tmpdir(), "worldseed-app-settings-"))
    const first = join(root, "books-a")
    const second = join(root, "books-b")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, "marker.txt"), "keep", "utf8")
    await writeFile(join(second, "marker.txt"), "delete", "utf8")

    await addWorkDirectory(root, first)
    await addWorkDirectory(root, second)
    await setActiveWorkDirectory(root, second)

    let stored = await readAppSettings(root)
    expect(stored?.workDirectories).toEqual([first.replace(/[\\/]+$/u, ""), second.replace(/[\\/]+$/u, "")])
    expect(stored?.activeWorkDirectory).toBe(second.replace(/[\\/]+$/u, ""))

    await removeWorkDirectory(root, { directoryPath: first, mode: "keep_data" })
    stored = await readAppSettings(root)
    expect(stored?.workDirectories).toEqual([second.replace(/[\\/]+$/u, "")])
    expect(await readFile(join(first, "marker.txt"), "utf8")).toBe("keep")

    await removeWorkDirectory(root, { directoryPath: second, mode: "include_data" })
    stored = await readAppSettings(root)
    expect(stored).toBeUndefined()
    await expect(readFile(join(second, "marker.txt"), "utf8")).rejects.toThrow()
  })
})
