export type CredentialReader = Readonly<{
  get(reference: string): Promise<string | undefined>
}>

export async function resolveModelCredential<
  T extends { model?: { apiKey?: string | undefined; credentialRef: string } | undefined },
>(payload: T, credentials: CredentialReader): Promise<T> {
  if (payload.model === undefined || payload.model.apiKey !== undefined) return payload
  const apiKey = await credentials.get(payload.model.credentialRef)
  if (apiKey === undefined || apiKey.trim().length === 0) throw new Error("Model API Key is not configured")
  return { ...payload, model: { ...payload.model, apiKey } }
}
