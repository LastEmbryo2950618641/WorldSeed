import { isChapterPlanningMarkdownPath, resolveChapterPathWithInventory } from "./synopsis-path.js"

export async function readPlanningFile(
  path: string,
  workspace: Readonly<{
    read(path: string): Promise<string>
    listPaths(): Promise<readonly string[]>
  }>,
): Promise<{ path: string; content: string }> {
  try {
    return { path, content: await workspace.read(path) }
  } catch (error) {
    // IPC currently preserves filesystem errors as messages, without their code.
    const missing = error instanceof Error
      && (("code" in error && error.code === "ENOENT") || error.message.startsWith("ENOENT:"))
    if (!missing || !isChapterPlanningMarkdownPath(path)) throw error
    const replacement = resolveChapterPathWithInventory(path, await workspace.listPaths())
    if (replacement === path) {
      throw new Error(`文件已移动、删除或存在多个同章文稿，请刷新工作目录后重新选择：${path}`, { cause: error })
    }
    return { path: replacement, content: await workspace.read(replacement) }
  }
}
