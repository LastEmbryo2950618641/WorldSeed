import { useCallback, useEffect, useState } from "react"
import type { ChapterNarrativeIntent } from "@worldseed/contracts"

export type CreationDeskPresentationPreferences = Readonly<{
  descriptionRule: string
  proseRule: string
  minimumWordCount: string
  maximumWordCount: string
  boundaryPace: ChapterNarrativeIntent["boundaryPace"]
  causalityFocus: ChapterNarrativeIntent["causalityFocus"]
}>

const STORAGE_PREFIX = "worldseed.creationDeskPresentation."

const BOUNDARY_PACE_VALUES = ["advance_allowed", "hold_without_resolution"] as const
const CAUSALITY_FOCUS_VALUES = ["auto", "buildup", "action", "payoff"] as const

export const DEFAULT_CREATION_DESK_PRESENTATION: CreationDeskPresentationPreferences = {
  descriptionRule: "",
  proseRule: "",
  minimumWordCount: "2000",
  maximumWordCount: "3000",
  boundaryPace: "advance_allowed",
  causalityFocus: "auto",
}

export function useCreationDeskPresentationPreferences(
  projectId: string | undefined,
): readonly [
  CreationDeskPresentationPreferences,
  (patch: Partial<CreationDeskPresentationPreferences>) => void,
] {
  const [preferences, setPreferences] = useState<CreationDeskPresentationPreferences>(
    () => loadCreationDeskPresentationPreferences(projectId),
  )

  useEffect(() => {
    setPreferences(loadCreationDeskPresentationPreferences(projectId))
  }, [projectId])

  const update = useCallback((patch: Partial<CreationDeskPresentationPreferences>): void => {
    setPreferences((current) => {
      const next = { ...current, ...patch }
      if (projectId !== undefined) {
        try {
          window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(next))
        } catch {
          // Ignore quota / private-mode failures; in-memory values still work this session.
        }
      }
      return next
    })
  }, [projectId])

  return [preferences, update]
}

export function loadCreationDeskPresentationPreferences(
  projectId: string | undefined,
): CreationDeskPresentationPreferences {
  if (projectId === undefined) return DEFAULT_CREATION_DESK_PRESENTATION
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`)
    if (raw === null) return DEFAULT_CREATION_DESK_PRESENTATION
    const parsed = JSON.parse(raw) as Partial<CreationDeskPresentationPreferences>
    return {
      descriptionRule: typeof parsed.descriptionRule === "string" ? parsed.descriptionRule : "",
      proseRule: typeof parsed.proseRule === "string" ? parsed.proseRule : "",
      minimumWordCount: isPositiveIntString(parsed.minimumWordCount)
        ? parsed.minimumWordCount
        : DEFAULT_CREATION_DESK_PRESENTATION.minimumWordCount,
      maximumWordCount: isPositiveIntString(parsed.maximumWordCount)
        ? parsed.maximumWordCount
        : DEFAULT_CREATION_DESK_PRESENTATION.maximumWordCount,
      boundaryPace: BOUNDARY_PACE_VALUES.includes(parsed.boundaryPace as typeof BOUNDARY_PACE_VALUES[number])
        ? parsed.boundaryPace as ChapterNarrativeIntent["boundaryPace"]
        : DEFAULT_CREATION_DESK_PRESENTATION.boundaryPace,
      causalityFocus: CAUSALITY_FOCUS_VALUES.includes(parsed.causalityFocus as typeof CAUSALITY_FOCUS_VALUES[number])
        ? parsed.causalityFocus as ChapterNarrativeIntent["causalityFocus"]
        : DEFAULT_CREATION_DESK_PRESENTATION.causalityFocus,
    }
  } catch {
    return DEFAULT_CREATION_DESK_PRESENTATION
  }
}

function isPositiveIntString(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
}
