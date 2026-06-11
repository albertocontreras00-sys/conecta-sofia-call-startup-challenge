import type { SofiaJsonObject } from '../sofia/shared/sofiaWorkflow.ts'
import { sql } from '../db/neon.js'
import { logError } from '../utils/logger.js'

export type SofiaSensitivity = 'low' | 'medium' | 'high' | 'restricted'
export type SofiaAllowedDisclosureLevel = 'none' | 'low' | 'medium' | 'high' | 'verified_only'
export type SofiaConfidence = 'low' | 'medium' | 'high'

export interface SofiaMemoryEntryRow {
  id: string
  org_id: string
  contact_id: string | null
  user_id: string | null
  household_id: string | null
  memory_kind: string
  memory_summary: string
  source_event_id: string | null
  confidence: SofiaConfidence
  sensitivity: SofiaSensitivity
  allowed_disclosure_level: SofiaAllowedDisclosureLevel
  expires_at: string | null
  created_at: string
  updated_at: string
  created_by_system: string
}

export interface SofiaMemoryEntryInsert {
  id: string
  orgId: string
  contactId?: string | null
  userId?: string | null
  householdId?: string | null
  memoryKind: string
  memorySummary: string
  sourceEventId?: string | null
  confidence?: SofiaConfidence
  sensitivity?: SofiaSensitivity
  allowedDisclosureLevel?: SofiaAllowedDisclosureLevel
  expiresAt?: string | null
  createdBySystem?: string
}

export interface SofiaMemoryEntryLookup {
  orgId: string
  contactId?: string | null
  userId?: string | null
  householdId?: string | null
  memoryKinds?: string[]
  maxRows?: number
  metadataFilter?: SofiaJsonObject
}

export const SOFIA_MEMORY_ENTRIES_MODEL_STATUS = 'active'

function toRow(rows: SofiaMemoryEntryRow[]): SofiaMemoryEntryRow | null {
  return rows[0] ?? null
}

export async function createSofiaMemoryEntry(input: SofiaMemoryEntryInsert): Promise<SofiaMemoryEntryRow | null> {
  try {
    const rows = await sql<SofiaMemoryEntryRow>`
      INSERT INTO sofia_memory_entries (
        id,
        org_id,
        contact_id,
        user_id,
        household_id,
        memory_kind,
        memory_summary,
        source_event_id,
        confidence,
        sensitivity,
        allowed_disclosure_level,
        expires_at,
        created_by_system
      ) VALUES (
        ${input.id},
        ${input.orgId},
        ${input.contactId ?? null},
        ${input.userId ?? null},
        ${input.householdId ?? null},
        ${input.memoryKind},
        ${input.memorySummary},
        ${input.sourceEventId ?? null},
        ${input.confidence ?? 'medium'},
        ${input.sensitivity ?? 'low'},
        ${input.allowedDisclosureLevel ?? 'low'},
        ${input.expiresAt ?? null}::timestamptz,
        ${input.createdBySystem ?? 'sofia'}
      )
      RETURNING
        id,
        org_id,
        contact_id,
        user_id,
        household_id,
        memory_kind,
        memory_summary,
        source_event_id,
        confidence,
        sensitivity,
        allowed_disclosure_level,
        expires_at,
        created_at,
        updated_at,
        created_by_system
    `

    return toRow(rows)
  } catch (error) {
    logError('SofiaMemoryEntriesModel', 'Failed to insert Sofia memory entry', error, {
      orgId: input.orgId,
      memoryKind: input.memoryKind
    })
    throw error
  }
}
