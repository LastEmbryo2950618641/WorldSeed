import { createHash } from "node:crypto"

import { canonicalSerialize } from "../serialization/index.js"

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex")
}
