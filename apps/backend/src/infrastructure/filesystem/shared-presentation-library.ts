import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { DESCRIPTION_RULES_DIR, PROSE_STYLE_RULES_DIR, digest } from "../../core/index.js"

const directories = [DESCRIPTION_RULES_DIR, PROSE_STYLE_RULES_DIR]

/** One writable library per application data directory; projects expose virtual paths. */
export class SharedPresentationLibrary {
  public readonly root: string
  private readonly receipts: string
  private pending: Promise<void> = Promise.resolve()

  public constructor(applicationDataRoot: string, private readonly presetRoot: string) {
    this.root = join(applicationDataRoot, "shared-workspace")
    this.receipts = join(applicationDataRoot, "shared-presentation-migrations")
  }

  public async initialize(): Promise<void> {
    await mkdir(this.receipts, { recursive: true })
    for (const directory of directories) {
      await mkdir(join(this.root, directory), { recursive: true })
      const sourceRoot = join(this.presetRoot, directory)
      for (const source of await markdownFiles(sourceRoot)) {
        const path = `${directory}/${relative(sourceRoot, source).replaceAll("\\", "/")}`
        const receipt = join(this.receipts, `seed-${digest(path)}.json`)
        if (await exists(receipt)) continue
        await createIfMissing(join(this.root, path), await readFile(source, "utf8"))
        // Track installation separately from existence so deletion survives restarts.
        await createIfMissing(receipt, JSON.stringify({ path }))
      }
    }
  }

  public migrate(workspaceRoot: string): Promise<void> {
    const run = this.pending.then(() => this.migrateWorkspace(workspaceRoot))
    this.pending = run.catch(() => undefined)
    return run
  }

  private async migrateWorkspace(workspaceRoot: string): Promise<void> {
    if (!await exists(workspaceRoot)) return
    const root = await realpath(workspaceRoot)
    const receipt = join(this.receipts, `workspace-${digest(root)}.json`)
    if (await exists(receipt)) return
    const presentation = join(root, "表现输出")
    if (await exists(presentation)) await assertDirectory(presentation)
    for (const directory of directories) {
      const sourceRoot = join(root, directory)
      if (!await exists(sourceRoot)) continue
      for (const source of await markdownFiles(sourceRoot)) {
        const path = `${directory}/${relative(sourceRoot, source).replaceAll("\\", "/")}`
        const content = await readFile(source, "utf8")
        // Old placeholders carry no user preference and must not become presets.
        if (/^# 默认(?:描写|笔风)规则\s+由用户在表现输出目录中继续定义。\s*$/u.test(content)) continue
        const target = join(this.root, path)
        if (await createIfMissing(target, content)) continue
        if (normalize(await readFile(target, "utf8")) === normalize(content)) continue
        const variant = target.slice(0, -3) + `-迁移-${digest(content).slice(0, 12)}.md`
        if (!await createIfMissing(variant, content) && await readFile(variant, "utf8") !== content) {
          throw new Error(`Shared rule migration conflicts with an existing file: ${variant}`)
        }
      }
    }
    // Keep original project files untouched as a backup, but never re-import them.
    await createIfMissing(receipt, JSON.stringify({ workspaceRoot: root }))
  }
}

function normalize(content: string): string {
  return content.replaceAll("\r\n", "\n").trimEnd()
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function assertDirectory(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Expected a regular rule directory: ${path}`)
}

async function markdownFiles(root: string): Promise<string[]> {
  await assertDirectory(root)
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Rule links are not supported: ${path}`)
    if (entry.isDirectory()) result.push(...await markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path)
    else throw new Error(`Rules must be Markdown files: ${path}`)
  }
  return result.sort()
}

async function createIfMissing(path: string, content: string): Promise<boolean> {
  let current = path
  do {
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) {
      throw new Error(`Shared rule paths cannot contain links: ${current}`)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  } while (current !== dirname(current))
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" })
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
    throw error
  }
}
