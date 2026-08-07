import type { ModelListPayload, ModelListResult } from "@worldseed/contracts"

export type ModelCatalogPort = Readonly<{
  list(input: ModelListPayload): Promise<ModelListResult>
}>
