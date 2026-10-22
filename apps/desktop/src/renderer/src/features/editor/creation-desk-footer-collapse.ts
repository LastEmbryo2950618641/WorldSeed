export const CREATION_DESK_FOOTER_COLLAPSE_LEVELS = [
  "full",
  "composer",
  "minimal",
] as const

export type CreationDeskFooterCollapse = (typeof CREATION_DESK_FOOTER_COLLAPSE_LEVELS)[number]

export const CREATION_DESK_FOOTER_COLLAPSE_STORAGE_KEY = "worldseed.creationDeskFooterCollapse"

/** Pixels of pointer travel per snap step between collapse levels. */
export const CREATION_DESK_FOOTER_COLLAPSE_STEP_PX = 48

export function parseCreationDeskFooterCollapse(raw: string | null | undefined): CreationDeskFooterCollapse {
  if (raw === "full" || raw === "composer" || raw === "minimal") return raw
  return "full"
}

export function loadCreationDeskFooterCollapse(): CreationDeskFooterCollapse {
  try {
    if (typeof window === "undefined") return "full"
    return parseCreationDeskFooterCollapse(window.localStorage.getItem(CREATION_DESK_FOOTER_COLLAPSE_STORAGE_KEY))
  } catch {
    return "full"
  }
}

export function persistCreationDeskFooterCollapse(level: CreationDeskFooterCollapse): void {
  try {
    window.localStorage.setItem(CREATION_DESK_FOOTER_COLLAPSE_STORAGE_KEY, level)
  } catch {
    // ignore storage failures
  }
}

export function resolveCreationDeskFooterCollapseDrag(
  startLevel: CreationDeskFooterCollapse,
  deltaY: number,
  stepPx = CREATION_DESK_FOOTER_COLLAPSE_STEP_PX,
): CreationDeskFooterCollapse {
  const startIndex = CREATION_DESK_FOOTER_COLLAPSE_LEVELS.indexOf(startLevel)
  if (startIndex < 0) return "full"
  const steps = Math.trunc(deltaY / stepPx)
  const nextIndex = Math.max(0, Math.min(CREATION_DESK_FOOTER_COLLAPSE_LEVELS.length - 1, startIndex + steps))
  return CREATION_DESK_FOOTER_COLLAPSE_LEVELS[nextIndex] ?? "full"
}

export function expandCreationDeskFooterCollapse(level: CreationDeskFooterCollapse): CreationDeskFooterCollapse {
  const index = CREATION_DESK_FOOTER_COLLAPSE_LEVELS.indexOf(level)
  if (index <= 0) return "full"
  return CREATION_DESK_FOOTER_COLLAPSE_LEVELS[index - 1] ?? "full"
}
