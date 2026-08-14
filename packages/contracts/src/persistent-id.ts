import { z } from "zod"

import { idSchema } from "./ids.js"

export const persistentIdPrefixValues = [
  "node",
  "link",
  "evidence",
  "source",
  "revision",
] as const

export const persistentIdPrefixSchema = z.enum(persistentIdPrefixValues)
export type PersistentIdPrefix = z.infer<typeof persistentIdPrefixSchema>

export const persistentIdSchema = z.string().regex(/^(?:node|link|evidence|source|revision)_[1-9][0-9]*$/u)

const persistentIdPatterns = {
  node: /^node_[1-9][0-9]*$/u,
  link: /^link_[1-9][0-9]*$/u,
  evidence: /^evidence_[1-9][0-9]*$/u,
  source: /^source_[1-9][0-9]*$/u,
  revision: /^revision_[1-9][0-9]*$/u,
} as const

export const persistentNodeIdSchema = z.string().regex(persistentIdPatterns.node)
export const persistentLinkIdSchema = z.string().regex(persistentIdPatterns.link)
export const persistentEvidenceIdSchema = z.string().regex(persistentIdPatterns.evidence)
export const persistentSourceIdSchema = z.string().regex(persistentIdPatterns.source)
export const persistentRevisionIdSchema = z.string().regex(persistentIdPatterns.revision)

export const nodeObjectIdSchema = z.union([idSchema, persistentNodeIdSchema])
export const linkObjectIdSchema = z.union([idSchema, persistentLinkIdSchema])
export const graphObjectIdSchema = z.union([nodeObjectIdSchema, linkObjectIdSchema])
export const evidenceObjectIdSchema = z.union([idSchema, persistentEvidenceIdSchema])
export const sourceObjectIdSchema = z.union([idSchema, persistentSourceIdSchema])
export const revisionObjectIdSchema = z.union([idSchema, persistentRevisionIdSchema])
export const storedObjectReferenceIdSchema = z.union([idSchema, persistentIdSchema])

export function formatPersistentId(prefix: PersistentIdPrefix, value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid persistent ID counter value: ${String(value)}`)
  return `${prefix}_${String(value)}`
}
