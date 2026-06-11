import type { SofiaPolicyAction } from './sofiaCorePolicy.ts';
import { SOFIA_POLICY_ACTIONS } from './sofiaCorePolicy.ts';
import type { SofiaCoreInput, SofiaCoreJsonObject, SofiaCoreJsonValue, SofiaRequestedAction } from './types.ts';

const POLICY_ACTION_SET = new Set<string>(SOFIA_POLICY_ACTIONS);

const ACTION_ALIASES: Record<string, SofiaPolicyAction> = {
  send_sms: 'send_sms',
  sendSms: 'send_sms',
  'send-sms': 'send_sms',
  'messaging/send-sms': 'send_sms',
  'messaging.send-sms': 'send_sms',
  'messaging.send_sms': 'send_sms',
  sofia_voice_send_sms: 'send_sms',

  send_email: 'send_email',
  sendEmail: 'send_email',
  'send-email': 'send_email',
  'messaging/send-email': 'send_email',
  'messaging.send-email': 'send_email',
  'messaging.send_email': 'send_email',
  sofia_voice_send_email: 'send_email',

  send_whatsapp: 'send_whatsapp',
  sendWhatsApp: 'send_whatsapp',
  'send-whatsapp': 'send_whatsapp',
  'messaging/send-whatsapp': 'send_whatsapp',
  'messaging.send-whatsapp': 'send_whatsapp',
  'messaging.send_whatsapp': 'send_whatsapp',
  sofia_voice_send_whatsapp: 'send_whatsapp',

  create_booking: 'create_booking',
  createBooking: 'create_booking',
  'create-booking': 'create_booking',
  'appointments/create': 'create_booking',
  'appointments.create': 'create_booking',
  'appointments.create_booking': 'create_booking',
  'booking/create': 'create_booking',
  'booking.create': 'create_booking',

  cancel_booking: 'cancel_booking',
  cancelBooking: 'cancel_booking',
  'cancel-booking': 'cancel_booking',
  'appointments/cancel': 'cancel_booking',
  'appointments.cancel': 'cancel_booking',
  'appointments.cancel_booking': 'cancel_booking',
  'booking/cancel': 'cancel_booking',
  'booking.cancel': 'cancel_booking',

  reschedule_booking: 'reschedule_booking',
  rescheduleBooking: 'reschedule_booking',
  'reschedule-booking': 'reschedule_booking',
  'appointments/reschedule': 'reschedule_booking',
  'appointments.reschedule': 'reschedule_booking',
  'appointments.reschedule_booking': 'reschedule_booking',
  'booking/reschedule': 'reschedule_booking',
  'booking.reschedule': 'reschedule_booking',

  mark_needs_human: 'mark_needs_human',
  markNeedsHuman: 'mark_needs_human',
  'mark-needs-human': 'mark_needs_human',
  needs_human: 'handoff',
  needsHuman: 'handoff',
  human_takeover: 'handoff',
  humanTakeover: 'handoff',
  'messaging/mark-needs-human': 'mark_needs_human',
  'messaging.mark-needs-human': 'mark_needs_human',

  create_task: 'create_task',
  createTask: 'create_task',
  'create-task': 'create_task',
  'tasks/create': 'create_task',
  'tasks.create': 'create_task',

  write_call_summary: 'write_call_summary',
  writeCallSummary: 'write_call_summary',
  'write-call-summary': 'write_call_summary',
  'crm/write-call-summary': 'write_call_summary',
  'crm.write-call-summary': 'write_call_summary',

  verify_caller_pin: 'verify_caller_pin',
  verifyCallerPin: 'verify_caller_pin',
  'verify-caller-pin': 'verify_caller_pin',
  'identity/verify-caller': 'verify_caller_pin',
  'identity.verify-caller': 'verify_caller_pin',

  end_session: 'end_session',
  endSession: 'end_session',
  'end-session': 'end_session',
  shouldEndCall: 'end_session',
  endCall: 'end_session',
  end_call: 'end_session',

  handoff: 'handoff',
  'human-takeover': 'handoff',
  human_takeover_requested: 'handoff'
};

const SAFE_STATUS_SET = new Set<SofiaRequestedAction['status']>([
  'requested',
  'drafted',
  'approved',
  'executed',
  'blocked',
  'cancelled'
]);

function isObject(value: unknown): value is SofiaCoreJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: SofiaCoreJsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeActionName(value: unknown): SofiaPolicyAction | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (POLICY_ACTION_SET.has(trimmed)) return trimmed as SofiaPolicyAction;
  return ACTION_ALIASES[trimmed] ?? null;
}

export function mapToolNameToPolicyAction(toolName: string | null | undefined): SofiaPolicyAction | null {
  return normalizeActionName(toolName);
}

export function mapAssistantActionTypeToPolicyAction(actionType: string | null | undefined): SofiaPolicyAction | null {
  return normalizeActionName(actionType);
}

function readPolicyAction(raw: SofiaCoreJsonObject): SofiaPolicyAction | null {
  return (
    mapAssistantActionTypeToPolicyAction(readString(raw.actionType)) ||
    mapAssistantActionTypeToPolicyAction(readString(raw.action)) ||
    mapAssistantActionTypeToPolicyAction(readString(raw.type)) ||
    mapToolNameToPolicyAction(readString(raw.toolName)) ||
    mapToolNameToPolicyAction(readString(raw.tool_name)) ||
    mapToolNameToPolicyAction(readString(raw.name)) ||
    mapToolNameToPolicyAction(readString(raw.capability))
  );
}

function normalizeStatus(value: SofiaCoreJsonValue | undefined): SofiaRequestedAction['status'] {
  return typeof value === 'string' && SAFE_STATUS_SET.has(value as SofiaRequestedAction['status'])
    ? value as SofiaRequestedAction['status']
    : 'requested';
}

function normalizePayload(value: SofiaCoreJsonValue | undefined): SofiaCoreJsonObject {
  return isObject(value) ? value : {};
}

function readApprovalRequired(value: SofiaCoreJsonValue | undefined): boolean {
  return typeof value === 'boolean' ? value : false;
}

export function normalizeSofiaRequestedAction(raw: unknown): SofiaRequestedAction | null {
  const action = typeof raw === 'string'
    ? normalizeActionName(raw)
    : isObject(raw)
      ? readPolicyAction(raw)
      : null;

  if (!action) return null;

  const rawObject = isObject(raw) ? raw : {};

  return {
    actionType: action,
    status: normalizeStatus(rawObject.status),
    payload: normalizePayload(rawObject.payload),
    approvalRequired: readApprovalRequired(rawObject.approvalRequired),
    idempotencyKey: readString(rawObject.idempotencyKey) || null,
    metadata: {
      source: readString(rawObject.source) || 'sofia_action_intent'
    }
  };
}

export function normalizeSofiaRequestedActions(raw: unknown): SofiaRequestedAction[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const normalized: SofiaRequestedAction[] = [];

  for (const item of values) {
    const action = normalizeSofiaRequestedAction(item);
    if (action) normalized.push(action);
  }

  return normalized;
}

function requestedActionToJson(action: SofiaRequestedAction): SofiaCoreJsonObject {
  return {
    actionType: action.actionType,
    status: action.status,
    payload: action.payload,
    approvalRequired: action.approvalRequired,
    idempotencyKey: action.idempotencyKey,
    metadata: action.metadata
  };
}

export function attachRequestedActionToCoreInput(input: SofiaCoreInput, action: unknown): SofiaCoreInput {
  const requestedAction = normalizeSofiaRequestedAction(action);
  if (!requestedAction) return input;

  return {
    ...input,
    context: {
      ...input.context,
      requestedAction: requestedActionToJson(requestedAction)
    }
  };
}

export function attachRequestedActionsToCoreInput(input: SofiaCoreInput, actions: unknown): SofiaCoreInput {
  const requestedActions = normalizeSofiaRequestedActions(actions);
  if (!requestedActions.length) return input;

  return {
    ...input,
    context: {
      ...input.context,
      requestedActions: requestedActions.map(requestedActionToJson)
    }
  };
}
