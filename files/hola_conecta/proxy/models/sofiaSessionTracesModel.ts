import type { SofiaJsonObject } from '../sofia/shared/sofiaWorkflow.ts'
import { sql } from '../db/neon.js'
import { logError } from '../utils/logger.js'

export type SofiaSessionFinalStatus = 'active' | 'completed' | 'failed' | 'handoff' | 'abandoned'

export interface SofiaSessionTraceRow {
  id: string
  org_id: string
  trace_id: string
  session_id: string
  entry_point: string
  channel: string
  actor_type: string
  contact_id: string | null
  user_id: string | null
  started_at: string
  ended_at: string | null
  final_intent: string | null
  final_status: SofiaSessionFinalStatus
  human_handoff: boolean
  summary: string | null
  metadata: SofiaJsonObject
}

export interface SofiaSessionTraceUpsert {
  id: string
  orgId: string
  traceId: string
  sessionId: string
  entryPoint: string
  channel: string
  actorType: string
  contactId?: string | null
  userId?: string | null
  startedAt?: string | null
  endedAt?: string | null
  finalIntent?: string | null
  finalStatus?: SofiaSessionFinalStatus
  humanHandoff?: boolean
  summary?: string | null
  metadata?: SofiaJsonObject
}

const DEFAULT_FINAL_STATUS: SofiaSessionFinalStatus = 'active'

function toRow(rows: SofiaSessionTraceRow[]): SofiaSessionTraceRow | null {
  return rows[0] ?? null
}

export async function startSofiaSessionTrace(input: SofiaSessionTraceUpsert): Promise<SofiaSessionTraceRow | null> {
  try {
    const rows = await sql<SofiaSessionTraceRow>`
      INSERT INTO sofia_session_traces (
        id,
        org_id,
        trace_id,
        session_id,
        entry_point,
        channel,
        actor_type,
        contact_id,
        user_id,
        started_at,
        final_status,
        metadata
      ) VALUES (
        ${input.id},
        ${input.orgId},
        ${input.traceId},
        ${input.sessionId},
        ${input.entryPoint},
        ${input.channel},
        ${input.actorType},
        ${input.contactId ?? null},
        ${input.userId ?? null},
        COALESCE(${input.startedAt ?? null}::timestamptz, NOW()),
        ${input.finalStatus ?? DEFAULT_FINAL_STATUS},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (org_id, trace_id)
      DO UPDATE SET
        session_id = COALESCE(NULLIF(EXCLUDED.session_id, ''), sofia_session_traces.session_id),
        entry_point = COALESCE(NULLIF(EXCLUDED.entry_point, ''), sofia_session_traces.entry_point),
        channel = COALESCE(NULLIF(EXCLUDED.channel, ''), sofia_session_traces.channel),
        actor_type = COALESCE(NULLIF(EXCLUDED.actor_type, ''), sofia_session_traces.actor_type),
        contact_id = COALESCE(EXCLUDED.contact_id, sofia_session_traces.contact_id),
        user_id = COALESCE(EXCLUDED.user_id, sofia_session_traces.user_id),
        metadata = COALESCE(sofia_session_traces.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
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
        started_at,
        ended_at,
        final_intent,
        final_status,
        human_handoff,
        summary,
        metadata
    `
    return toRow(rows)
  } catch (error) {
    logError('SofiaSessionTracesModel', 'Failed to start Sofia session trace', error, {
      orgId: input.orgId,
      traceId: input.traceId
    })
    throw error
  }
}

export async function completeSofiaSessionTrace(input: SofiaSessionTraceUpsert): Promise<SofiaSessionTraceRow | null> {
  try {
    const rows = await sql<SofiaSessionTraceRow>`
      UPDATE sofia_session_traces
      SET
        ended_at = COALESCE(${input.endedAt ?? null}::timestamptz, NOW()),
        final_intent = COALESCE(NULLIF(${input.finalIntent ?? null}, ''), final_intent),
        final_status = COALESCE(${input.finalStatus ?? null}, final_status),
        human_handoff = COALESCE(${input.humanHandoff ?? null}, human_handoff),
        summary = COALESCE(NULLIF(${input.summary ?? null}, ''), summary),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(input.metadata ?? {})}::jsonb
      WHERE org_id = ${input.orgId}
        AND trace_id = ${input.traceId}
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
        started_at,
        ended_at,
        final_intent,
        final_status,
        human_handoff,
        summary,
        metadata
    `
    return toRow(rows)
  } catch (error) {
    logError('SofiaSessionTracesModel', 'Failed to complete Sofia session trace', error, {
      orgId: input.orgId,
      traceId: input.traceId
    })
    throw error
  }
}
