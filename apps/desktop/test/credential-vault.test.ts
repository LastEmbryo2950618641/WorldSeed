import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { FileCredentialVault } from "../src/main/credential-vault.js"

describe("FileCredentialVault", () => {
  it("serializes concurrent updates without losing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worldseed-credentials-"))
    const path = join(directory, "credentials.json")
    const vault = new FileCredentialVault(path, {
      encrypt: (value) => `encrypted:${value}`,
      decrypt: (value) => value.replace(/^encrypted:/u, ""),
    })

    await Promise.all([
      vault.set("model-profile:chat", "chat-key"),
      vault.set("model-profile:reasoner", "reasoner-key"),
    ])

    expect(await vault.get("model-profile:chat")).toBe("chat-key")
    expect(await vault.get("model-profile:reasoner")).toBe("reasoner-key")
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      secrets: {
        "model-profile:chat": "encrypted:chat-key",
        "model-profile:reasoner": "encrypted:reasoner-key",
      },
    })
  })

  it("quarantines a corrupted vault and allows a fresh credential save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worldseed-corrupt-credentials-"))
    const path = join(directory, "credentials.json")
    await writeFile(path, '{"version":1,"secrets":{}}trailing-data', "utf8")
    const vault = new FileCredentialVault(path, {
      encrypt: (value) => `encrypted:${value}`,
      decrypt: (value) => value.replace(/^encrypted:/u, ""),
    })

    expect(await vault.has("model-profile:chat")).toBe(false)
    await vault.set("model-profile:chat", "fresh-key")

    expect(await vault.get("model-profile:chat")).toBe("fresh-key")
    expect((await readdir(directory)).some((name) => name.startsWith("credentials.json.corrupt-"))).toBe(true)
  })
})
