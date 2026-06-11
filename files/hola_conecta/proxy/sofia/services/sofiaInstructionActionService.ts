import crypto from 'crypto'
import { createAction, getAllowedSofiaActionsOrgId } from './sofiaActionsService.js'

type ChannelType = 'send_email' | 'send_sms'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
interface JsonObject {
  [key: string]: JsonValue
}

interface ParsedInstruction {
  actionType: ChannelType
  target: string
  subject: string | null
  body: string
  reason: string | null
}

interface SofiaInstructionResult {
  created: boolean
  assistantText: string
  actionId?: string
  actionType?: ChannelType
  approvalRequired?: boolean
  idempotencyKey?: string
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractReason(text: string): string | null {
  const matches = text.match(/\b(?:because|for|por)\b\s+(.+)$/i)
  if (!matches) return null
  return normalizeWhitespace(matches[1] || '') || null
}

function extractQuotedMessage(text: string): string | null {
  const quoteMatch = text.match(/["“”']([^"“”']{4})["“”']/)
  if (!quoteMatch) return null
  return normalizeWhitespace(quoteMatch[1] || '') || null
}

function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2}/)
  return match ? match[0].toLowerCase() : null
}

function extractPhone(text: string): string | null {
  const match = text.match(/\+?[0-9][0-9\s().-]{7}[0-9]/)
  return match ? normalizeWhitespace(match[0]) : null
}

function extractBody(text: string, reason: string | null): string {
  const quoted = extractQuotedMessage(text)
  if (quoted) return quoted

  const lowered = text.toLowerCase()
  const messageMarkers = [' saying ', ' message ', ' that ', ' to say ']
  for (const marker of messageMarkers) {
    const idx = lowered.indexOf(marker)
    if (idx >= 0) {
      const slice = text.slice(idx + marker.length)
      const cleaned = reason ? slice.replace(new RegExp(`\\b(?:because|for|por)\\b\\s+${reason.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'i'), '') : slice
      const finalBody = normalizeWhitespace(cleaned)
      if (finalBody.length >= 4) return finalBody
    }
  }

  return 'Following up as requested. I will share details shortly.'
}

function inferActionType(text: string): ChannelType | null {
  const lowered = text.toLowerCase()
  if (!/(send|text|sms|email|message)/i.test(lowered)) return null
  if (/(sms|text message|text )/i.test(lowered)) return 'send_sms'
  if (/(email|mail)/i.test(lowered)) return 'send_email'
  return null
}

function parseInstruction(text: string): ParsedInstruction | null {
  const actionType = inferActionType(text)
  if (!actionType) return null

  const reason = extractReason(text)
  if (actionType === 'send_email') {
    const email = extractEmail(text)
    if (!email) return null

    const body = extractBody(text, reason)
    const subject = reason ? `Sofia follow-up: ${reason}` : 'Sofia follow-up'
    return {
      actionType,
      target: email,
      subject,
      body,
      reason}
  }

  const phone = extractPhone(text)
  if (!phone) return null
  const body = extractBody(text, reason)
  return {
    actionType,
    target: phone,
    subject: null,
    body,
    reason}
}

export async function maybeCreateActionFromInstruction({
  orgId,
  createdBy,
  source,
  text}: {
  orgId: string
  createdBy: string | null
  source: string | null
  text: string
}): Promise<SofiaInstructionResult | null> {
  if (orgId !== getAllowedSofiaActionsOrgId()) return null
  if (source !== 'admin_sofia' && source !== 'sofia-modal' && source !== 'sofia-page') return null

  const parsed = parseInstruction(text)
  if (!parsed) return null

  const idempotencyKey = `sofia-chat:${crypto.randomUUID()}`

  let payload: JsonObject
  if (parsed.actionType === 'send_email') {
    payload = {
      toEmail: parsed.target,
      subject: parsed.subject || 'Sofia follow-up',
      body: `<p>${parsed.body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
      text: parsed.body,
      metadata: {
        source: 'sofia_chat_instruction',
        reason: parsed.reason}}
  } else {
    payload = {
      toPhone: parsed.target,
      body: parsed.body,
      metadata: {
        source: 'sofia_chat_instruction',
        reason: parsed.reason}}
  }

  const action = await createAction({
    orgId,
    createdBy,
    actionType: parsed.actionType,
    payload,
    approvalRequired: true,
    channel: parsed.actionType === 'send_email' ? 'email' : 'sms',
    idempotencyKey})

  const assistantText = parsed.actionType === 'send_email'
    ? `I created an email action to ${parsed.target}. Reason: ${parsed.reason || 'not specified'}. Please approve it in the Sofia action queue.`
    : `I created an SMS action to ${parsed.target}. Reason: ${parsed.reason || 'not specified'}. Please approve it in the Sofia action queue.`

  return {
    created: true,
    assistantText,
    actionId: action.id,
    actionType: parsed.actionType,
    approvalRequired: true,
    idempotencyKey}
}
