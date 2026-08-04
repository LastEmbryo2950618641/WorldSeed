export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

export class CanonicalSerializationError extends TypeError {}

function normalize(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalSerializationError(`${path} contains a non-finite number`)
    }

    return Object.is(value, -0) ? 0 : value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${String(index)}]`))
  }

  if (typeof value !== "object") {
    throw new CanonicalSerializationError(`${path} is not JSON-compatible`)
  }

  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalSerializationError(`${path} must be a plain object`)
  }

  const normalized: Record<string, CanonicalJsonValue> = {}
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalize((value as Record<string, unknown>)[key], `${path}.${key}`)
  }

  return normalized
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(normalize(value, "$"))
}
