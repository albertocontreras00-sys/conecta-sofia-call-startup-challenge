import type { SofiaJsonObject } from '../sofia/shared/sofiaWorkflow.ts'
import { sql } from '../db/neon.js'
import { logError } from '../utils/logger.js'

export type SofiaSensitivity = 'low' | 'medium' | 'high' | 'restricted'

export interface SofiaInteractionEventRow {
  id: string
  org_id: string
  trace_id: string
  session_id: string | null
  entry_point: string
  channel: string
  actor_type: string
  contact_id: string | null
  user_id: string | null
  event_type: string
  event_summary: string | null
  metadata: SofiaJsonObject
  sensitivity: SofiaSensitivity
  created_at: string
}

export interface SofiaInteractionEventInsert {
  id: string
  orgId: string
  traceId: string
  sessionId?: string | null
  entryPoint: string
  channel: string
  actorType: string
  contactId?: string | null
  userId?: string | null
  eventType: string
  eventSummary?: string | null
  metadata?: SofiaJsonObject
  sensitivity?: SofiaSensitivity
}

const DEFAULT_SENSITIVITY: SofiaSensitivity = 'low'

function toRow(rows: SofiaInteractionEventRow[]): SofiaInteractionEventRow | null {
  return rows[0] ?? null
}

export async function createSofiaInteractionEvent(input: SofiaInteractionEventInsert): Promise<SofiaInteractionEventRow | null> {
  try {
    const rows = await sql<SofiaInteractionEventRow>`
      INSERT INTO sofia_interaction_events (
        id,
        org_id,
        trace_id,
        session_id,
        entry_point,
        channel,
        actor_type,
        contact_id,
        user_id,
        event_type,
        event_summary,
        metadata,
        sensitivity
      ) VALUES (
        ${input.id},
        ${input.orgId},
        ${input.traceId},
        ${input.sessionId ?? null},
        ${input.entryPoint},
        ${input.channel},
        ${input.actorType},
        ${input.contactId ?? null},
        ${input.userId ?? null},
        ${input.eventType},
        ${input.eventSummary ?? null},
        ${JSON.stringify(input.metadata ?? {})}::jsonb,
        ${input.sensitivity ?? DEFAULT_SENSITIVITY}
      )
      RETURNING
        id,
        org_id,
        trace_id,
        session_id,
        entry_point,
        channel,
        actor_type,
        contact_id,
        user_id,
        event_type,
        event_summary,
        metadata,
        sensitivity,
        created_at
    `

    return toRow(rows)
  } catch (error) {
    logError('SofiaInteractionEventsModel', 'Failed to insert Sofia interaction event', error, {
      orgId: input.orgId,
      traceId: input.traceId,
      eventType: input.eventType
    })
    throw error
  }
}
