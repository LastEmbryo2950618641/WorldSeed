import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises"
import { extname, join } from "node:path"

const COVER_DIR = ".worldseed"
const COVER_BASENAME = "cover"
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"])

function coverDir(workspaceRootRef: string): string {
  return join(workspaceRootRef, COVER_DIR)
}

export async function findBookCoverPath(workspaceRootRef: string): Promise<string | undefined> {
  try {
    const entries = await readdir(coverDir(workspaceRootRef))
    const hit = entries.find((name) => {
      const lower = name.toLowerCase()
      return lower.startsWith(`${COVER_BASENAME}.`) && IMAGE_EXT.has(extname(lower))
    })
    return hit === undefined ? undefined : join(coverDir(workspaceRootRef), hit)
  } catch {
    return undefined
  }
}

export async function readBookCoverDataUrl(workspaceRootRef: string): Promise<string | undefined> {
  const path = await findBookCoverPath(workspaceRootRef)
  if (path === undefined) return undefined
  const ext = extname(path).toLowerCase().replace(".", "")
  const mime = ext === "jpg" || ext === "jpeg"
    ? "image/jpeg"
    : ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "application/octet-stream"
  const bytes = await readFile(path)
  return `data:${mime};base64,${bytes.toString("base64")}`
}

export async function setBookCoverFromPath(
  workspaceRootRef: string,
  sourcePath: string,
): Promise<string> {
  const ext = extname(sourcePath).toLowerCase()
  if (!IMAGE_EXT.has(ext)) {
    throw new Error("请选择 png / jpg / webp / gif 图片作为封面")
  }
  const dir = coverDir(workspaceRootRef)
  await mkdir(dir, { recursive: true })
  // Clear previous cover variants
  try {
    const existing = await readdir(dir)
    await Promise.all(existing
      .filter((name) => name.toLowerCase().startsWith(`${COVER_BASENAME}.`))
      .map((name) => unlink(join(dir, name)).catch(() => undefined)))
  } catch {
    // ignore
  }
  const target = join(dir, `${COVER_BASENAME}${ext === ".jpeg" ? ".jpg" : ext}`)
  await copyFile(sourcePath, target)
  const dataUrl = await readBookCoverDataUrl(workspaceRootRef)
  if (dataUrl === undefined) throw new Error("封面写入后无法读取")
  return dataUrl
}
