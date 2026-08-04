import type { AIModelPort } from "../application/index.js"
import { BackendContainer, type BackendContainerOptions } from "./container.js"
import { BackendFacade } from "./backend-facade.js"
import { MessagePortTransport, type BackendMessagePort } from "../transport/index.js"

export type UtilityEntryOptions = BackendContainerOptions

export async function startBackendUtility(
  port: BackendMessagePort,
  options: UtilityEntryOptions,
): Promise<MessagePortTransport> {
  const container = await BackendContainer.open(options)
  const transport = new MessagePortTransport(port, new BackendFacade(container))
  transport.attach()
  return transport
}

export type UtilityModelFactory = () => AIModelPort
