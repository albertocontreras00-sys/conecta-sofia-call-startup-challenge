import crypto from 'crypto';
import type {
  SofiaComposedResponse,
  SofiaIdentityContext,
  SofiaInteractionEnvelope, SofiaJsonObject,
  SofiaPolicyDecision
} from '../../shared/sofiaWorkflow.ts';
import {
  createSofiaInteractionEvent,
  type SofiaInteractionEventInsert,
  type SofiaSensitivity
} from '../../../models/sofiaInteractionEventsModel.ts';
import {
  completeSofiaSessionTrace,
  startSofiaSessionTrace
} from '../../../models/sofiaSessionTracesModel.ts';
import { logInfo, logWarn } from '../../../utils/logger.js';

export interface SofiaAuditLoggerInput {
  envelope: SofiaInteractionEnvelope;
  identity?: SofiaIdentityContext | null;
  policy?: SofiaPolicyDecision | null;
  response?: SofiaComposedResponse | null;
  eventName?: string;
  occurredAt?: string | Date | null;
}

export type SofiaAuditEventType =
  | 'interaction_started'
  | 'voice_webhook_received'
  | 'voice_ws_connected'
  | 'stt_started'
  | 'stt_final_transcript_received'
  | 'rag_used'
  | 'orchestrator_called'
  | 'policy_checked'
  | 'response_composed'
  | 'tts_started'
  | 'response_sent'
  | 'human_handoff_requested'
  | 'session_completed'
  | 'memory_written'
  | 'memory_write_skipped'
  | 'audit_write_skipped';

export interface SofiaAuditWriteInput {
  envelope: SofiaInteractionEnvelope;
  identity?: SofiaIdentityContext | null;
  eventType: SofiaAuditEventType;
  eventSummary?: string | null;
  metadata?: Record<string, unknown> | null;
  sensitivity?: SofiaSensitivity;
}

export interface SofiaSessionTraceStartInput {
  envelope: SofiaInteractionEnvelope;
  identity?: SofiaIdentityContext | null;
}

export interface SofiaSessionTraceCompleteInput {
  envelope: SofiaInteractionEnvelope;
  identity?: SofiaIdentityContext | null;
  finalStatus?: 'active' | 'completed' | 'failed' | 'handoff' | 'abandoned';
  finalIntent?: string | null;
  humanHandoff?: boolean;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeOccurredAt(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function trimSummary(value: string | null | undefined, maxLength = 1000): string | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeMetadata(input?: Record<string, unknown> | null): SofiaJsonObject {
  const source = input && typeof input === 'object' ? input : {};
  const metadata: SofiaJsonObject = {};
  const allowedStringKeys = [
    'entryPoint',
    'channel',
    'ragScope',
    'policyStatus',
    'provider',
    'model',
    'errorCode',
    'reason',
    'status',
    'callState',
    'audioFormat',
    'sttProvider',
    'ttsProvider',
    'memoryKind',
    'confidence',
    'allowedDisclosureLevel'
  ];

  for (const key of allowedStringKeys) {
    const value = readString(source, key);
    if (value) metadata[key] = trimSummary(value, 120);
  }

  const allowedBooleanKeys = [
    'requiresHumanHandoff',
    'responseComposed',
    'writeSkipped',
    'visitorKnown',
    'leadHandoffCreated',
    'wsConnected'
  ];
  for (const key of allowedBooleanKeys) {
    const value = readBoolean(source, key);
    if (value !== null) metadata[key] = value;
  }

  const allowedNumberKeys = ['matchCount', 'latencyMs', 'contextCount', 'turnNumber'];
  for (const key of allowedNumberKeys) {
    const value = readNumber(source, key);
    if (value !== null) metadata[key] = value;
  }

  if (Array.isArray(source.activeFlags)) {
    metadata.activeFlags = source.activeFlags.filter((flag): flag is string => typeof flag === 'string').slice(0, 8);
  }

  return metadata;
}

function resolveEntryPoint(envelope: SofiaInteractionEnvelope): string {
  const metadataEntryPoint =
    envelope.metadata && typeof envelope.metadata.entryPoint === 'string'
      ? envelope.metadata.entryPoint
      : null;
  return metadataEntryPoint || 'unknown';
}

function resolveActorType(envelope: SofiaInteractionEnvelope, identity?: SofiaIdentityContext | null): string {
  if (envelope.metadata && typeof envelope.metadata.actorType === 'string' && envelope.metadata.actorType.trim()) {
    return envelope.metadata.actorType;
  }

  if (identity?.trustLevel === 'authenticated_user' || identity?.trustLevel === 'user_authenticated') return 'staff';
  if (identity?.contactId || envelope.contactId) return 'contact';
  return 'unknown';
}

function resolveTraceId(envelope: SofiaInteractionEnvelope): string | null {
  return envelope.requestId || envelope.turnId || envelope.interactionId || null;
}

function logDegradedAuditEvent(input: SofiaAuditWriteInput, reason: string, traceId: string | null): void {
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  logInfo('SofiaAuditLogger', 'sofia.audit.degraded_event', {
    orgId: input.envelope.orgId || null,
    traceId,
    callId: input.envelope.interactionId || readString(metadata, 'callId'),
    sessionId: input.envelope.sessionId ?? null,
    turnId: input.envelope.turnId ?? null,
    dialogId: readString(metadata, 'dialogId') || input.envelope.sessionId || null,
    eventType: input.eventType,
    entryPoint: resolveEntryPoint(input.envelope),
    channel: input.envelope.channel,
    status: 'degraded',
    reason
  });
}

async function writeSkippedAuditEvent(input: SofiaAuditWriteInput, reason: string): Promise<void> {
  const traceId = resolveTraceId(input.envelope);
  if (!traceId) return;

  try {
    const skippedEvent: SofiaInteractionEventInsert = {
      id: crypto.randomUUID(),
      orgId: input.envelope.orgId,
      traceId,
      sessionId: input.envelope.sessionId ?? null,
      entryPoint: resolveEntryPoint(input.envelope),
      channel: input.envelope.channel,
      actorType: resolveActorType(input.envelope, input.identity),
      contactId: input.identity?.contactId ?? input.envelope.contactId ?? null,
      userId: input.identity?.userId ?? input.envelope.userId ?? null,
      eventType: 'audit_write_skipped',
      eventSummary: trimSummary(reason, 240),
      metadata: safeMetadata({
        entryPoint: resolveEntryPoint(input.envelope),
        reason,
        writeSkipped: true
      }),
      sensitivity: 'low'
    };

    await createSofiaInteractionEvent(skippedEvent);
  } catch (error) {
    logWarn('SofiaAuditLogger', 'Audit skip logging failed', {
      orgId: input.envelope.orgId,
      reason,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function createSofiaAuditEvent(input: SofiaAuditLoggerInput) {
  return {
    eventName: input.eventName || 'sofia.workflow.turn_completed',
    orgId: input.envelope.orgId,
    channel: input.envelope.channel,
    occurredAt: normalizeOccurredAt(input.occurredAt),
    requestId: input.envelope.requestId ?? null,
    sessionId: input.envelope.sessionId ?? null,
    turnId: input.envelope.turnId ?? null,
    actorId: input.identity?.userId ?? input.identity?.contactId ?? null,
    identityTrustLevel: input.identity?.trustLevel ?? null,
    policyStatus: input.policy?.status ?? null,
    metadata: {
      logger: 'sofia_audit_logger',
      responseComposed: Boolean(input.response)
    }
  };
}

export async function createSofiaWorkflowAuditEvent(input: SofiaAuditWriteInput): Promise<void> {
  const traceId = resolveTraceId(input.envelope);
  if (!input.envelope.orgId || !traceId) {
    logDegradedAuditEvent(input, 'missing_org_or_trace', traceId);
    logWarn('SofiaAuditLogger', 'Skipping Sofia audit write due to missing org or trace', {
      orgId: input.envelope.orgId || null,
      traceId: traceId || null,
      eventType: input.eventType
    });
    return;
  }

  try {
    await createSofiaInteractionEvent({
      id: crypto.randomUUID(),
      orgId: input.envelope.orgId,
      traceId,
      sessionId: input.envelope.sessionId ?? null,
      entryPoint: resolveEntryPoint(input.envelope),
      channel: input.envelope.channel,
      actorType: resolveActorType(input.envelope, input.identity),
      contactId: input.identity?.contactId ?? input.envelope.contactId ?? null,
      userId: input.identity?.userId ?? input.envelope.userId ?? null,
      eventType: input.eventType,
      eventSummary: trimSummary(input.eventSummary),
      metadata: safeMetadata(input.metadata),
      sensitivity: input.sensitivity ?? 'low'
    });
  } catch (error) {
    logWarn('SofiaAuditLogger', 'Failed to write Sofia interaction event', {
      orgId: input.envelope.orgId,
      traceId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error)
    });
    await writeSkippedAuditEvent(input, 'audit_insert_failed');
  }
}

export async function startSofiaWorkflowSessionTrace(input: SofiaSessionTraceStartInput): Promise<void> {
  const traceId = resolveTraceId(input.envelope);
  if (!input.envelope.orgId || !traceId) {
    return;
  }

  try {
    await startSofiaSessionTrace({
      id: crypto.randomUUID(),
      orgId: input.envelope.orgId,
      traceId,
      sessionId: input.envelope.sessionId || traceId,
      entryPoint: resolveEntryPoint(input.envelope),
      channel: input.envelope.channel,
      actorType: resolveActorType(input.envelope, input.identity),
      contactId: input.identity?.contactId ?? input.envelope.contactId ?? null,
      userId: input.identity?.userId ?? input.envelope.userId ?? null,
      metadata: safeMetadata({
        entryPoint: resolveEntryPoint(input.envelope)
      })
    });
  } catch (error) {
    logWarn('SofiaAuditLogger', 'Failed to start Sofia session trace', {
      orgId: input.envelope.orgId,
      traceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function completeSofiaWorkflowSessionTrace(input: SofiaSessionTraceCompleteInput): Promise<void> {
  const traceId = resolveTraceId(input.envelope);
  if (!input.envelope.orgId || !traceId) {
    return;
  }

  try {
    await completeSofiaSessionTrace({
      id: crypto.randomUUID(),
      orgId: input.envelope.orgId,
      traceId,
      sessionId: input.envelope.sessionId || traceId,
      entryPoint: resolveEntryPoint(input.envelope),
      channel: input.envelope.channel,
      actorType: resolveActorType(input.envelope, input.identity),
      contactId: input.identity?.contactId ?? input.envelope.contactId ?? null,
      userId: input.identity?.userId ?? input.envelope.userId ?? null,
      finalStatus: input.finalStatus ?? 'completed',
      finalIntent: input.finalIntent ?? null,
      humanHandoff: input.humanHandoff ?? false,
      summary: trimSummary(input.summary, 2000),
      metadata: safeMetadata(input.metadata)
    });
  } catch (error) {
    logWarn('SofiaAuditLogger', 'Failed to complete Sofia session trace', {
      orgId: input.envelope.orgId,
      traceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
