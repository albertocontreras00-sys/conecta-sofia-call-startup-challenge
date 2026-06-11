import { WEBSITE_CHAT_ORG_ID } from '../../config/constants.js'
import { logError } from '../../utils/logger.js'
import { prepareWebsiteChatVisitorSession } from './websiteChatVisitorSession.ts'
import {
  runWebsiteChatSofiaPipeline,
  WEBSITE_CHAT_BOOKING_URL,
  type WebsiteChatResult
} from './websiteChatSofiaPipeline.ts'

export {
  detectLeadSignals,
  type WebsiteLeadSignals
} from './websiteChatVisitorSession.ts'

export {
  buildSystemPrompt,
  parseWebsiteChatModelReply,
  resolveWebsiteChatSuggestedAction,
  shouldRequestContactCapture,
  type WebsiteChatModelReply,
  type WebsiteChatSuggestedAction
} from './websiteChatSofiaPipeline.ts'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue
}

interface WebsiteChatInput {
  message: string
  sessionId?: string | null
  visitorId?: string | null
  pageUrl?: string | null
  pageTitle?: string | null
  language?: string | null
  email?: string | null
  name?: string | null
  phone?: string | null
  attribution?: JsonObject | null
  userAgent?: string | null
  ipAddress?: string | null
}

function safePagePath(input: string | null | undefined): string | null {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value) return null
  try {
    return new URL(value).pathname || '/'
  } catch {
    return value.split(/[?#]/)[0] || null
  }
}

export async function getWebsiteChatConfig() {
  return {
    enabled: true,
    orgId: WEBSITE_CHAT_ORG_ID,
    bookingUrl: WEBSITE_CHAT_BOOKING_URL}
}

export async function safeWebsiteChat(input: WebsiteChatInput): Promise<WebsiteChatResult> {
  const sessionCtx = await prepareWebsiteChatVisitorSession(input)
  return runWebsiteChatSofiaPipeline(sessionCtx)
}

export async function chatWithWebsiteSofia(input: WebsiteChatInput): Promise<WebsiteChatResult> {
  try {
    return await safeWebsiteChat(input)
  } catch (error) {
    logError('websiteChatService', 'Website chat failed', error, {
      sessionId: input.sessionId,
      pagePath: safePagePath(input.pageUrl),
      orgId: WEBSITE_CHAT_ORG_ID,
      event_key: 'websiteChat.failure_boundary',
      failureBoundary: 'chat_with_website_sofia',
      hasInput: Boolean(input.message),
      inputLength: String(input.message || '').length})
    throw error
  }
}
