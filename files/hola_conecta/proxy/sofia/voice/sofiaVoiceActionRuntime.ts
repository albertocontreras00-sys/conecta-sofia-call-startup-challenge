import { logInfo } from '../../utils/logger.js';
import type { JsonRecord, SofiaPendingActionState, VoiceSession } from '../../services/voice/voiceSessionTypes.ts';

const LOG_CONTEXT = 'sofiaVoiceActionRuntime';
const DEFAULT_PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export type SofiaVoiceActionHandler = (input: {
  session: VoiceSession;
  pendingAction: SofiaPendingActionState;
}) => Promise<{ status: 'succeeded' | 'failed'; reason?: string | null; metadata?: JsonRecord }>;

export type SofiaVoiceActionRegistry = Map<string, SofiaVoiceActionHandler>;

function validRequiredValue(value: string | null | undefined): boolean {
  const normalized = String(value ?? '').trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (['undefined', 'null', 'default', '888', '444', '333', '222', '111-222-3333'].includes(lower)) return false;
  if (lower.startsWith('$context.variables.')) return false;
  return true;
}

export function createPendingSofiaVoiceAction(input: {
  actionType: string;
  session: Pick<VoiceSession, 'orgId' | 'sessionId' | 'callId' | 'dialogId'>;
  turnId: string;
  selectedTargetPresent: boolean;
  now?: Date;
}): SofiaPendingActionState {
  if (!validRequiredValue(input.actionType)) throw new Error('actionType is required');
  if (!validRequiredValue(input.session.orgId)) throw new Error('orgId is required');
  if (!validRequiredValue(input.session.sessionId)) throw new Error('sessionId is required');
  if (!validRequiredValue(input.session.callId)) throw new Error('callId is required');
  if (!validRequiredValue(input.turnId)) throw new Error('turnId is required');

  const now = input.now || new Date();
  return {
    actionType: input.actionType,
    orgId: input.session.orgId,
    sessionId: input.session.sessionId,
    callId: input.session.callId,
    turnId: input.turnId,
    dialogId: input.session.dialogId || null,
    pendingState: 'awaiting_confirmation',
    selectedTargetPresent: input.selectedTargetPresent,
    confirmationRequired: true,
    expiresAt: new Date(now.getTime() + DEFAULT_PENDING_ACTION_TTL_MS).toISOString(),
    status: 'pending',
    reason: null
  };
}

export function cancelPendingSofiaVoiceAction(
  state: SofiaPendingActionState | null,
  reason = 'caller_cancelled'
): SofiaPendingActionState | null {
  if (!state) return null;
  return {
    ...state,
    status: 'cancelled',
    reason
  };
}

export async function executeConfirmedSofiaVoiceAction(input: {
  session: VoiceSession;
  registry: SofiaVoiceActionRegistry;
  confirmationDetected: boolean;
  now?: Date;
}): Promise<{ executed: boolean; status: SofiaPendingActionState['status']; reason: string | null }> {
  const pendingAction = input.session.sofiaState.pendingAction;
  if (!pendingAction) return { executed: false, status: 'blocked', reason: 'pending_action_missing' };
  if (!input.confirmationDetected) return { executed: false, status: 'blocked', reason: 'confirmation_missing' };
  if (Date.parse(pendingAction.expiresAt) <= (input.now || new Date()).getTime()) {
    input.session.sofiaState.pendingAction = {
      ...pendingAction,
      status: 'expired',
      reason: 'pending_action_expired'
    };
    return { executed: false, status: 'expired', reason: 'pending_action_expired' };
  }
  if (pendingAction.orgId !== input.session.orgId || pendingAction.sessionId !== input.session.sessionId) {
    return { executed: false, status: 'blocked', reason: 'trusted_context_mismatch' };
  }

  const handler = input.registry.get(pendingAction.actionType);
  if (!handler) return { executed: false, status: 'blocked', reason: 'unknown_action_type' };

  const startedAt = Date.now();
  logInfo(LOG_CONTEXT, 'voice.action_runtime.execute.started', {
    orgId: input.session.orgId,
    sessionId: input.session.sessionId,
    callId: input.session.callId,
    turnId: pendingAction.turnId,
    dialogId: input.session.dialogId,
    actionType: pendingAction.actionType,
    pendingActionPresent: true,
    confirmationDetected: true,
    status: 'started'
  });
  const result = await handler({ session: input.session, pendingAction });
  input.session.sofiaState.pendingAction = null;
  logInfo(LOG_CONTEXT, 'voice.action_runtime.execute.completed', {
    orgId: input.session.orgId,
    sessionId: input.session.sessionId,
    callId: input.session.callId,
    turnId: pendingAction.turnId,
    dialogId: input.session.dialogId,
    actionType: pendingAction.actionType,
    status: result.status,
    durationMs: Date.now() - startedAt,
    reason: result.reason || null
  });
  return { executed: result.status === 'succeeded', status: 'executed', reason: result.reason || null };
}
