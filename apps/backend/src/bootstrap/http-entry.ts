import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"

import { BackendContainer } from "./container.js"
import { BackendFacade } from "./backend-facade.js"
import { HttpWsTransport } from "../transport/http/http-ws-transport.js"
import { loadApiTokenAuthFromEnv } from "../transport/http/api-token-auth.js"
import { runtimeLog } from "../infrastructure/diagnostics/index.js"

export type HttpBackendStartResult = Readonly<{
  transport: HttpWsTransport
  host: string
  port: number
}>

export async function startHttpBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HttpBackendStartResult> {
  const applicationDataRoot = resolve(env.WORLDSEED_APP_DATA_ROOT ?? join(process.cwd(), ".worldseed-data"))
  const promptPackageRoot = resolve(env.WORLDSEED_PROMPT_ROOT ?? join(process.cwd(), "packages", "prompt-contracts"))
  const host = env.WORLDSEED_HTTP_HOST?.trim() || "127.0.0.1"
  const port = Number.parseInt(env.WORLDSEED_HTTP_PORT ?? "8787", 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid WORLDSEED_HTTP_PORT: ${env.WORLDSEED_HTTP_PORT ?? ""}`)
  }
  const corsOrigin = env.WORLDSEED_HTTP_CORS_ORIGIN?.trim() || "*"
  const auth = loadApiTokenAuthFromEnv(env)
  if (auth.requireToken && auth.tokens.length === 0) {
    throw new Error(
      "WORLDSEED_API_TOKEN or WORLDSEED_API_TOKENS is required (or set WORLDSEED_HTTP_AUTH_OPTIONAL=true for local dev only)",
    )
  }

  const container = await BackendContainer.open({ applicationDataRoot, promptPackageRoot })
  const facade = new BackendFacade(container, {
    automaticEvolutionEnabled: env.WORLDSEED_AUTOMATIC_EVOLUTION_ENABLED !== "false",
  })
  const transport = new HttpWsTransport(facade, { host, port, auth, corsOrigin })
  const listening = await transport.listen()
  runtimeLog("info", "http-entry", "started", {
    ...listening,
    applicationDataRoot,
    promptPackageRoot,
  })
  return { transport, ...listening }
}

const currentModule = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentModule)) {
  void startHttpBackend().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
