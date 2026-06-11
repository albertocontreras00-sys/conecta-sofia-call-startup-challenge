import crypto from 'node:crypto';
import { sql } from '../db/neon.js';
import { logError } from '../utils/logger.js';

type JsonRecord = Record<string, unknown>;

export type SofiaVoiceConversationTurnKind = 'initial_greeting' | 'voice_turn' | 'error_response';

export interface SofiaVoiceConversationTurnInsert {
  orgId: string;
  callId: string;
  sessionId: string;
  turnId?: string | null;
  turnNumber: number;
  turnKind: SofiaVoiceConversationTurnKind;
  callerTranscript?: string | null;
  sofiaResponseText?: string | null;
  responseLatencyMs?: number | null;
  shouldEndCall?: boolean;
  handoff?: boolean;
  actions?: unknown[];
  metadata?: JsonRecord;
}

export interface SofiaVoiceConversationTurnRow {
  id: string;
  org_id: string;
  call_id: string;
  session_id: string;
  turn_id: string | null;
  turn_number: number;
  turn_kind: SofiaVoiceConversationTurnKind;
  caller_transcript: string | null;
  sofia_response_text: string | null;
  response_latency_ms: number | null;
  should_end_call: boolean;
  handoff: boolean;
  actions: unknown[];
  metadata: JsonRecord;
  sensitivity: 'restricted';
  retention_expires_at: string;
  created_at: string;
  updated_at: string;
}

function normalizeText(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeActions(value: unknown[] | undefined): unknown[] {
  return Array.isArray(value) ? value.slice(0, 20) : [];
}

function toRow(rows: SofiaVoiceConversationTurnRow[]): SofiaVoiceConversationTurnRow | null {
  return rows[0] ?? null;
}

export async function upsertSofiaVoiceConversationTurn(input: SofiaVoiceConversationTurnInsert): Promise<SofiaVoiceConversationTurnRow | null> {
  try {
    const rows = await sql<SofiaVoiceConversationTurnRow>`
      INSERT INTO sofia_voice_conversation_turns (
        id,
        org_id,
        call_id,
        session_id,
        turn_id,
        turn_number,
        turn_kind,
        caller_transcript,
        sofia_response_text,
        response_latency_ms,
        should_end_call,
        handoff,
        actions,
        metadata
      ) VALUES (
        ${crypto.randomUUID()},
        ${input.orgId},
        ${input.callId},
        ${input.sessionId},
        ${input.turnId ?? null},
        ${input.turnNumber},
        ${input.turnKind},
        ${normalizeText(input.callerTranscript)},
        ${normalizeText(input.sofiaResponseText)},
        ${input.responseLatencyMs ?? null},
        ${input.shouldEndCall === true},
        ${input.handoff === true},
        ${JSON.stringify(normalizeActions(input.actions))}::jsonb,
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT (org_id, call_id, turn_number, turn_kind)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        turn_id = COALESCE(EXCLUDED.turn_id, sofia_voice_conversation_turns.turn_id),
        caller_transcript = CASE
          WHEN EXCLUDED.caller_transcript IS NULL THEN sofia_voice_conversation_turns.caller_transcript
          WHEN sofia_voice_conversation_turns.caller_transcript IS NULL THEN EXCLUDED.caller_transcript
          WHEN POSITION(EXCLUDED.caller_transcript IN sofia_voice_conversation_turns.caller_transcript) > 0 THEN sofia_voice_conversation_turns.caller_transcript
          WHEN POSITION(sofia_voice_conversation_turns.caller_transcript IN EXCLUDED.caller_transcript) > 0 THEN EXCLUDED.caller_transcript
          ELSE TRIM(sofia_voice_conversation_turns.caller_transcript || ' ' || EXCLUDED.caller_transcript)
        END,
        sofia_response_text = CASE
          WHEN EXCLUDED.sofia_response_text IS NULL THEN sofia_voice_conversation_turns.sofia_response_text
          WHEN sofia_voice_conversation_turns.sofia_response_text IS NULL THEN EXCLUDED.sofia_response_text
          WHEN POSITION(EXCLUDED.sofia_response_text IN sofia_voice_conversation_turns.sofia_response_text) > 0 THEN sofia_voice_conversation_turns.sofia_response_text
          WHEN POSITION(sofia_voice_conversation_turns.sofia_response_text IN EXCLUDED.sofia_response_text) > 0 THEN EXCLUDED.sofia_response_text
          ELSE TRIM(sofia_voice_conversation_turns.sofia_response_text || ' ' || EXCLUDED.sofia_response_text)
        END,
        response_latency_ms = COALESCE(EXCLUDED.response_latency_ms, sofia_voice_conversation_turns.response_latency_ms),
        should_end_call = EXCLUDED.should_end_call,
        handoff = EXCLUDED.handoff,
        actions = EXCLUDED.actions,
        metadata = COALESCE(sofia_voice_conversation_turns.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING
        id,
        org_id,
        call_id,
        session_id,
        turn_id,
        turn_number,
        turn_kind,
        caller_transcript,
        sofia_response_text,
        response_latency_ms,
        should_end_call,
        handoff,
        actions,
        metadata,
        sensitivity,
        retention_expires_at,
        created_at,
        updated_at
    `;

    return toRow(rows);
  } catch (error) {
    logError('SofiaVoiceConversationTurnsModel', 'Failed to upsert Sofia voice conversation turn', error, {
      orgId: input.orgId,
      callId: input.callId,
      turnNumber: input.turnNumber,
      turnKind: input.turnKind
    });
    throw error;
  }
}
