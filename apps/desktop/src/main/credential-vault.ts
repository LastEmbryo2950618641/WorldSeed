import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type SecretCipher = Readonly<{
  encrypt(value: string): string
  decrypt(value: string): string
}>

type VaultFile = Readonly<{
  version: 1
  secrets: Readonly<Record<string, string>>
}>

export class FileCredentialVault {
  private operationQueue: Promise<void> = Promise.resolve()

  public constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  public async get(reference: string): Promise<string | undefined> {
    return this.runExclusive(async () => {
      const vault = await this.read()
      const encrypted = vault.secrets[reference]
      return encrypted === undefined ? undefined : this.cipher.decrypt(encrypted)
    })
  }

  public async has(reference: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const vault = await this.read()
      return vault.secrets[reference] !== undefined
    })
  }

  public async set(reference: string, value: string): Promise<void> {
    return this.runExclusive(async () => {
      const vault = await this.read()
      const secrets = { ...vault.secrets }
      if (value.trim().length === 0) {
        const remaining = Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== reference))
        await this.write({ version: 1, secrets: remaining })
        return
      }
      secrets[reference] = this.cipher.encrypt(value)
      await this.write({ version: 1, secrets })
    })
  }

  public async remove(reference: string): Promise<void> {
    return this.runExclusive(async () => {
      const vault = await this.read()
      const secrets = { ...vault.secrets }
      const remaining = Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== reference))
      await this.write({ version: 1, secrets: remaining })
    })
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(): Promise<VaultFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"))
      if (!isVaultFile(parsed)) throw new Error("Credential vault has an invalid format")
      return parsed
    } catch (error) {
      if (isFileNotFound(error)) return { version: 1, secrets: {} }
      if (isJsonSyntaxError(error)) {
        await rename(this.filePath, `${this.filePath}.corrupt-${String(Date.now())}`)
        return { version: 1, secrets: {} }
      }
      throw error
    }
  }

  private async write(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(vault), "utf8")
    await rename(temporaryPath, this.filePath)
  }
}

function isVaultFile(value: unknown): value is VaultFile {
  if (typeof value !== "object" || value === null || !("version" in value) || !("secrets" in value)) return false
  if (value.version !== 1 || typeof value.secrets !== "object" || value.secrets === null) return false
  return Object.values(value.secrets).every((secret) => typeof secret === "string")
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.name === "SyntaxError"
}
