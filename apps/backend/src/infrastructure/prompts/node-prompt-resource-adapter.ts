import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { AIPhase } from "@worldseed/contracts"
import {
  BASE_RULES_RESOURCE,
  PLOT_SYNOPSIS_GUIDE_RESOURCE,
  PROMPT_CONTRACT_VERSION,
  SETTINGS_QUERY_GUIDE_RESOURCE,
  SETTINGS_REVISION_GUIDE_RESOURCE,
  PLATFORM_BASE_RULE_RESOURCES,
  SYNOPSIS_DISCUSS_BASE_RULE_RESOURCES,
  resolvePromptDefinition,
} from "@worldseed/prompt-contracts"

import type { PromptResource, PromptResourcePort } from "../../application/index.js"
import { digest } from "../../core/index.js"

export class NodePromptResourceAdapter implements PromptResourcePort {
  public constructor(private readonly promptPackageRoot: string) {}

  public async loadBaseRules(): Promise<PromptResource> {
    return this.load(BASE_RULES_RESOURCE)
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

  public async loadTurnSystemRules(): Promise<PromptResource> {
    return this.loadComposite("turn-system-rules", PLATFORM_BASE_RULE_RESOURCES)
  }

  public async loadSynopsisDiscussSystemRules(): Promise<PromptResource> {
    return this.loadComposite("synopsis-discuss-system-rules", SYNOPSIS_DISCUSS_BASE_RULE_RESOURCES)
  }

  public async loadPhase(phase: AIPhase): Promise<PromptResource> {
    return this.load(resolvePromptDefinition(phase).resourcePath)
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
