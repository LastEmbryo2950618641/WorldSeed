export function folderLabelFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "")
  const segments = trimmed.split(/[\\/]/u).filter((part) => part.length > 0)
  return segments.at(-1) ?? path
}

export function joinWorkspacePath(parent: string, child: string): string {
  const separator = parent.includes("\\") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/u, "")}${separator}${child.replace(/^[\\/]+/u, "")}`
}

function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+$/u, "").toLowerCase()
}

/** True when workspace is inside one of the configured software work directories. */
export function isUnderWorkDirectories(workspaceRootRef: string, workDirectories: readonly string[]): boolean {
  if (workDirectories.length === 0) return true
  const target = normalizePath(workspaceRootRef)
  return workDirectories.some((directory) => {
    const root = normalizePath(directory)
    if (root.length === 0) return false
    return target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)
  })
}
