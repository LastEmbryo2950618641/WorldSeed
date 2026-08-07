import type { AIModelPort } from "../application/index.js"
import { BackendContainer, type BackendContainerOptions } from "./container.js"
import { BackendFacade } from "./backend-facade.js"
import { MessagePortTransport, type BackendMessagePort } from "../transport/index.js"
import { configureRuntimeDiagnostics } from "../infrastructure/diagnostics/index.js"
import type { RuntimeDiagnosticsConfig } from "@worldseed/config"

export type UtilityEntryOptions = BackendContainerOptions & Readonly<{
  diagnostics: RuntimeDiagnosticsConfig
}>

export async function startBackendUtility(
  port: BackendMessagePort,
  options: UtilityEntryOptions,
): Promise<MessagePortTransport> {
  configureRuntimeDiagnostics(options.diagnostics)
  const container = await BackendContainer.open(options)
  const transport = new MessagePortTransport(port, new BackendFacade(container))
  transport.attach()
  return transport
}

export type UtilityModelFactory = () => AIModelPort
