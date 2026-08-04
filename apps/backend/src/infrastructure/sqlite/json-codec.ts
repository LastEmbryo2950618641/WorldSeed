import { canonicalSerialize } from "../../core/index.js"

export function encodeJson(value: unknown): string {
  return canonicalSerialize(value)
}

export function decodeJson(value: string): unknown {
  return JSON.parse(value) as unknown
}
