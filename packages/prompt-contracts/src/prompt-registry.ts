import { aiPhaseValues, type AIPhase } from "@worldseed/contracts"

import { SKILL_INDEX_RESOURCE } from "./skill-registry.js"

export const PROMPT_CONTRACT_VERSION = "v1" as const
export const BASE_RULES_RESOURCE = "resources/v1/base-rules.md" as const
export const CONTENT_HANDLING_RESOURCE = "resources/v1/content-handling.md" as const
export const WEBNOVEL_PROSE_LOGIC_RESOURCE = "resources/v1/webnovel-prose-logic.md" as const
export const PLOT_SYNOPSIS_GUIDE_RESOURCE = "resources/v1/plot-synopsis-guide.md" as const
export const SETTINGS_QUERY_GUIDE_RESOURCE = "resources/v1/settings-query-guide.md" as const
export const SETTINGS_REVISION_GUIDE_RESOURCE = "resources/v1/settings-revision-guide.md" as const
export const DISCUSS_CREATION_DESK_WORKFLOW_RESOURCE = "resources/v1/discuss-creation-desk-workflow.md" as const

/** Upstream MIT webnovel craft (tance-mang/chinese-webnovel-skills) — loaded via skills, not always-on composites. */
export const WEBNOVEL_VENDOR_DESLOP_RESOURCE = "resources/vendor/chinese-webnovel-skills/skills/deslop.md" as const
export const WEBNOVEL_VENDOR_DIALOGUE_RESOURCE = "resources/vendor/chinese-webnovel-skills/skills/dialogue.md" as const
export const WEBNOVEL_VENDOR_HUMAN_RESOURCE = "resources/vendor/chinese-webnovel-skills/skills/human.md" as const
export const WEBNOVEL_VENDOR_EMOTION_RESOURCE = "resources/vendor/chinese-webnovel-skills/skills/emotion.md" as const
export const WEBNOVEL_VENDOR_ANTI_AI_CHECKLIST_RESOURCE = "resources/vendor/chinese-webnovel-skills/references/anti-ai-checklist.md" as const
export const WEBNOVEL_VENDOR_DIALOGUE_LIBRARY_RESOURCE = "resources/vendor/chinese-webnovel-skills/references/dialogue-library.md" as const
export const WEBNOVEL_VENDOR_HUMAN_TEXTURE_RESOURCE = "resources/vendor/chinese-webnovel-skills/references/human-texture.md" as const
export const WEBNOVEL_VENDOR_SHOW_EMOTION_RESOURCE = "resources/vendor/chinese-webnovel-skills/references/show-emotion.md" as const
export const WEBNOVEL_VENDOR_SENTENCE_RHYTHM_RESOURCE = "resources/vendor/chinese-webnovel-skills/references/sentence-rhythm.md" as const

/** @deprecated Prefer PLATFORM_SKILLS / loadSkill — kept for tests that assert vendor files exist. */
export const WEBNOVEL_VENDOR_WRITE_RULE_RESOURCES = Object.freeze([
  WEBNOVEL_VENDOR_DESLOP_RESOURCE,
  WEBNOVEL_VENDOR_DIALOGUE_RESOURCE,
  WEBNOVEL_VENDOR_HUMAN_RESOURCE,
  WEBNOVEL_VENDOR_EMOTION_RESOURCE,
  WEBNOVEL_VENDOR_ANTI_AI_CHECKLIST_RESOURCE,
  WEBNOVEL_VENDOR_DIALOGUE_LIBRARY_RESOURCE,
  WEBNOVEL_VENDOR_HUMAN_TEXTURE_RESOURCE,
  WEBNOVEL_VENDOR_SHOW_EMOTION_RESOURCE,
  WEBNOVEL_VENDOR_SENTENCE_RHYTHM_RESOURCE,
] as const)

/**
 * Sticky system_rules only: hard gates + short skill index.
 * Full vendor / discuss guides load via default skill pack or load_skill.
 */
export const PLATFORM_BASE_RULE_RESOURCES = Object.freeze([
  BASE_RULES_RESOURCE,
  CONTENT_HANDLING_RESOURCE,
  WEBNOVEL_PROSE_LOGIC_RESOURCE,
  SETTINGS_QUERY_GUIDE_RESOURCE,
  SKILL_INDEX_RESOURCE,
] as const)

/** Discuss sticky prefix — same thin base; workflow/guides are default skills for synopsis_discuss. */
export const SYNOPSIS_DISCUSS_BASE_RULE_RESOURCES = Object.freeze([
  ...PLATFORM_BASE_RULE_RESOURCES,
] as const)

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
