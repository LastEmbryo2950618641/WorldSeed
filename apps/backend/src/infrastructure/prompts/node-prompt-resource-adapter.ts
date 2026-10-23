import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { AIPhase } from "@worldseed/contracts"
import {
  BASE_RULES_RESOURCE,
  CONTENT_HANDLING_RESOURCE,
  DISCUSS_CREATION_DESK_WORKFLOW_RESOURCE,
  PLOT_SYNOPSIS_GUIDE_RESOURCE,
  PROMPT_CONTRACT_VERSION,
  SETTINGS_QUERY_GUIDE_RESOURCE,
  SETTINGS_REVISION_GUIDE_RESOURCE,
  WEBNOVEL_PROSE_LOGIC_RESOURCE,
  PLATFORM_BASE_RULE_RESOURCES,
  SYNOPSIS_DISCUSS_BASE_RULE_RESOURCES,
  defaultSkillIdsForPhase,
  formatSkillEvidenceHeader,
  listPlatformSkills,
  resolvePromptDefinition,
  resolveSkillDefinition,
  SYNOPSIS_SKILLS_PROTOCOL,
} from "@worldseed/prompt-contracts"

import type { LoadedSkillResource, PromptResource, PromptResourcePort } from "../../application/index.js"
import { digest } from "../../core/index.js"

export class NodePromptResourceAdapter implements PromptResourcePort {
  public constructor(private readonly promptPackageRoot: string) {}

  public async loadBaseRules(): Promise<PromptResource> {
    return this.load(BASE_RULES_RESOURCE)
  }

  public async loadContentHandling(): Promise<PromptResource> {
    return this.load(CONTENT_HANDLING_RESOURCE)
  }

  public async loadWebnovelProseLogic(): Promise<PromptResource> {
    return this.load(WEBNOVEL_PROSE_LOGIC_RESOURCE)
  }

  public async loadPlotSynopsisGuide(): Promise<PromptResource> {
    return this.load(PLOT_SYNOPSIS_GUIDE_RESOURCE)
  }

  public async loadSettingsQueryGuide(): Promise<PromptResource> {
    return this.load(SETTINGS_QUERY_GUIDE_RESOURCE)
  }

  public async loadSettingsRevisionGuide(): Promise<PromptResource> {
    return this.load(SETTINGS_REVISION_GUIDE_RESOURCE)
  }

  public async loadDiscussCreationDeskWorkflow(): Promise<PromptResource> {
    return this.load(DISCUSS_CREATION_DESK_WORKFLOW_RESOURCE)
  }

  public async loadTurnSystemRules(): Promise<PromptResource> {
    return this.loadComposite("turn-system-rules", PLATFORM_BASE_RULE_RESOURCES)
  }

  public async loadSynopsisDiscussSystemRules(): Promise<PromptResource> {
    return this.loadComposite("synopsis-discuss-system-rules", SYNOPSIS_DISCUSS_BASE_RULE_RESOURCES)
  }

  public async loadPhase(phase: AIPhase): Promise<PromptResource> {
    return this.load(resolvePromptDefinition(phase).resourcePath)
  }

  public async listSkills(): Promise<readonly Readonly<{
    id: string
    name: string
    summary: string
    injectPolicy: string
    defaultPhases: readonly string[]
  }>[]> {
    return listPlatformSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      summary: skill.summary,
      injectPolicy: skill.injectPolicy,
      defaultPhases: [...skill.defaultPhases],
    }))
  }

  public async loadSkill(
    skillId: string,
    options?: Readonly<{ includeReferences?: boolean }>,
  ): Promise<LoadedSkillResource> {
    const skill = resolveSkillDefinition(skillId)
    if (skill === undefined) {
      throw new Error(`Unknown skill: ${skillId}`)
    }
    const includeReferences = options?.includeReferences === true
    const paths = includeReferences
      ? [skill.primaryResource, ...skill.referenceResources]
      : [skill.primaryResource]
    const parts = await Promise.all(paths.map((resourcePath) => this.load(resourcePath)))
    const header = formatSkillEvidenceHeader(skill.id, includeReferences)
    const text = composePromptTexts([header, ...parts.map((part) => part.text)])
    return {
      skillId: skill.id,
      includeReferences,
      ref: `${PROMPT_CONTRACT_VERSION}:skill:${skill.id}${includeReferences ? "+refs" : ""}`,
      version: PROMPT_CONTRACT_VERSION,
      digest: digest(text),
      text,
    }
  }

  public async loadDefaultSkillPack(phase: AIPhase | "synopsis_discuss"): Promise<PromptResource> {
    const skillIds = defaultSkillIdsForPhase(phase)
    if (skillIds.length === 0) {
      const empty = `${formatSkillEvidenceHeader("none", false)}\n（本阶段无默认 skill 包）\n`
      return {
        ref: `${PROMPT_CONTRACT_VERSION}:skill-pack:${phase}:empty`,
        version: PROMPT_CONTRACT_VERSION,
        digest: digest(empty),
        text: empty,
      }
    }
    const loaded = await Promise.all(skillIds.map((id) => this.loadSkill(id, { includeReferences: false })))
    const envelope = JSON.stringify({
      protocol: SYNOPSIS_SKILLS_PROTOCOL,
      kind: "default_pack",
      phase,
      skillIds,
    })
    const text = composePromptTexts([
      `【skill-pack:${phase}】默认挂载（不含 references；可用 load_skill 加深）`,
      envelope,
      ...loaded.map((part) => part.text),
    ])
    return {
      ref: `${PROMPT_CONTRACT_VERSION}:skill-pack:${phase}`,
      version: PROMPT_CONTRACT_VERSION,
      digest: digest(text),
      text,
    }
  }

  private async load(resourcePath: string): Promise<PromptResource> {
    const text = normalizePrompt(await readFile(resolve(this.promptPackageRoot, resourcePath), "utf8"))
    return {
      ref: `${PROMPT_CONTRACT_VERSION}:${resourcePath}`,
      version: PROMPT_CONTRACT_VERSION,
      digest: digest(text),
      text,
    }
  }

  private async loadComposite(refSuffix: string, resourcePaths: readonly string[]): Promise<PromptResource> {
    const parts = await Promise.all(resourcePaths.map((resourcePath) => this.load(resourcePath)))
    const text = composePromptTexts(parts.map((part) => part.text))
    return {
      ref: `${PROMPT_CONTRACT_VERSION}:${refSuffix}`,
      version: PROMPT_CONTRACT_VERSION,
      digest: digest(text),
      text,
    }
  }
}

export function composePromptTexts(segments: readonly string[]): string {
  return segments
    .map((segment) => segment.replaceAll("\r\n", "\n").trim())
    .filter((segment) => segment.length > 0)
    .join("\n\n---\n\n") + "\n"
}

function normalizePrompt(text: string): string {
  return text.replaceAll("\r\n", "\n").trimEnd() + "\n"
}
