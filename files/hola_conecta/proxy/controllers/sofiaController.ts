import crypto from 'crypto'
import type { Request, Response } from 'express'
import { success, badRequest, unauthorized, internalError, notFound, error as errorResp } from '../utils/response.js'
import { logInfo, logWarn } from '../utils/logger.js'
import {
  chat as chatService,
  submitFeedback} from '../sofia/services/sofiaService.ts'
import { maybeCreateActionFromInstruction } from '../sofia/services/sofiaInstructionActionService.ts'
import { createInteraction } from '../models/sofiaModel.js'
import {
  attachRequestedActionToCoreInput,
  attachSofiaContextEnvelope,
  buildInternalChatActorContext,
  buildInternalChatChannelContext,
  buildSofiaContextObservabilityPayload,
  evaluateSofiaPolicyDryRun,
  mapInternalChatInputToSofiaCoreInput
} from '../sofia/services/core/index.ts'
import type { SofiaRequest, SofiaServiceError } from '../types/sofia.js'

interface SofiaChatBody {
  org_id?: string
  message?: string
  text?: string
  prompt?: string
  language?: string
  lang?: string
  source?: string
  page_path?: string
  pagePath?: string
  session_id?: string
  sessionId?: string
  transcript?: string
}

interface SofiaFeedbackBody {
  org_id?: string
  request_id?: string
  interaction_id?: string
  rating?: 1 | -1 | null
  reason?: string | null
  comment?: string | null
}

type SofiaControllerRequest<
  TBody = SofiaChatBody,
  TQuery = Record<string, string | number | boolean | null | undefined>,
> = SofiaRequest<TBody, TQuery> & {
  file?: Express.Multer.File
}

function resolveHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export async function chat(
  rawReq: Request,
  res: Response,
): Promise<Response | void> {
  const req = rawReq as SofiaControllerRequest<SofiaChatBody>
  try {
    const uid = req.user?.uid
    if (!uid) return unauthorized(res, 'Unauthorized')

    const orgId = req.orgId || req.userData?.org_id || req.body?.org_id || null
    const userId = req.userData?.id || req.userId || null
    if (!orgId || !userId) {
      return badRequest(res, 'ORG_USER_REQUIRED', 'orgId and userId are required')
    }

    const text = req.body?.message || req.body?.text || req.body?.prompt || ''
    if (!text || typeof text !== 'string') {
      return badRequest(res, 'MESSAGE_REQUIRED', 'message text is required')
    }

    const sessionHeader = resolveHeaderValue(req.headers['x-sofia-session'])
    const requestIdHeader = resolveHeaderValue(req.headers['x-page-path'])
    const referer = resolveHeaderValue(req.headers.referer)
    const sessionId = req.body?.session_id || req.body?.sessionId || sessionHeader || crypto.randomUUID()
    const pagePath = req.body?.page_path || req.body?.pagePath || requestIdHeader || referer || '/sofia'
    const source = req.sofiaClient || req.body?.source || null

    const instructionResult = await maybeCreateActionFromInstruction({
      orgId,
      createdBy: userId,
      source,
      text: text.trim()})
    if (instructionResult?.created) {
      const requestId = crypto.randomUUID()
      let interactionId: string | null = null
      const language = req.body?.language || req.body?.lang
      const baseSofiaCoreInput = mapInternalChatInputToSofiaCoreInput({
        orgId,
        userId,
        sessionId,
        requestId,
        inputText: text.trim(),
        ...(language !== undefined ? { language } : {}),
        pagePath,
        source
      })
      const sofiaContextEnvelope = {
        actor: buildInternalChatActorContext({
          orgId,
          userId,
          source
        }),
        channel: buildInternalChatChannelContext({
          sessionId,
          requestId,
          pagePath,
          ...(language !== undefined ? { language } : {}),
          source,
          conversationId: sessionId
        }),
        orgId,
        userId,
        safeMetadata: {
          actionDraftCreated: true
        }
      }
      const sofiaCoreInput = attachRequestedActionToCoreInput(
        attachSofiaContextEnvelope(baseSofiaCoreInput, sofiaContextEnvelope),
        {
          actionType: instructionResult.actionType,
          status: 'drafted',
          approvalRequired: instructionResult.approvalRequired === true,
          idempotencyKey: instructionResult.idempotencyKey,
          source: 'sofia_instruction_action'
        }
      )
      const sofiaPolicyDryRun = evaluateSofiaPolicyDryRun(sofiaCoreInput)
      void logInfo('SofiaController', 'sofia_context_envelope_built', buildSofiaContextObservabilityPayload(
        sofiaCoreInput,
        sofiaContextEnvelope,
        { policyDecision: sofiaPolicyDryRun }
      ))
      void sofiaPolicyDryRun
      void sofiaCoreInput
      try {
        const interaction = await createInteraction({
          orgId,
          userId,
          sessionId,
          requestId,
          inputText: text.trim(),
          outputText: instructionResult.assistantText,
          rating: null,
          meta: {
            language: req.body?.language || req.body?.lang || null,
            pagePath,
            source,
            model: 'sofia-actions-intent',
            latencyMs: 0,
            actionDraftCreated: true,
            actionType: instructionResult.actionType
          }
        })
        interactionId = interaction.id || null
      } catch (error) {
        logWarn('SofiaController', 'Action draft interaction logging failed; returning assistant reply anyway', {
          orgId,
          userId,
          requestId,
          actionType: instructionResult.actionType,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return res.status(200).json({
        success: true,
        request_id: requestId,
        interaction_id: interactionId,
        assistant_text: instructionResult.assistantText,
        helpdesk_matches: [],
        model: 'sofia-actions-intent',
        latency_ms: 0})
    }

    const result = await chatService({
      orgId,
      userId,
      inputText: text.trim(),
      ...(req.body?.language || req.body?.lang ? { language: req.body.language || req.body.lang } : {}),
      pagePath,
      source,
      sessionId,
      requireAssistantReply: true})

    return res.status(200).json({
      success: true,
      request_id: result.requestId,
      interaction_id: result.interactionId,
      assistant_text: result.assistantText,
      helpdesk_matches: result.helpdeskMatches,
      model: result.model,
      latency_ms: result.latencyMs})
  } catch (error) {
    const typedError = error as SofiaServiceError
    if (typedError.message === 'SOFIA_NO_REPLY') {
      return errorResp(res, 'SOFIA_NO_REPLY', 'Sofia could not generate a reply', 503, typedError.detail || null)
    }
    if (typedError.status === 503) {
      return errorResp(
        res,
        'SOFIA_RAG_UNAVAILABLE',
        'Sofia knowledge is temporarily unavailable',
        503,
        typedError.detail || typedError.message || null,
      )
    }
    return internalError(res, error instanceof Error ? error : new Error(String(error)), 'Sofia chat failed')
  }
}

export async function feedback(
  rawReq: Request,
  res: Response,
): Promise<Response | void> {
  const req = rawReq as SofiaControllerRequest<SofiaFeedbackBody>
  try {
    const uid = req.user?.uid
    if (!uid) return unauthorized(res, 'Unauthorized')

    const orgId = req.orgId || req.userData?.org_id || req.body?.org_id || null
    const { request_id, interaction_id, rating, reason = null, comment = null } = req.body || {}
    const feedbackIdentifier = interaction_id || request_id

    if (!orgId) return badRequest(res, 'ORG_REQUIRED', 'orgId is required')
    if (!feedbackIdentifier) return badRequest(res, 'INTERACTION_ID_REQUIRED', 'interaction_id or request_id is required')
    if (![1, -1, null, undefined].includes(rating)) {
      return badRequest(res, 'INVALID_RATING', 'rating must be 1, -1, or null')
    }

    await submitFeedback({ orgId, requestId: feedbackIdentifier, rating, reason, comment })
    return success(res, { updated: true })
  } catch (error) {
    const typedError = error as SofiaServiceError
    if (typedError.status === 404) return notFound(res, 'Interaction not found')
    return internalError(res, error instanceof Error ? error : new Error(String(error)), 'Failed to submit feedback')
  }
}
