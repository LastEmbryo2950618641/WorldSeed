import { aiPhaseValues, type AIPhase } from "@worldseed/contracts"

export const PROMPT_CONTRACT_VERSION = "v1" as const
export const BASE_RULES_RESOURCE = "resources/v1/base-rules.md" as const
export const PLOT_SYNOPSIS_GUIDE_RESOURCE = "resources/v1/plot-synopsis-guide.md" as const

export type PromptDefinition = {
  readonly phase: AIPhase
  readonly version: typeof PROMPT_CONTRACT_VERSION
  readonly resourcePath: string
}

export const promptDefinitions: Record<AIPhase, PromptDefinition> = Object.fromEntries(
  aiPhaseValues.map((phase) => [
    phase,
    {
      phase,
      version: PROMPT_CONTRACT_VERSION,
      resourcePath: `resources/v1/phases/${phase.replaceAll("_", "-")}.md`,
    },
  ]),
) as Record<AIPhase, PromptDefinition>

export function resolvePromptDefinition(phase: AIPhase): PromptDefinition {
  return promptDefinitions[phase]
}
