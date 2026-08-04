import { z } from "zod"

export const PROTOCOL_VERSION = "worldseed.v1" as const
export const SCHEMA_VERSION = 1 as const

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION)
export const schemaVersionSchema = z.literal(SCHEMA_VERSION)
