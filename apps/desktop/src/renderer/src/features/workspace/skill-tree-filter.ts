/** Mirrors backend work-description-rules primary/skill filter for the left tree. */

export const DESCRIPTION_RULES_DIR = "表现输出/描写规则"
export const AUTO_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/自动.md`
export const SENSORY_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/感官描写.md`
export const DEAI_DESCRIPTION_RULE_PATH = `${DESCRIPTION_RULES_DIR}/去AI味.md`

const ALWAYS_ON_BASELINES = new Set([
  SENSORY_DESCRIPTION_RULE_PATH,
  DEAI_DESCRIPTION_RULE_PATH,
])

export function normalizeWorkspaceRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+/gu, "/")
}

/** Scene cards under 描写规则 (excludes auto conductor + always-on baselines). */
export function isDescriptionSceneCardPath(path: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(path)
  if (!normalized.startsWith(`${DESCRIPTION_RULES_DIR}/`)) return false
  if (!normalized.endsWith(".md")) return false
  if (normalized === AUTO_DESCRIPTION_RULE_PATH) return false
  if (ALWAYS_ON_BASELINES.has(normalized)) return false
  // Only direct children of 描写规则
  const rest = normalized.slice(DESCRIPTION_RULES_DIR.length + 1)
  return rest.length > 0 && !rest.includes("/")
}

/**
 * Default skill-filtered tree: hide description scene cards (load via dropdown / request_read).
 * When `showSceneCards` is true, show everything.
 */
export function filterInventoryForSkillView<T extends { path: string; kind?: string }>(
  entries: readonly T[],
  options?: Readonly<{ showSceneCards?: boolean }>,
): T[] {
  if (options?.showSceneCards === true) return [...entries]
  return entries.filter((entry) => !isDescriptionSceneCardPath(entry.path))
}
