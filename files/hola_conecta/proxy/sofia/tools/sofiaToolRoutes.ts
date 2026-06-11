import express, { type NextFunction, type Request, type Response } from 'express';
import bookingService from '../../services/bookings/bookingService.ts';
import * as taskService from '../../services/tasks/taskService.ts';
import * as conversationsService from '../../services/inbox/inboxConversationsService.ts';
import * as contactTimelineService from '../../services/contacts/contactTimelineService.ts';
import { handleContactNotifyOwner } from '../../services/workflow/actions/contactNotifyActions.ts';
import { sendEmailNotification, sendSmsNotification, sendWhatsAppNotification } from '../../services/notifications/notificationHub.js';
import { sql } from '../../db/neon.js';
import { unauthorized, badRequest, error, success } from '../../utils/response.js';
import { logError, logInfo } from '../../utils/logger.js';
import { verifyCallerVoicePin } from '../../services/client/voicePinService.js';
import * as contactModel from '../../models/contact/index.ts';
import {
  buildToolBoundaryPolicyDryRun,
  sanitizeToolBoundaryPolicyMetadata
} from '../services/core/index.ts';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RequestWithOrg = Request & { orgId?: string; requestId?: string };
type SofiaIdentityContact = {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  deleted_at?: unknown;
};

const router = express.Router();

function requireVoiceInternalKey(req: Request, res: Response, next: NextFunction) {
  const providedKey = req.headers['x-voice-internal-key'];
  const expectedKey = process.env.VOICE_INTERNAL_KEY;

  if (!expectedKey || providedKey !== expectedKey) {
    return unauthorized(res, 'Unauthorized');
  }

  return next();
}

function requireOrgId(req: RequestWithOrg, res: Response, next: NextFunction) {
  const orgId =
    req.query?.orgId ||
    req.query?.org_id ||
    req.headers?.['x-org-id'] ||
    req.body?.orgId ||
    req.body?.org_id ||
    req.orgId;

  if (!orgId || typeof orgId !== 'string') {
    return badRequest(res, 'ORG_ID_REQUIRED', 'orgId is required');
  }

  req.orgId = orgId;
  return next();
}

function getOrgId(req: RequestWithOrg): string {
  return String(req.orgId || req.body?.orgId || req.body?.org_id || req.headers['x-org-id'] || '');
}

export function shouldBlockSofiaToolForMissingOrgId(req: RequestWithOrg): boolean {
  return !getOrgId(req).trim();
}

function getErrorStatus(err: unknown): number {
  const candidate = err as { status?: number; statusCode?: number };
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function getErrorCode(err: unknown): string {
  const candidate = err as { code?: string; name?: string };
  return candidate?.code || candidate?.name || (getErrorStatus(err) >= 500 ? 'SOFIA_TOOL_ERROR' : 'SOFIA_TOOL_BAD_REQUEST');
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function handleTool(req: RequestWithOrg, res: Response, operation: string, fn: () => Promise<unknown>) {
  const startedAt = Date.now();
  const baseLog = voiceToolLogMetadata(req, operation);
  try {
    if (shouldBlockSofiaToolForMissingOrgId(req) || !validRequiredToolValue(getOrgId(req))) {
      return badRequest(res, 'ORG_ID_REQUIRED', 'orgId is required');
    }
    logInfo('SofiaToolRoutes', 'voice.tool.request_started', {
      ...baseLog,
      status: 'started'
    });
    logToolBoundaryDryRun(req, operation);
    const data = await fn();
    logInfo('SofiaToolRoutes', 'voice.tool.request_succeeded', {
      ...baseLog,
      status: 'succeeded',
      durationMs: Date.now() - startedAt
    });
    return success(res, { data });
  } catch (err) {
    logInfo('SofiaToolRoutes', 'voice.tool.request_failed', {
      ...baseLog,
      status: 'failed',
      reason: getErrorCode(err),
      durationMs: Date.now() - startedAt
    });
    logError('SofiaToolRoutes', `Failed Sofia tool operation: ${operation}`, err, {
      orgId: getOrgId(req),
      operation
    });
    return error(res, getErrorCode(err), getErrorMessage(err, 'Sofia tool operation failed'), getErrorStatus(err));
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function logToolBoundaryDryRun(req: RequestWithOrg, operation: string): void {
  const payload = bodyObject(req);
  const sessionId = stringValue(payload.sessionId) || stringValue(payload.session_id);
  const turnId = stringValue(payload.turnId) || stringValue(payload.turn_id);
  const callId = stringValue(payload.callId) || stringValue(payload.call_id);
  const requestId = stringValue(payload.requestId) || stringValue(payload.request_id) || req.requestId || null;
  const idempotencyKey = stringValue(payload.idempotencyKey) || stringValue(payload.idempotency_key);
  const resourceId =
    stringValue(payload.id) ||
    stringValue(payload.bookingId) ||
    stringValue(payload.booking_id) ||
    stringValue(payload.taskId) ||
    stringValue(payload.task_id) ||
    null;
  const contactId =
    stringValue(payload.contactId) ||
    stringValue(payload.contact_id) ||
    stringValue(payload.toContactId) ||
    stringValue(payload.to_contact_id) ||
    null;
  const decision = buildToolBoundaryPolicyDryRun({
    routeNameOrPath: operation,
    orgId: getOrgId(req),
    channel: 'voice',
    actorType: 'caller',
    trustLevel: 'channel',
    verifiedFactors: [],
    contactId,
    resourceId,
    sessionId,
    turnId,
    requestId,
    callId,
    idempotencyKey,
    source: 'sofia_tool_route'
  });

  if (!decision) return;

  void logInfo(
    'SofiaToolRoutes',
    'sofia_tool_boundary_policy_dry_run',
    sanitizeToolBoundaryPolicyMetadata(decision, operation, {
      entryPoint: 'api_sofia_tools',
      sessionId,
      turnId,
      requestId,
      callId,
      idempotencyKey,
      routeAction: operation,
      resourceId,
      contactId
    })
  );
}

function bodyObject(req: Request): Record<string, JsonValue> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function queryValue(req: Request, key: string): JsonValue | undefined {
  const value = req.query?.[key];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function requestString(req: Request, keys: string[]): string | null {
  const payload = bodyObject(req);
  for (const key of keys) {
    const value = payload[key] ?? queryValue(req, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function validRequiredToolValue(value: string | null): value is string {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== 'default' && !normalized.startsWith('$context.variables.');
}

function voiceToolLogMetadata(req: RequestWithOrg, operation: string) {
  return {
    orgId: getOrgId(req),
    callId: requestString(req, ['callId', 'call_id']),
    sessionId: requestString(req, ['sessionId', 'session_id']),
    turnId: requestString(req, ['turnId', 'turn_id']),
    dialogId: requestString(req, ['dialogId', 'dialog_id']),
    toolName: operation
  };
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireSent(result: { status?: string; reason?: string | null; error?: string | { message?: string } | null }, label: string) {
  if (result.status !== 'sent') {
    const errorMessage = typeof result.error === 'string' ? result.error : result.error?.message;
    const err = new Error(result.reason || errorMessage || `${label} was not sent`) as Error & { status?: number; code?: string };
    err.status = 502;
    err.code = 'DELIVERY_FAILED';
    throw err;
  }
}

function requireApprovedMessagingAction(payload: Record<string, JsonValue>, label: string): void {
  if (payload.approved === true) return;
  const err = new Error(`${label} requires explicit approved=true before sending`) as Error & { status?: number; code?: string };
  err.status = 409;
  err.code = 'SOFIA_MESSAGING_APPROVAL_REQUIRED';
  throw err;
}

function bodyValue(req: Request, keys: string[]): JsonValue | undefined {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, JsonValue | undefined>
    : {};
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function providedInfoValue(req: Request, keys: string[]): JsonValue | undefined {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const providedInfo = body.providedInfo && typeof body.providedInfo === 'object' && !Array.isArray(body.providedInfo)
    ? body.providedInfo as Record<string, JsonValue | undefined>
    : {};
  for (const key of keys) {
    const value = providedInfo[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function resolveCallerPhone(req: Request): string {
  return String(
    bodyValue(req, ['phone', 'callerPhone', 'caller_phone', 'fromPhone', 'from_phone']) ||
    providedInfoValue(req, ['phone', 'callerPhone', 'caller_phone', 'fromPhone', 'from_phone']) ||
    ''
  ).trim();
}

function resolvePin(req: Request): string {
  return String(
    bodyValue(req, ['pin']) ||
    providedInfoValue(req, ['pin']) ||
    ''
  ).trim();
}

function isSecureVoiceAction(actionType: string | null, requestedScope: string | null): boolean {
  const text = `${actionType || ''} ${requestedScope || ''}`.toLowerCase();
  if (!text.trim()) return true;
  if (/\b(general|faq|hours|location|address|services|pricing|appointment|booking|schedule|availability)\b/.test(text)) return false;
  return /\b(document|documents|doc|payment|payments|pay|billing|invoice|invoices|balance|pii|ssn|social|dob|birth|tax|return|refund|bank|routing|account|identity|id)\b/.test(text);
}

function serializeIdentityContact(contact: SofiaIdentityContact) {
  return {
    id: contact.id || null,
    firstName: contact.first_name || null,
    lastName: contact.last_name || null,
    name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.phone || 'Contact',
    phone: contact.phone || null
  };
}

async function resolveSingleActiveContactByPhone(orgId: string, phone: string) {
  const contacts = await contactModel.findContactsByPhone(orgId, phone) as SofiaIdentityContact[];
  const activeContacts = contacts.filter((contact) => !contact.deleted_at);
  if (activeContacts.length > 1) {
    return {
      contact: null,
      ambiguous: true,
      matchCount: activeContacts.length
    };
  }
  return {
    contact: activeContacts[0] || null,
    ambiguous: false,
    matchCount: activeContacts.length
  };
}

router.use(requireVoiceInternalKey);
router.use(requireOrgId);

router.post('/appointments/available-slots', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'appointments.available-slots', async () => {
    const orgId = getOrgId(req);
    const { userId, user_id, date, durationMinutes, duration_minutes, duration, eventId, event_id } = bodyObject(req);
    const resolvedUserId = String(userId || user_id || '').trim();
    const resolvedDate = String(date || '').trim();
    const resolvedDuration = Number(durationMinutes || duration_minutes || duration || 0);
    const resolvedEventId = eventId || event_id ? String(eventId || event_id) : null;

    if (!resolvedUserId || !resolvedDate || !Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
      const err = new Error('userId, date, and durationMinutes are required') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_AVAILABLE_SLOTS_REQUEST';
      throw err;
    }

    return bookingService.getAvailableSlots(orgId, resolvedUserId, resolvedDate, resolvedDuration, resolvedEventId);
  })
);

router.post('/tasks/create', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'tasks.create', async () => {
    const orgId = getOrgId(req);
    return taskService.createTask({
      ...bodyObject(req),
      org_id: orgId
    } as Parameters<typeof taskService.createTask>[0], req.requestId || null);
  })
);

router.post('/messaging/send-sms', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'messaging.send-sms', async () => {
    const orgId = getOrgId(req);
    const payload = bodyObject(req);
    requireApprovedMessagingAction(payload, 'sendSms');
    const body = optionalString(payload.body) || optionalString(payload.message);
    const toPhone = optionalString(payload.toPhone) || optionalString(payload.to_phone) || optionalString(payload.phone);
    const toContactId = optionalString(payload.toContactId) || optionalString(payload.to_contact_id) || optionalString(payload.contact_id);
    if (!body || (!toPhone && !toContactId)) {
      const err = new Error('sendSms requires body and either toPhone or toContactId') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_SMS_REQUEST';
      throw err;
    }

    const result = await sendSmsNotification({
      orgId,
      toPhone: toPhone || undefined,
      toContactId: toContactId || null,
      body,
      category: 'SYSTEM',
      source: 'SYSTEM',
      metadata: {
        action: 'sofia_voice_send_sms'
      }
    });
    requireSent(result, 'Sofia SMS');
    return result;
  })
);

router.post('/messaging/send-email', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'messaging.send-email', async () => {
    const orgId = getOrgId(req);
    const payload = bodyObject(req);
    requireApprovedMessagingAction(payload, 'sendEmail');
    const toEmail = optionalString(payload.toEmail) || optionalString(payload.to_email) || optionalString(payload.to);
    const toContactId = optionalString(payload.toContactId) || optionalString(payload.to_contact_id) || optionalString(payload.contact_id);
    const subject = optionalString(payload.subject);
    const body = optionalString(payload.body);
    const text = optionalString(payload.text);
    if (!subject || !body || (!toEmail && !toContactId)) {
      const err = new Error('sendEmail requires subject, body, and either toEmail or toContactId') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_EMAIL_REQUEST';
      throw err;
    }

    const result = await sendEmailNotification({
      orgId,
      toEmail: toEmail || undefined,
      toContactId: toContactId || null,
      subject,
      body,
      text: text || undefined,
      category: 'SYSTEM',
      source: 'SYSTEM',
      metadata: {
        action: 'sofia_voice_send_email'
      }
    });
    requireSent(result, 'Sofia email');
    return result;
  })
);

router.post('/messaging/send-whatsapp', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'messaging.send-whatsapp', async () => {
    const orgId = getOrgId(req);
    const payload = bodyObject(req);
    requireApprovedMessagingAction(payload, 'sendWhatsApp');
    const body = optionalString(payload.body) || optionalString(payload.message);
    const toPhone = optionalString(payload.toPhone) || optionalString(payload.to_phone) || optionalString(payload.phone) || optionalString(payload.to);
    const toContactId = optionalString(payload.toContactId) || optionalString(payload.to_contact_id) || optionalString(payload.contact_id);
    if (!body || !toPhone) {
      const err = new Error('sendWhatsApp requires body and toPhone') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_WHATSAPP_REQUEST';
      throw err;
    }

    const result = await sendWhatsAppNotification({
      orgId,
      to: toPhone,
      contactId: toContactId || null,
      body,
      category: 'TRANSACTIONAL',
      source: 'WORKFLOW',
      metadata: {
        action: 'sofia_voice_send_whatsapp',
        forceCommunicationCore: true
      }
    });
    requireSent(result, 'Sofia WhatsApp');
    return result;
  })
);

router.post('/messaging/mark-needs-human', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'messaging.mark-needs-human', async () => {
    const orgId = getOrgId(req);
    const contactId = String(req.body?.contactId || req.body?.contact_id || '').trim();
    if (!contactId) {
      const err = new Error('contactId is required') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'CONTACT_ID_REQUIRED';
      throw err;
    }
    return conversationsService.setConversationHandled(orgId, contactId, null, false);
  })
);

router.post('/identity/verify-caller', async (req: RequestWithOrg, res: Response) => {
  const orgId = getOrgId(req);
  const phone = resolveCallerPhone(req);
  const pin = resolvePin(req);
  const actionType = optionalString(req.body?.actionType) || optionalString(req.body?.action_type);
  const requestedScope = optionalString(req.body?.requestedScope) || optionalString(req.body?.requested_scope) || optionalString(req.body?.scope);
  const callId = optionalString(req.body?.callId) || optionalString(req.body?.call_id);
  const sessionId = optionalString(req.body?.sessionId) || optionalString(req.body?.session_id);
  const sendRecoveryLink = req.body?.sendMagicLinkOnMissingPin === true || req.body?.sendRecoveryLink === true;
  const pinRequired = isSecureVoiceAction(actionType, requestedScope);

  const identityBoundaryDecision = buildToolBoundaryPolicyDryRun({
    routeNameOrPath: 'identity.verify-caller',
    orgId,
    channel: 'voice',
    actorType: 'caller',
    trustLevel: 'channel',
    verifiedFactors: [],
    source: 'sofia_tool_route'
  });
  if (identityBoundaryDecision) {
    void logInfo(
      'SofiaToolRoutes',
      'sofia_tool_boundary_policy_dry_run',
      sanitizeToolBoundaryPolicyMetadata(identityBoundaryDecision, 'identity.verify-caller', {
        entryPoint: 'api_sofia_tools',
        sessionId,
        callId,
        routeAction: 'identity.verify-caller'
      })
    );
  }

  if (!phone) {
    return badRequest(res, 'PHONE_REQUIRED', 'phone is required');
  }

  logInfo('SofiaIdentity', 'voice.identity.pin_required', {
    event_key: 'voice.identity.pin_required',
    orgId,
    phoneProvided: true,
    actionType,
    requestedScope,
    pinRequired,
    callId,
    sessionId
  });

  try {
    const contactMatch = await resolveSingleActiveContactByPhone(orgId, phone);
    if (contactMatch.ambiguous) {
      logInfo('SofiaIdentity', 'voice.identity.phone_ambiguous', {
        event_key: 'voice.identity.phone_ambiguous',
        orgId,
        actionType,
        requestedScope,
        callId,
        sessionId,
        matchCount: contactMatch.matchCount
      });

      return success(res, {
        verified: false,
        method: 'none',
        reason: 'duplicate_phone',
        identityStatus: 'unknown',
        trustLevel: 'channel',
        verifiedFactors: ['voice_channel'],
        pinRequired,
        actionAllowed: false,
        matchStatus: 'ambiguous',
        needsHumanFollowUp: true,
        matchCount: contactMatch.matchCount,
        magicLinkSent: false
      });
    }

    const contact = contactMatch.contact;
    if (!contact?.id) {
      return success(res, {
        verified: false,
        method: 'none',
        reason: 'contact_not_found',
        identityStatus: 'unknown',
        trustLevel: 'channel',
        verifiedFactors: ['voice_channel'],
        pinRequired,
        actionAllowed: false,
        matchStatus: 'not_found',
        magicLinkSent: false
      });
    }

    const contactId = String(contact.id);
    if (!pinRequired) {
      return success(res, {
        verified: true,
        method: 'phone',
        reason: 'phone_matched',
        identityStatus: 'contact_matched',
        trustLevel: 'contact_matched',
        verifiedFactors: ['voice_channel', 'org_scoped_phone_match'],
        pinRequired: false,
        actionAllowed: true,
        matchStatus: 'matched',
        contact: serializeIdentityContact(contact),
        contactId,
        magicLinkSent: false
      });
    }

    const result = await verifyCallerVoicePin({
      orgId,
      contactId,
      pin
    });
    let magicLinkSent = false;

    if (sendRecoveryLink && !result.verified && result.reason === 'pin_not_set') {
      const { requestMagicLink } = await import('../../services/client/authService.js');
      await requestMagicLink({
        contact: phone,
        contactId,
        orgId,
        channel: 'sms',
        requestMetadata: {
          ip: null,
          userAgent: 'sofia-voice'
        },
        requestId: req.requestId || null,
        allowAutoCreate: false
      });
      magicLinkSent = true;
      logInfo('SofiaIdentity', 'voice.identity.magic_link_sent', {
        event_key: 'voice.identity.magic_link_sent',
        orgId,
        contactId,
        actionType,
        requestedScope,
        callId,
        sessionId,
        reason: result.reason
      });
    }

    const eventKey = result.verified
      ? 'voice.identity.pin_verified'
      : result.reason === 'locked'
        ? 'voice.identity.pin_locked'
        : 'voice.identity.pin_failed';

    logInfo('SofiaIdentity', eventKey, {
      event_key: eventKey,
      orgId,
      contactId,
      actionType,
      requestedScope,
      callId,
      sessionId,
      reason: result.reason,
      pinSet: result.pinSet,
      remainingAttempts: result.remainingAttempts
    });

    return success(res, {
      ...result,
      identityStatus: result.verified ? 'channel_verified' : 'contact_matched',
      trustLevel: result.verified ? 'verified_sensitive' : 'contact_matched',
      verifiedFactors: result.verified
        ? ['voice_channel', 'org_scoped_phone_match', 'voice_pin']
        : ['voice_channel', 'org_scoped_phone_match'],
      pinRequired: true,
      actionAllowed: result.verified,
      matchStatus: 'matched',
      contact: serializeIdentityContact(contact),
      contactId,
      magicLinkSent
    });
  } catch (err) {
    logError('SofiaIdentity', 'Failed Sofia identity verification', err, {
      orgId,
      actionType,
      requestedScope,
      callId,
      sessionId
    });
    return error(res, getErrorCode(err), getErrorMessage(err, 'Sofia identity verification failed'), getErrorStatus(err));
  }
});

router.post('/crm/notify-owner', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'crm.notify-owner', async () => {
    const orgId = getOrgId(req);
    const contactId = String(req.body?.contactId || req.body?.contact_id || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!contactId || !message) {
      const err = new Error('contactId and message are required') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_NOTIFY_OWNER_REQUEST';
      throw err;
    }
    return handleContactNotifyOwner({
      orgId,
      entityType: 'contact',
      entityId: contactId,
      inputParams: {
        delivery_method: req.body?.delivery_method || 'both',
        subject_en: req.body?.subject_en || 'Sofia call handoff',
        subject_es: req.body?.subject_es || 'Transferencia de llamada de Sofia',
        body_en: req.body?.body_en || message,
        body_es: req.body?.body_es || message,
        message_en: req.body?.message_en || message,
        message_es: req.body?.message_es || message
      },
      actorUserId: null,
      workflowContext: { workflowRunId: 'sofia-voice' },
      actionDef: {
        id: 'action.contact.notify_owner',
        label: 'Notify owner',
        description: 'Notify assigned contact owner from Sofia voice.',
        visibility: 'internal',
        isDestructive: false,
        allowedEntityTypes: ['contact'],
        inputParams: {}
      }
    });
  })
);

router.post('/crm/write-call-summary', (req: RequestWithOrg, res: Response) =>
  handleTool(req, res, 'crm.write-call-summary', async () => {
    const orgId = getOrgId(req);
    const contactId = String(req.body?.contactId || req.body?.contact_id || '').trim();
    const summary = String(req.body?.summary || req.body?.body || '').trim();
    const actorUserId = String(req.body?.actorUserId || req.body?.actor_user_id || '').trim();
    if (!contactId || !summary) {
      const err = new Error('contactId and summary are required') as Error & { status?: number; code?: string };
      err.status = 400;
      err.code = 'INVALID_CALL_SUMMARY_REQUEST';
      throw err;
    }

    if (actorUserId) {
      const actorRows = await sql`
        SELECT m.user_id
        FROM membership m
        JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ${orgId}::uuid
          AND m.user_id = ${actorUserId}::uuid
        AND m.is_active = true
        AND u.deleted_at IS NULL
        LIMIT 1;
      `;
      if (!actorRows.length) {
        const err = new Error('actorUserId must belong to the requested org') as Error & { status?: number; code?: string };
        err.status = 400;
        err.code = 'INVALID_ACTOR_USER';
        throw err;
      }
    }

    return contactTimelineService.emitContactTimelineEvent({
      orgId,
      contactId,
      eventType: 'user.note',
      actorType: actorUserId ? 'user' : 'system',
      actorUserId: actorUserId || null,
      body: summary,
      metadata: {
        source: 'sofia_voice',
        summary_type: 'call_summary'
      }
    });
  })
);

export default router;
