import { resolve } from "node:path"

import {
  deepSeekRuntimeConfigFromEnvironment,
  type DeepSeekEnvironment,
} from "@worldseed/config"

import type { AIModelPort } from "../../application/index.js"
import { EnvironmentSecretProvider, DeepSeekAiModelAdapter } from "./deepseek/deepseek-model-adapter.js"
import { FakeAiModelAdapter } from "./fake-ai-model-adapter.js"
import { NodePromptResourceAdapter } from "../prompts/index.js"

export function createModelFromEnvironment(
  promptPackageRoot: string,
  createId: () => string,
  values: DeepSeekEnvironment = process.env,
): AIModelPort {
  const config = deepSeekRuntimeConfigFromEnvironment(values)
  if (config === undefined) return new FakeAiModelAdapter(createId)

  return new DeepSeekAiModelAdapter(
    config,
    new EnvironmentSecretProvider(values),
    new NodePromptResourceAdapter(resolve(promptPackageRoot)),
  )
}
