import { sendEmailNotification, sendSmsNotification, sendWhatsAppNotification } from '../../../services/notifications/notificationHub.js'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | SofiaActionsJsonObject | JsonValue[]

export interface SofiaActionsJsonObject {
  [key: string]: JsonValue
}

export interface SofiaActionExecutionResult {
  messageId: string | null
  status: string
  reason: string | null
}

function isUuid(value: string | null | undefined): value is string {
  if (!value) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function normalizeUuidOrNull(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return isUuid(trimmed) ? trimmed : null
}

function normalizeString(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function createServiceError(message: string, status = 400): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

export function validateEmailPayload(payload: SofiaActionsJsonObject): void {
  const toEmail = normalizeString(payload.toEmail ?? payload.to_email)
  const toContactId = normalizeUuidOrNull(payload.toContactId ?? payload.to_contact_id ?? payload.contact_id)
  const subject = normalizeString(payload.subject)
  const body = normalizeString(payload.body)

  if (!toEmail && !toContactId) {
    throw createServiceError('send_email payload requires toEmail or toContactId', 400)
  }
  if (!subject) {
    throw createServiceError('send_email payload requires subject', 400)
  }
  if (!body) {
    throw createServiceError('send_email payload requires body', 400)
  }
}

export function normalizeEmailPayload(payload: SofiaActionsJsonObject): SofiaActionsJsonObject {
  const toEmail = normalizeString(payload.toEmail ?? payload.to_email)
  const toContactId = normalizeUuidOrNull(payload.toContactId ?? payload.to_contact_id ?? payload.contact_id)
  const subject = normalizeString(payload.subject)
  const body = normalizeString(payload.body)
  const text = normalizeString(payload.text)
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? (payload.metadata as SofiaActionsJsonObject)
      : {}

  const ccRaw = payload.ccEmails ?? payload.cc_emails ?? null
  const ccEmails = Array.isArray(ccRaw)
    ? ccRaw.map((email) => normalizeString(email)).filter(Boolean)
    : normalizeString(ccRaw)
      ? [normalizeString(ccRaw)]
      : []

  return {
    toEmail,
    toContactId,
    subject,
    body,
    text,
    ccEmails,
    metadata}
}

export function validateSmsPayload(payload: SofiaActionsJsonObject): void {
  const toPhone = normalizeString(payload.toPhone ?? payload.to_phone ?? payload.phone)
  const toContactId = normalizeUuidOrNull(payload.toContactId ?? payload.to_contact_id ?? payload.contact_id)
  const body = normalizeString(payload.body ?? payload.message)

  if (!toPhone && !toContactId) {
    throw createServiceError('send_sms payload requires toPhone or toContactId', 400)
  }
  if (!body) {
    throw createServiceError('send_sms payload requires body', 400)
  }
}

export function validateWhatsAppPayload(payload: SofiaActionsJsonObject): void {
  const toPhone = normalizeString(payload.toPhone ?? payload.to_phone ?? payload.phone ?? payload.to)
  const body = normalizeString(payload.body ?? payload.message)

  if (!toPhone) {
    throw createServiceError('send_whatsapp payload requires toPhone', 400)
  }
  if (!body) {
    throw createServiceError('send_whatsapp payload requires body', 400)
  }
}

export function normalizeSmsPayload(payload: SofiaActionsJsonObject): SofiaActionsJsonObject {
  const toPhone = normalizeString(payload.toPhone ?? payload.to_phone ?? payload.phone)
  const toContactId = normalizeUuidOrNull(payload.toContactId ?? payload.to_contact_id ?? payload.contact_id)
  const body = normalizeString(payload.body ?? payload.message)
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? (payload.metadata as SofiaActionsJsonObject)
      : {}

  return {
    toPhone,
    toContactId,
    body,
    metadata}
}

export function normalizeWhatsAppPayload(payload: SofiaActionsJsonObject): SofiaActionsJsonObject {
  const toPhone = normalizeString(payload.toPhone ?? payload.to_phone ?? payload.phone ?? payload.to)
  const toContactId = normalizeUuidOrNull(payload.toContactId ?? payload.to_contact_id ?? payload.contact_id)
  const body = normalizeString(payload.body ?? payload.message)
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? (payload.metadata as SofiaActionsJsonObject)
      : {}

  return {
    toPhone,
    toContactId,
    body,
    metadata}
}

export async function executeSendEmailAction({
  orgId,
  payload,
  actionId}: {
  orgId: string
    payload: SofiaActionsJsonObject
  actionId: string
}): Promise<SofiaActionExecutionResult> {
  validateEmailPayload(payload)
  const normalized = normalizeEmailPayload(payload)
  const metadata =
    normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? (normalized.metadata as SofiaActionsJsonObject)
      : {}

  const result = await sendEmailNotification({
    orgId,
    toContactId: (normalized.toContactId as string | null) || null,
    toEmail: (normalized.toEmail as string | null) || undefined,
    subject: (normalized.subject as string) || '',
    body: (normalized.body as string) || '',
    text: (normalized.text as string | null) || undefined,
    category: 'SYSTEM',
    source: 'SYSTEM',
    metadata: {
      ...metadata,
      action: 'sofia_action_send_email',
      assistantActionId: actionId,
      forceLegacyNotificationPath: false}})

  return {
    messageId: result?.messageId || null,
    status: result?.status || 'failed',
    reason: result?.reason || null}
}

export async function executeSendSmsAction({
  orgId,
  payload,
  actionId}: {
  orgId: string
  payload: SofiaActionsJsonObject
  actionId: string
}): Promise<SofiaActionExecutionResult> {
  validateSmsPayload(payload)
  const normalized = normalizeSmsPayload(payload)
  const metadata =
    normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? (normalized.metadata as SofiaActionsJsonObject)
      : {}

  const result = await sendSmsNotification({
    orgId,
    toContactId: (normalized.toContactId as string | null) || null,
    toPhone: (normalized.toPhone as string | null) || undefined,
    body: (normalized.body as string) || '',
    category: 'SYSTEM',
    source: 'SYSTEM',
    metadata: {
      ...metadata,
      action: 'sofia_action_send_sms',
      assistantActionId: actionId,
      forceLegacyNotificationPath: false}})

  return {
    messageId: result?.messageId || null,
    status: result?.status || 'failed',
    reason: result?.reason || null}
}

export async function executeSendWhatsAppAction({
  orgId,
  payload,
  actionId}: {
  orgId: string
  payload: SofiaActionsJsonObject
  actionId: string
}): Promise<SofiaActionExecutionResult> {
  validateWhatsAppPayload(payload)
  const normalized = normalizeWhatsAppPayload(payload)
  const metadata =
    normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? (normalized.metadata as SofiaActionsJsonObject)
      : {}

  const result = await sendWhatsAppNotification({
    orgId,
    contactId: (normalized.toContactId as string | null) || null,
    to: (normalized.toPhone as string | null) || undefined,
    body: (normalized.body as string) || '',
    category: 'TRANSACTIONAL',
    source: 'WORKFLOW',
    metadata: {
      ...metadata,
      action: 'sofia_action_send_whatsapp',
      assistantActionId: actionId,
      forceCommunicationCore: true}})

  return {
    messageId: result?.messageId || null,
    status: result?.status || 'failed',
    reason: result?.reason || null}
}
