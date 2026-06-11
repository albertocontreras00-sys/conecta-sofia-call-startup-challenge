import type { Request, Response } from 'express'
import crypto from 'crypto'
import { badRequest, error as errorResp, internalError, success } from '../utils/response.js'
import { chatWithWebsiteSofia, getWebsiteChatConfig } from '../sofia/services/websiteChatService.ts'
import type { SofiaRequest } from '../types/sofia.js'

interface WebsiteChatBody {
  message?: string
  sessionId?: string
  pageUrl?: string
  pageTitle?: string
  language?: string
  email?: string
  name?: string
  phone?: string
  visitorId?: string
  visitor_id?: string
  attribution?: JsonObject
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
interface JsonObject {
  [key: string]: JsonValue
}

interface WebsiteChatValidationError {
  error: string[]
}

interface WebsiteChatValidatedBody {
  message: string
  sessionId: string
  pageUrl: string | null
  pageTitle: string | null
  language: string
  email: string | null
  name: string | null
  phone: string | null
  visitorId: string | null
  attribution: JsonObject | null
}

type WebsiteChatValidationResult = WebsiteChatValidationError | WebsiteChatValidatedBody

type WebsiteChatRequest = SofiaRequest<WebsiteChatBody> & {
  ip?: string
}

function trimOptional(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeJsonObject(value: JsonObject | undefined): JsonObject | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  return value
}

function validateBody(body: WebsiteChatBody): WebsiteChatValidationResult {
  const message = trimOptional(body.message)
  if (!message) return { error: ['message is required'] }
  if (message.length > 2000) return { error: ['message must be 2000 characters or fewer'] }

  const pageUrl = trimOptional(body.pageUrl)
  if (pageUrl && pageUrl.length > 500) return { error: ['pageUrl must be 500 characters or fewer'] }

  return {
    message,
    sessionId: trimOptional(body.sessionId) || crypto.randomUUID(),
    pageUrl,
    pageTitle: trimOptional(body.pageTitle),
    language: trimOptional(body.language) || 'en',
    email: trimOptional(body.email),
    name: trimOptional(body.name),
    phone: trimOptional(body.phone),
    visitorId: trimOptional(body.visitorId) || trimOptional(body.visitor_id),
    attribution: normalizeJsonObject(body.attribution)}
}

export async function getConfig(_rawReq: Request, res: Response): Promise<Response | void> {
  try {
    const config = await getWebsiteChatConfig()
    return success(res, config)
  } catch (error) {
    return internalError(
      res,
      error instanceof Error ? error : new Error(String(error)),
      'Website chat config failed',
    )
  }
}

export async function chat(rawReq: Request, res: Response): Promise<Response | void> {
  const req = rawReq as WebsiteChatRequest
  const validated = validateBody(req.body || {})
  if ('error' in validated) {
    return badRequest(res, 'INVALID_WEBSITE_CHAT_PAYLOAD', validated.error.join(', '))
  }

  try {
    const result = await chatWithWebsiteSofia({
      ...validated,
      userAgent: trimOptional(req.headers['user-agent']),
      ipAddress: trimOptional(req.ip)})

    return success(res, { data: result })
  } catch (error) {
    const typedError = error as Error & { status?: number; detail?: string | null }
    if (typedError?.status === 503) {
      return errorResp(
        res,
        'WEBSITE_CHAT_RAG_UNAVAILABLE',
        'Website chat knowledge is temporarily unavailable',
        503,
        typedError.detail || typedError.message || null,
      )
    }

    return internalError(
      res,
      error instanceof Error ? error : new Error(String(error)),
      'Website chat failed',
    )
  }
}
