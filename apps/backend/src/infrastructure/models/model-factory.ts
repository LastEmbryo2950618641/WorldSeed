import { resolve } from "node:path"

import {
  deepSeekRuntimeConfigSchema,
  deepSeekRuntimeConfigFromEnvironment,
  defaultDeepSeekRuntimeConfig,
  type DeepSeekEnvironment,
} from "@worldseed/config"

import type { AIModelPort } from "../../application/index.js"
import { EnvironmentSecretProvider, DeepSeekAiModelAdapter } from "./deepseek/deepseek-model-adapter.js"
import { UnavailableAiModelAdapter } from "./unavailable-ai-model-adapter.js"
import { NodePromptResourceAdapter } from "../prompts/index.js"

export type DeepSeekModelSelection = Readonly<{
  baseUrl: string
  model: string
  apiKey: string
  thinkingModeEnabled?: boolean
  reasoningEffort?: "low" | "high" | "max"
  jsonModeEnabled?: boolean
}>

export function createModelFromEnvironment(
  promptPackageRoot: string,
  values: DeepSeekEnvironment = process.env,
): AIModelPort {
  const config = deepSeekRuntimeConfigFromEnvironment(values)
  if (config === undefined) return new UnavailableAiModelAdapter()

  return new DeepSeekAiModelAdapter(
    config,
    new EnvironmentSecretProvider(values),
    new NodePromptResourceAdapter(resolve(promptPackageRoot)),
  )
}

export function createModelFromSelection(
  promptPackageRoot: string,
  selection: DeepSeekModelSelection,
): AIModelPort {
  const apiKey = selection.apiKey.trim()
  if (apiKey.length === 0) throw new Error("DeepSeek API key is empty")
  const config = deepSeekRuntimeConfigSchema.parse({
    ...defaultDeepSeekRuntimeConfig,
    baseUrl: selection.baseUrl.trim(),
    model: selection.model.trim(),
    apiKeyRef: "turn-api-key",
    thinkingModeEnabled: selection.thinkingModeEnabled ?? defaultDeepSeekRuntimeConfig.thinkingModeEnabled,
    reasoningEffort: selection.reasoningEffort ?? defaultDeepSeekRuntimeConfig.reasoningEffort,
    jsonModeEnabled: selection.jsonModeEnabled ?? defaultDeepSeekRuntimeConfig.jsonModeEnabled,
  })
  return new DeepSeekAiModelAdapter(
    config,
    { getSecret: (reference) => Promise.resolve(reference === "turn-api-key" ? apiKey : "") },
    new NodePromptResourceAdapter(resolve(promptPackageRoot)),
  )
}
