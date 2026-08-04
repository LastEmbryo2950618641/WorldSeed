import { startBackendUtility, type UtilityEntryOptions } from "@worldseed/backend"

process.parentPort.on("message", (event) => {
  if (!isConnectMessage(event.data) || event.ports[0] === undefined) return
  void startBackendUtility(event.ports[0], event.data.options)
})

function isConnectMessage(value: unknown): value is { type: "connect"; options: UtilityEntryOptions } {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const options = record.options
  return record.type === "connect"
    && typeof options === "object"
    && options !== null
    && typeof (options as Record<string, unknown>).applicationDataRoot === "string"
    && typeof (options as Record<string, unknown>).promptPackageRoot === "string"
}
