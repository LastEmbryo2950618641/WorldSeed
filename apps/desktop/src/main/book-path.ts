import { access, constants } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const ADJECTIVES = [
  "amber", "azure", "calm", "cedar", "clever", "crisp", "dawn", "ember",
  "gentle", "golden", "hidden", "ivory", "jade", "lunar", "misty", "noble",
  "quiet", "rapid", "silver", "stellar", "timber", "velvet", "wild", "winter",
] as const

const NOUNS = [
  "archive", "atlas", "bridge", "canvas", "chapter", "compass", "echo", "field",
  "garden", "harbor", "inkwell", "ledger", "meadow", "mirror", "notebook", "orbit",
  "quill", "river", "signal", "studio", "thread", "valley", "voyage", "window",
] as const

function pick<T>(items: readonly T[]): T {
  const index = randomBytes(1)[0]! % items.length
  return items[index]!
}

export function generateBookDirectorySlug(): string {
  const suffix = randomBytes(2).toString("hex")
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`
}

export async function allocateUniqueBookPath(workDirectory: string): Promise<string> {
  const root = workDirectory.trim()
  if (root.length === 0) throw new Error("工作目录未配置")
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = join(root, generateBookDirectorySlug())
    try {
      await access(candidate, constants.F_OK)
    } catch {
      return candidate
    }
  }
  throw new Error("无法分配唯一的书籍目录名，请稍后重试")
}
