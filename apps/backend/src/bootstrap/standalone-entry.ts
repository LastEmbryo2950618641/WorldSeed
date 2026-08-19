import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"

import { BackendContainer } from "./container.js"
import { BackendFacade } from "./backend-facade.js"
import { StdioTransport } from "../transport/index.js"

export async function startStandaloneBackend(): Promise<StdioTransport> {
  const applicationDataRoot = resolve(process.env.WORLDSEED_APP_DATA_ROOT ?? join(process.cwd(), ".worldseed-data"))
  const promptPackageRoot = resolve(process.env.WORLDSEED_PROMPT_ROOT ?? join(process.cwd(), "packages", "prompt-contracts"))
  const container = await BackendContainer.open({ applicationDataRoot, promptPackageRoot })
  const transport = new StdioTransport(new BackendFacade(container, {
    automaticEvolutionEnabled: process.env.WORLDSEED_AUTOMATIC_EVOLUTION_ENABLED !== "false",
  }))
  transport.attach()
  return transport
}

const currentModule = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentModule)) {
  void startStandaloneBackend()
}
