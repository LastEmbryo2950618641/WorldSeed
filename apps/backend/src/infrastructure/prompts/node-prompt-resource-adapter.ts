import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { AIPhase } from "@worldseed/contracts"
import {
  BASE_RULES_RESOURCE,
  PROMPT_CONTRACT_VERSION,
  resolvePromptDefinition,
} from "@worldseed/prompt-contracts"

import type { PromptResource, PromptResourcePort } from "../../application/index.js"
import { digest } from "../../core/index.js"

export class NodePromptResourceAdapter implements PromptResourcePort {
  public constructor(private readonly promptPackageRoot: string) {}

  public async loadBaseRules(): Promise<PromptResource> {
    return this.load(BASE_RULES_RESOURCE)
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
}

function normalizePrompt(text: string): string {
  return text.replaceAll("\r\n", "\n").trimEnd() + "\n"
}
