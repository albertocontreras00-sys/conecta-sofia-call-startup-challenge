import admin from '../../firebase.js';
import { getFirestore, type DocumentData, type WriteResult } from 'firebase-admin/firestore';
import { logInfo } from '../../utils/logger.js';
import type { PhoneCallLogRow } from '../../models/phoneOutboundCallLogModel.ts';
import type { PhoneCallSessionRow } from '../../models/phoneCallModel.ts';
import type { JsonObject, JsonValue } from '../../types/json.ts';
import type { VoiceSession } from '../voice/voiceSessionTypes.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
} from './phoneJsonContract.ts';
import { logPhoneJsonHandoff, phoneJsonHandoffIdsFromSession } from './phoneJsonHandoffLogger.ts';
import { withFirestoreTransientRetry } from '../firestore/firestoreTransientRetry.ts';

const LOG_CONTEXT = 'phoneLiveStateService';
const PHONE_LIVE_CALL_SCHEMA_VERSION = 1;
export const PHONE_LIVE_CALL_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const PHONE_LIVE_CALL_COLLECTION_ID = 'phoneLiveCalls';
const PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE = 'accounts/{orgId}/phoneLiveCalls/{callId}';

export type PhoneLiveCallProjectionStatus =
  | 'ringing'
  | 'active'
  | 'transferring'
  | 'held'
  | 'ending'
  | 'ended'
  | 'failed';

export type PhoneLiveCallProjectionSource = 'infobip' | 'sofia' | 'browser_webrtc' | 'internal_extension';

export type PhoneLiveCallSofiaStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'booking'
  | 'transferring'
  | 'needs_human'
  | 'error';

export type PhoneLiveCallSafeAction = 'booking' | 'transfer' | 'lookup' | 'handoff' | 'none';
export type PhoneLiveCallProjectionEventType =
  | 'infobip_inbound_webhook'
  | 'infobip_provider_lifecycle'
  | 'outbound_call_created'
  | 'outbound_call_failed'
  | 'outbound_call_hangup'
  | 'sofia_runtime_milestone'
  | 'sofia_finalization'
  | 'terminal_call_cleanup';
export type PhoneLiveCallProjectionWriteAction = 'create' | 'update' | 'end' | 'fail' | 'cleanup' | 'noop';

export interface PhoneLiveCallProjectionInput {
  orgId: string;
  callId: string;
  providerCallId?: string | null;
  sessionId?: string | null;
  direction: 'inbound' | 'outbound' | 'internal';
  status: PhoneLiveCallProjectionStatus;
  source: PhoneLiveCallProjectionSource;
  callerPhone?: string | null;
  callerDisplay?: string | null;
  calleePhone?: string | null;
  targetDisplay?: string | null;
  assignedUserId?: string | null;
  assignedFirebaseUid?: string | null;
  transferIntentId?: string | null;
  transferStatus?: string | null;
  callerExtension?: string | null;
  targetExtension?: string | null;
  targetUserId?: string | null;
  sofiaStatus?: PhoneLiveCallSofiaStatus | null;
  currentSafeAction?: PhoneLiveCallSafeAction | null;
  language?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  endedAt?: string | null;
  lastProviderEventAt?: string | null;
  lastSafeEventAt?: string | null;
  projectionEventType: PhoneLiveCallProjectionEventType;
  writeAction?: PhoneLiveCallProjectionWriteAction | undefined;
  correlationIds?: {
    infobipCallId?: string | null;
    sessionId?: string | null;
    transferIntentId?: string | null;
    phoneCallLogId?: string | null;
    phoneCallSessionId?: string | null;
  };
}

type FirestoreData = Record<string, JsonValue | undefined>;

interface CleanupDocumentSnapshotLike {
  id: string;
  exists: boolean;
  data(): DocumentData | FirestoreData | undefined;
  ref: {
    delete(): Promise<WriteResult | void>;
  };
}

interface CleanupQuerySnapshotLike {
  docs: CleanupDocumentSnapshotLike[];
  size: number;
}

interface CleanupQueryLike {
  where(fieldPath: string, opStr: '<=', value: number): CleanupQueryLike;
  limit(limit: number): CleanupQueryLike;
  get(): Promise<CleanupQuerySnapshotLike>;
}

interface CleanupFirestoreLike {
  collectionGroup(collectionId: string): CleanupQueryLike;
}

function firestoreAvailable(): boolean {
  return typeof admin?.firestore === 'function';
}

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const last4 = digits.slice(-4);
  return last4 ? `••••${last4}` : null;
}

function sanitizeDisplayValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^••••\d{4}$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z][A-Za-z\s-]{0,38}$/.test(trimmed) && [
    'Unknown caller',
    'Unknown recipient',
    'Sofia',
    'Browser phone',
    'Team member',
    'Office phone',
  ].includes(trimmed)) {
    return trimmed;
  }
  return null;
}

function terminalStatus(status: PhoneLiveCallProjectionStatus): boolean {
  return status === 'ended' || status === 'failed';
}

function phoneCallLogStatusToProjection(status: string): PhoneLiveCallProjectionStatus {
  if (status === 'initiated' || status === 'submitted' || status === 'ringing') return 'ringing';
  if (status === 'answered') return 'active';
  if (status === 'completed' || status === 'canceled') return 'ended';
  if (status === 'failed' || status === 'no_answer' || status === 'busy') return 'failed';
  return 'active';
}

function sofiaStatusFromSession(session: VoiceSession): PhoneLiveCallSofiaStatus {
  if (session.sofiaReceptionist.escalationReasons.length > 0) return 'needs_human';
  if (session.sofiaState.booking.intent === 'book_appointment' || session.sofiaState.booking.bookingId) return 'booking';
  if (session.status === 'thinking') return 'thinking';
  if (session.status === 'speaking') return 'speaking';
  if (session.status === 'failed') return 'error';
  if (session.status === 'listening' || session.status === 'initializing') return 'listening';
  return 'idle';
}

function currentSafeActionFromSession(session: VoiceSession): PhoneLiveCallSafeAction {
  if (session.sofiaState.booking.intent === 'book_appointment' || session.sofiaState.booking.bookingId) return 'booking';
  if (session.sofiaReceptionist.escalationReasons.length > 0 || session.sofiaReceptionist.escalationReasons.includes('callback_request')) return 'handoff';
  return 'none';
}

function logProjectionEvent(eventName: string, input: {
  orgId: string | null;
  callId: string;
  status: 'initiated' | 'completed' | 'failed';
  receiver: string;
  metadata?: JsonObject;
}): void {
  logPhoneJsonEvent(eventName, buildPhoneJsonEnvelope({
    eventType: eventName.replace(/^voice\.json\./, ''),
    orgId: input.orgId,
    call: {
      provider_call_id: input.callId,
      status: input.status,
    },
    actor: { type: 'system' },
    source: {
      sender: 'phone_live_state_service',
      converter: 'phoneLiveStateService.publishPhoneLiveCallProjection',
      receiver: input.receiver,
      transport: 'internal_service',
      provider_event_type: null,
      provider_payload_shape: 'internal',
    },
    metadata: input.metadata || {},
  }));
}

function projectionPath(orgId: string, callId: string): string {
  return `accounts/${orgId}/${PHONE_LIVE_CALL_COLLECTION_ID}/${callId}`;
}

function terminalExpiresAt(endedAt: string | null): string | null {
  if (!endedAt) return null;
  const endedAtMillis = toMillis(endedAt);
  if (!endedAtMillis) return null;
  return new Date(endedAtMillis + PHONE_LIVE_CALL_TERMINAL_RETENTION_MS).toISOString();
}

function projectionWriteAction(input: PhoneLiveCallProjectionInput): PhoneLiveCallProjectionWriteAction {
  if (input.writeAction) return input.writeAction;
  if (input.status === 'failed') return 'fail';
  if (input.status === 'ended') return 'end';
  return 'update';
}

function projectionDoc(input: PhoneLiveCallProjectionInput): JsonObject {
  const updatedAt = input.updatedAt || nowIso();
  const startedAt = input.startedAt || updatedAt;
  const endedAt = input.endedAt || (terminalStatus(input.status) ? updatedAt : null);
  const expiresAt = terminalStatus(input.status) ? terminalExpiresAt(endedAt) : null;
  const lastSafeEventAt = input.lastSafeEventAt || updatedAt;
  const correlationIds = {
    infobipCallId: input.correlationIds?.infobipCallId || null,
    sessionId: input.correlationIds?.sessionId || input.sessionId || null,
    transferIntentId: input.correlationIds?.transferIntentId || input.transferIntentId || null,
    phoneCallLogId: input.correlationIds?.phoneCallLogId || null,
    phoneCallSessionId: input.correlationIds?.phoneCallSessionId || null,
  };

  return {
    orgId: input.orgId,
    callId: input.callId,
    providerCallId: input.providerCallId || null,
    sessionId: input.sessionId || null,
    direction: input.direction,
    status: input.status,
    source: input.source,
    callerPhoneMasked: maskPhone(input.callerPhone),
    callerDisplay: sanitizeDisplayValue(input.callerDisplay),
    calleePhoneMasked: maskPhone(input.calleePhone),
    targetDisplay: sanitizeDisplayValue(input.targetDisplay),
    assignedUserId: input.assignedUserId || null,
    assignedFirebaseUid: input.assignedFirebaseUid || null,
    transferIntentId: input.transferIntentId || null,
    transferStatus: input.transferStatus || null,
    callerExtension: input.callerExtension || null,
    targetExtension: input.targetExtension || null,
    targetUserId: input.targetUserId || null,
    sofiaStatus: input.sofiaStatus || 'idle',
    currentSafeAction: input.currentSafeAction || 'none',
    language: input.language || null,
    startedAt,
    startedAtMillis: toMillis(startedAt),
    updatedAt,
    updatedAtMillis: toMillis(updatedAt),
    endedAt,
    endedAtMillis: toMillis(endedAt),
    expiresAt,
    expiresAtMillis: toMillis(expiresAt),
    lastProviderEventAt: input.lastProviderEventAt || null,
    lastProviderEventAtMillis: toMillis(input.lastProviderEventAt),
    lastSafeEventAt,
    lastSafeEventAtMillis: toMillis(lastSafeEventAt),
    correlationIds,
    schema: {
      name: 'phone_live_call_projection',
      version: PHONE_LIVE_CALL_SCHEMA_VERSION,
    },
    storage: {
      source: 'firestore',
      format: 'phone.live_call.projection.v1',
    },
  };
}

function projectionLogMetadata(input: PhoneLiveCallProjectionInput, doc: JsonObject, extra: JsonObject = {}): JsonObject {
  const correlationIds = doc.correlationIds && typeof doc.correlationIds === 'object'
    ? doc.correlationIds as JsonObject
    : {};
  return {
    firestore_path_shape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
    projection_event_type: input.projectionEventType,
    projection_write_action: projectionWriteAction(input),
    live_call_status: input.status,
    source: input.source,
    direction: input.direction,
    providerCallId: input.providerCallId || null,
    sessionId: input.sessionId || null,
    phoneCallLogId: correlationIds.phoneCallLogId || null,
    phoneCallSessionId: correlationIds.phoneCallSessionId || null,
    transferIntentId: correlationIds.transferIntentId || null,
    expiresAt: doc.expiresAt || null,
    sensitive_fields_excluded: [
      'raw_phone_numbers',
      'raw_transcripts',
      'prompt_text',
      'raw_audio',
      'recording_urls',
      'caller_content',
      'sensitive_caller_identity',
    ],
    ...extra,
  };
}

function stableProjectionJson(doc: FirestoreData): string {
  return JSON.stringify(sortJsonValue(doc));
}

function hasSameProjection(existing: FirestoreData | undefined, next: JsonObject): boolean {
  if (!existing) return false;
  return stableProjectionJson(existing) === stableProjectionJson(next);
}

function sortJsonValue(value: JsonValue | FirestoreData): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === 'object') {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as FirestoreData)[key];
      sorted[key] = child === undefined ? null : sortJsonValue(child);
    }
    return sorted;
  }
  return value as JsonValue;
}

export async function publishPhoneLiveCallProjection(input: PhoneLiveCallProjectionInput): Promise<{ published: boolean; path: string | null }> {
  if (!firestoreAvailable()) {
    logInfo(LOG_CONTEXT, 'phone.live_state.firestore_unavailable', {
      orgId: input.orgId,
      callId: input.callId,
      projectionEventType: input.projectionEventType,
      writeAction: projectionWriteAction(input),
      reason: 'firebase_admin_firestore_helper_not_available',
    });
    logProjectionEvent('voice.json.phone_live_call_projection.firestore_unavailable', {
      orgId: input.orgId,
      callId: input.callId,
      status: 'failed',
      receiver: 'firebase_admin_firestore',
      metadata: {
        reason: 'firebase_admin_firestore_helper_not_available',
        projection_event_type: input.projectionEventType,
        projection_write_action: projectionWriteAction(input),
      },
    });
    return { published: false, path: null };
  }

  const path = projectionPath(input.orgId, input.callId);
  const doc = projectionDoc(input);
  try {
    const docRef = getFirestore().doc(path);
    const existing = await docRef.get();
    if (existing.exists && hasSameProjection(existing.data() as FirestoreData | undefined, doc)) {
      logProjectionEvent('voice.json.phone_live_call_projection.noop', {
        orgId: input.orgId,
        callId: input.callId,
        status: 'completed',
        receiver: 'firestore_phone_live_call_projection',
        metadata: projectionLogMetadata(input, doc, {
          projection_write_action: 'noop',
          cleanupReason: null,
        }),
      });
      return { published: true, path };
    }
    await withFirestoreTransientRetry({
      operationName: 'phone_live_call.publish_projection',
      pathShape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
      orgId: input.orgId,
      userId: input.assignedUserId || input.targetUserId || null,
      metadata: {
        firestore_operation: 'set_merge',
        projection: 'phone_live_call',
        projectionEventType: input.projectionEventType,
        projectionWriteAction: projectionWriteAction(input),
        providerCallId: input.providerCallId || null,
        transferIntentId: input.transferIntentId || null,
      },
    }, () => docRef.set(doc, { merge: true }));
    logProjectionEvent('voice.json.phone_live_call_projection.published', {
      orgId: input.orgId,
      callId: input.callId,
      status: 'completed',
      receiver: 'firestore_phone_live_call_projection',
      metadata: projectionLogMetadata(input, doc),
    });
    return { published: true, path };
  } catch (error) {
    logProjectionEvent('voice.json.phone_live_call_projection.failed', {
      orgId: input.orgId,
      callId: input.callId,
      status: 'failed',
      receiver: 'firestore_phone_live_call_projection',
      metadata: {
        error_message: error instanceof Error ? error.message : String(error),
        ...projectionLogMetadata(input, doc, {
          projection_write_action: 'fail',
        }),
      },
    });
    return { published: false, path };
  }
}

export async function publishPhoneLiveCallFromCallLog(input: {
  row: PhoneCallLogRow;
  source: PhoneLiveCallProjectionSource;
  projectionEventType: PhoneLiveCallProjectionEventType;
  writeAction?: PhoneLiveCallProjectionWriteAction;
  lastProviderEventAt?: string | null;
  transferIntentId?: string | null;
  transferStatus?: string | null;
}): Promise<{ published: boolean; path: string | null }> {
  const status = phoneCallLogStatusToProjection(input.row.status);
  const providerCallId = input.row.provider_call_id || input.row.parent_call_id || input.row.provider_message_id || input.row.id;
  const metadata = input.row.raw_provider_response && typeof input.row.raw_provider_response === 'object' && !Array.isArray(input.row.raw_provider_response)
    ? input.row.raw_provider_response as JsonObject
    : {};
  const callerExtension = typeof metadata.caller_extension === 'string' ? metadata.caller_extension : null;
  const targetExtension = typeof metadata.target_extension === 'string' ? metadata.target_extension : null;
  const targetUserId = typeof metadata.target_user_id === 'string' ? metadata.target_user_id : null;
  return publishPhoneLiveCallProjection({
    orgId: input.row.org_id,
    callId: providerCallId,
    providerCallId: input.row.provider_call_id,
    direction: input.row.direction === 'internal' ? 'internal' : input.row.direction === 'inbound' ? 'inbound' : 'outbound',
    status,
    source: input.source,
    callerPhone: input.row.direction === 'internal' ? null : input.row.from_number,
    calleePhone: input.row.direction === 'internal' ? null : input.row.destination_b,
    callerDisplay: input.row.direction === 'internal' ? 'Team member' : null,
    targetDisplay: input.row.direction === 'internal' ? 'Team member' : null,
    assignedUserId: input.row.user_id,
    targetUserId,
    callerExtension,
    targetExtension,
    transferIntentId: input.transferIntentId || null,
    transferStatus: input.transferStatus || null,
    startedAt: input.row.created_at,
    updatedAt: input.row.updated_at,
    endedAt: terminalStatus(status) ? input.row.updated_at : null,
    lastProviderEventAt: input.lastProviderEventAt || null,
    lastSafeEventAt: input.row.updated_at,
    projectionEventType: input.projectionEventType,
    writeAction: input.writeAction,
    correlationIds: {
      infobipCallId: input.row.provider_call_id || input.row.parent_call_id || null,
      phoneCallLogId: input.row.id,
      transferIntentId: input.transferIntentId || null,
    },
  });
}

export async function publishSofiaLiveCallState(input: {
  session: VoiceSession;
  status?: PhoneLiveCallProjectionStatus;
  sofiaStatus?: PhoneLiveCallSofiaStatus;
  currentSafeAction?: PhoneLiveCallSafeAction;
  lastSafeEventAt?: string | null;
  phoneCallSessionId?: string | null;
  projectionEventType?: PhoneLiveCallProjectionEventType;
  writeAction?: PhoneLiveCallProjectionWriteAction;
}): Promise<{ published: boolean; path: string | null }> {
  return publishPhoneLiveCallProjection({
    orgId: input.session.orgId,
    callId: input.session.callId,
    providerCallId: input.session.callId,
    sessionId: input.session.sessionId,
    direction: 'inbound',
    status: input.status || (input.session.status === 'closing' || input.session.status === 'closed' ? 'ending' : 'active'),
    source: 'sofia',
    callerPhone: input.session.fromPhone,
    calleePhone: input.session.toPhone,
    sofiaStatus: input.sofiaStatus || sofiaStatusFromSession(input.session),
    currentSafeAction: input.currentSafeAction || currentSafeActionFromSession(input.session),
    language: input.session.languageState.responseLanguage,
    startedAt: new Date(input.session.startedAt).toISOString(),
    updatedAt: input.lastSafeEventAt || nowIso(),
    endedAt: input.status === 'ended' || input.status === 'failed' ? input.lastSafeEventAt || nowIso() : null,
    lastSafeEventAt: input.lastSafeEventAt || nowIso(),
    projectionEventType: input.projectionEventType || 'sofia_runtime_milestone',
    writeAction: input.writeAction,
    correlationIds: {
      infobipCallId: input.session.callId,
      sessionId: input.session.sessionId,
      phoneCallSessionId: input.phoneCallSessionId || null,
    },
  });
}

export async function closePhoneLiveState(input: {
  session: VoiceSession;
  outcome: string;
  closeReason: string;
  endedAt: string;
  phoneCallSession?: PhoneCallSessionRow | null;
}): Promise<{ closed: boolean; path: string | null }> {
  const json = {
    orgId: input.session.orgId,
    providerCallId: input.session.callId,
    runtimeSessionId: input.session.sessionId,
    phoneCallSessionId: input.phoneCallSession?.id || null,
    outcome: input.outcome,
    closeReason: input.closeReason,
    endedAt: input.endedAt,
  };
  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.live_state_close',
    sender: 'sofia_phone_call_finalizer',
    converter: 'phone_live_state_service',
    receiver: 'firestore_active_call_state',
    direction: 'sender_to_receiver',
    stage: 'live_state_close_started',
    status: 'started',
    ids: phoneJsonHandoffIdsFromSession(input.session, input.phoneCallSession?.id || null),
    json,
  });

  const result = await publishPhoneLiveCallProjection({
    orgId: input.session.orgId,
    callId: input.session.callId,
    providerCallId: input.session.callId,
    sessionId: input.session.sessionId,
    direction: 'inbound',
    status: input.outcome === 'failed_call' || input.outcome === 'system_error' ? 'failed' : 'ended',
    source: 'sofia',
    callerPhone: input.session.fromPhone,
    calleePhone: input.session.toPhone,
    sofiaStatus: input.outcome === 'failed_call' || input.outcome === 'system_error' ? 'error' : 'idle',
    currentSafeAction: currentSafeActionFromSession(input.session),
    language: input.session.languageState.responseLanguage,
    startedAt: new Date(input.session.startedAt).toISOString(),
    updatedAt: input.endedAt,
    endedAt: input.endedAt,
    lastSafeEventAt: input.endedAt,
    projectionEventType: 'sofia_finalization',
    writeAction: input.outcome === 'failed_call' || input.outcome === 'system_error' ? 'fail' : 'end',
    correlationIds: {
      infobipCallId: input.session.callId,
      sessionId: input.session.sessionId,
      phoneCallSessionId: input.phoneCallSession?.id || null,
    },
  });

  logPhoneJsonHandoff({
    event: 'voice.json.phone_finalizer.live_state_close',
    sender: 'phone_live_state_service',
    converter: 'firestore_document_set',
    receiver: 'sofia_phone_call_finalizer',
    direction: 'receiver_response',
    stage: result.published ? 'live_state_close_completed' : 'live_state_close_skipped',
    status: result.published ? 'completed' : 'rejected',
    ids: phoneJsonHandoffIdsFromSession(input.session, input.phoneCallSession?.id || null),
    json: {
      ...json,
      closed: result.published,
      path: result.path,
    },
    reason: result.published ? null : 'firebase_admin_firestore_helper_not_available',
  });

  return { closed: result.published, path: result.path };
}

function isExpiredTerminalProjection(doc: FirestoreData, nowMillis: number): boolean {
  const status = typeof doc.status === 'string' ? doc.status : null;
  if (status !== 'ended' && status !== 'failed') return false;
  const endedAtMillis = typeof doc.endedAtMillis === 'number' ? doc.endedAtMillis : null;
  const expiresAtMillis = typeof doc.expiresAtMillis === 'number' ? doc.expiresAtMillis : null;
  if (!endedAtMillis || !expiresAtMillis) return false;
  return expiresAtMillis <= nowMillis;
}

export async function cleanupExpiredTerminalPhoneLiveCalls(input: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<{ deleted: number; skipped: number; inspected: number; errors: number; expiresBefore: string }> {
  const now = input.now || new Date();
  const nowMillis = now.getTime();
  const batchSize = Math.max(1, Math.min(input.batchSize || 100, 500));
  const expiresBefore = now.toISOString();

  if (!firestoreAvailable()) {
    logProjectionEvent('voice.json.phone_live_call_projection.cleanup_unavailable', {
      orgId: null,
      callId: 'phoneLiveCalls',
      status: 'failed',
      receiver: 'firebase_admin_firestore',
      metadata: {
        projection_event_type: 'terminal_call_cleanup',
        projection_write_action: 'cleanup',
        firestore_path_shape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
        cleanupReason: 'firebase_admin_firestore_helper_not_available',
        expiresAt: expiresBefore,
      },
    });
    return { deleted: 0, skipped: 0, inspected: 0, errors: 1, expiresBefore };
  }

  return cleanupExpiredTerminalPhoneLiveCallsWithFirestore(getFirestore() as CleanupFirestoreLike, {
    nowMillis,
    batchSize,
    expiresBefore,
  });
}

async function cleanupExpiredTerminalPhoneLiveCallsWithFirestore(
  firestore: CleanupFirestoreLike,
  input: { nowMillis: number; batchSize: number; expiresBefore: string },
): Promise<{ deleted: number; skipped: number; inspected: number; errors: number; expiresBefore: string }> {
  const snapshot = await firestore
    .collectionGroup(PHONE_LIVE_CALL_COLLECTION_ID)
    .where('expiresAtMillis', '<=', input.nowMillis)
    .limit(input.batchSize)
    .get();

  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for (const docSnapshotCandidate of snapshot.docs) {
    try {
      const data = docSnapshotCandidate.data() as FirestoreData | undefined;
      if (!docSnapshotCandidate.exists || !data || !isExpiredTerminalProjection(data, input.nowMillis)) {
        skipped += 1;
        continue;
      }
      await docSnapshotCandidate.ref.delete();
      deleted += 1;
      logProjectionEvent('voice.json.phone_live_call_projection.cleanup_deleted', {
        orgId: typeof data.orgId === 'string' ? data.orgId : 'unknown',
        callId: typeof data.callId === 'string' ? data.callId : docSnapshotCandidate.id || 'unknown',
        status: 'completed',
        receiver: 'firestore_phone_live_call_projection',
        metadata: {
          projection_event_type: 'terminal_call_cleanup',
          projection_write_action: 'cleanup',
          firestore_path_shape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
          cleanupReason: 'terminal_projection_expired',
          expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
          providerCallId: typeof data.providerCallId === 'string' ? data.providerCallId : null,
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
          phoneCallLogId: typeof data.correlationIds === 'object' && data.correlationIds && !Array.isArray(data.correlationIds)
            ? (data.correlationIds as JsonObject).phoneCallLogId || null
            : null,
          phoneCallSessionId: typeof data.correlationIds === 'object' && data.correlationIds && !Array.isArray(data.correlationIds)
            ? (data.correlationIds as JsonObject).phoneCallSessionId || null
            : null,
          transferIntentId: typeof data.transferIntentId === 'string' ? data.transferIntentId : null,
        },
      });
    } catch (error) {
      errors += 1;
      logProjectionEvent('voice.json.phone_live_call_projection.cleanup_failed', {
        orgId: 'unknown',
        callId: docSnapshotCandidate.id || 'unknown',
        status: 'failed',
        receiver: 'firestore_phone_live_call_projection',
        metadata: {
          projection_event_type: 'terminal_call_cleanup',
          projection_write_action: 'cleanup',
          firestore_path_shape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
          cleanupReason: 'delete_failed',
          error_message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  logProjectionEvent('voice.json.phone_live_call_projection.cleanup_completed', {
    orgId: 'system',
    callId: 'phoneLiveCalls',
    status: errors > 0 ? 'failed' : 'completed',
    receiver: 'firestore_phone_live_call_projection',
    metadata: {
      projection_event_type: 'terminal_call_cleanup',
      projection_write_action: 'cleanup',
      firestore_path_shape: PHONE_LIVE_CALL_COLLECTION_PATH_SHAPE,
      cleanupReason: 'terminal_projection_expiration_scan_completed',
      expiresAt: input.expiresBefore,
      inspected: typeof snapshot.size === 'number' ? snapshot.size : snapshot.docs.length,
      deleted,
      skipped,
      errors,
    },
  });

  return {
    deleted,
    skipped,
    inspected: typeof snapshot.size === 'number' ? snapshot.size : snapshot.docs.length,
    errors,
    expiresBefore: input.expiresBefore,
  };
}

export function __testOnlyPhoneLiveCallProjectionDoc(input: PhoneLiveCallProjectionInput): JsonObject {
  return projectionDoc(input);
}

export function __testOnlyPhoneLiveCallProjectionPath(orgId: string, callId: string): string {
  return projectionPath(orgId, callId);
}

export function __testOnlyPhoneLiveCallShouldCleanup(doc: FirestoreData, nowMillis: number): boolean {
  return isExpiredTerminalProjection(doc, nowMillis);
}

export async function __testOnlyCleanupExpiredTerminalPhoneLiveCallsWithFirestore(
  firestore: CleanupFirestoreLike,
  input: { nowMillis: number; batchSize: number; expiresBefore: string },
) {
  return cleanupExpiredTerminalPhoneLiveCallsWithFirestore(firestore, input);
}
