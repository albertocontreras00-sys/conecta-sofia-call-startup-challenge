import { WEBSITE_CHAT_ORG_ID } from '../../config/constants.js'
import { recordMarketingVisitorAttribution } from '../../models/marketingVisitorAttributionModel.ts'
import { searchPublicHelpDesk } from '../../models/sofiaModel.js'
import {
saveWebsiteVisitorConversation
} from '../../models/websiteVisitorModel.js'
import aiGatewayService from '../../services/ai/aiGatewayService.ts'
import { emitConectaVokerEvent } from '../../services/observability/vokerObservabilityService.ts'
import { logInfo,logWarn } from '../../utils/logger.js'
import { mapWebsiteChatOutputToSofiaCoreOutput } from './core/index.ts'
import type { WebsiteLeadSignals } from './websiteChatVisitorSession.ts'
import {
createChatMessage,
type ConversationContext,
type WebsiteChatVisitorSessionContext
} from './websiteChatVisitorSession.ts'
import {
completeSofiaWorkflowSessionTrace,
composeSofiaResponse,
createSofiaPersonaGuidance,
createSofiaWorkflowAuditEvent,
evaluateSofiaPolicyDecision,
persistSofiaMemoryCandidates
} from './workflow/index.ts'

type FollowUpChannel = 'email' | 'text'

export interface WebsiteChatSuggestedAction {
  [key: string]: string
  type: 'book_demo' | 'view_pricing'
  label: string
  url: string
}

export interface WebsiteChatModelReply {
  reply?: string
  suggestedAction?: 'book_demo' | 'view_pricing' | 'none' | null
  needsContactCapture?: boolean
  replySource?: 'model_reply' | 'fallback'
}

interface ParsedModelReplyCandidate {
  reply?: string
  suggestedAction?: 'book_demo' | 'view_pricing' | 'none' | null
  response?: string
  needsContactCapture?: boolean | string | number | null
  replySource?: 'model_reply' | 'fallback'
}

export const WEBSITE_CHAT_BOOKING_URL =
  process.env.WEBSITE_CHAT_BOOKING_URL ||
  'https://app.holaconecta.com/booking/conecta/chat-about-conecta'
export const WEBSITE_CHAT_PRICING_URL = 'https://www.holaconecta.com/pricing'

function isPricingPage(pageUrl?: string | null): boolean {
  const normalized = String(pageUrl || '').toLowerCase()
  if (!normalized) return false
  return /\/(es\/)?pricing(?:[/?#]|$)/.test(normalized)
}

function buildPricingPageInstructionLayer(params: {
  hasBookingIntent: boolean
}): string {
  const bookingRule = params.hasBookingIntent
    ? 'If the visitor explicitly asks for a call or demo, use suggestedAction = "book_demo".'
    : ''

  return `Page behavior: /pricing

GOAL
You are a consultative sales assistant. Your job is to answer pricing directly, help the visitor choose the right next step, and avoid pushing for contact too early.

PLANS (use this to answer questions and make recommendations)
- Conecta Lite ($47/mo · $470/yr): Self-serve. Visitor sets everything up themselves. Core tools: messaging, scheduling, document collection, e-signatures, and payments. No workflows, automations, or team features. Best for solo operators.
- Conecta Pro ($150/mo · $1,500/yr): Guided setup included. We help connect their domain and email, import contacts, configure branding, and set up booking events. Includes workflows, automations, team features, 2-way SMS, WhatsApp, and unlimited team members. Best for tax offices with staff or anyone who wants it done for them.

Optional add-on (any plan): Website management ($500 one-time) — DNS, domain, email setup, forms, and booking links connected to Conecta.

ON-PAGE ACTIONS
- The pricing page has a pricing wizard. The visitor can choose Lite or Pro, choose monthly or annual billing, then continue to secure checkout.
- If the visitor asks how to buy from this page, tell them to choose the plan that fits and continue to secure checkout.
- You may mention the visible CTAs: "Start with Lite", "Lock In Pro Before Launch", or "Open checkout" when relevant.

HOW TO REASON
If the visitor asks for a recommendation, understand:
- Are they a solo operator or do they have a team?
- Do they want to set it up themselves, or have us handle it?

With that, the recommendation is obvious:
- Solo + self-serve → Lite
- Has a team, or wants guided setup → Pro

HOW TO CONVERSE
- One question at a time
- If they only ask for price, answer with the prices first
- If they seem unsure after pricing, ask: "Do you want to get started, or would you rather talk to someone from the team first?"
- If they don't know enough to choose and explicitly ask for a recommendation, ask something that gets you closer
- If you know enough, recommend without hedging
- Keep responses short
- Don't repeat pricing you've already given
- Do not ask for contact details just because they asked about price
${bookingRule}`
}

export function buildSystemPrompt(params: {
  language: string
  pageTitle: string | null
  pageUrl: string | null
  helpDeskContext: string
  leadSignals: WebsiteLeadSignals
}): string {
  const helpDeskContext = sanitizeMessage(params.helpDeskContext || '')
  const pageTitle = params.pageTitle || 'not_provided'
  const pageUrl = params.pageUrl || 'not_provided'
  const language = params.language || 'en'
  const onPricingPage = isPricingPage(pageUrl)
  const pageInstructionLayer = onPricingPage
    ? buildPricingPageInstructionLayer({
        hasBookingIntent: Boolean(params.leadSignals?.bookingIntent)})
    : ''

  return `You are Sofia, the first person someone talks to when they visit the Conecta website.

Always respond in English, regardless of the language the visitor uses.

Be friendly, clear, and helpful.

Your job is to answer the visitor’s question as best as you can.

- Answer questions directly and clearly
- If you know the answer, say it confidently
- Do not give vague answers if real information is available
- Keep responses short and natural
- Do not ask for more information unless the request is genuinely ambiguous or you cannot answer it without one missing detail
- If the question can be answered from the help desk context, answer it directly instead of asking a follow-up
- If the user just says hi, answer with a short greeting and one helpful prompt

If you’re not sure about something:
- Say you’ll double check or point them to the best available page
- Do not ask for contact details unless the user explicitly wants a follow-up

Do not be pushy.
Only suggest a demo or next step if it actually makes sense in the conversation.

Return a single JSON object with:
{
  "reply": string,
  "suggestedAction": "book_demo" | "view_pricing" | "none",
  "needsContactCapture": boolean
}

Rules:
- Use the help desk context below for factual product information.
- Follow page-specific behavior rules for how to respond.
- If page-specific behavior rules conflict with retrieved help desk context, page-specific behavior rules win for response flow.
- If the help desk context contains the factual answer, use it directly without changing the page-specific conversation behavior.
- If the help desk context includes pricing, include the actual prices.
- Do not ask for team size or feature details unless the user explicitly asks for a recommendation.
- Do not mention that you are using help desk context.
- Do not wrap the JSON in markdown or code fences.
- Set needsContactCapture to true only when the visitor explicitly asks for a demo, call, contact, to talk to someone, to have someone reach out, to send info, a transcript, or follow-up.
- Do not set needsContactCapture to true only because the visitor asked about price.
- Pricing-only questions should use needsContactCapture = false.
- Pricing-only questions should use suggestedAction = "view_pricing" when the visitor is not already on /pricing.
- Pricing-only questions should use suggestedAction = "none" when the visitor is already on /pricing.
- Set needsContactCapture to false when the visitor is only asking general product or support questions.

${pageInstructionLayer}

Current page:
- language: ${language}
- pageTitle: ${pageTitle}
- pageUrl: ${pageUrl}

Help desk context:
${helpDeskContext || 'No matching help desk articles were found for this question.'}
`
}

export function parseWebsiteChatModelReply(rawText: string, language: string): WebsiteChatModelReply {
  const cleanedText = String(rawText || '').trim()
  const fencedMatch = cleanedText.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidateTexts = [
    cleanedText,
    cleanedText.replace(/\\\$/g, '$'),
    fencedMatch?.[1]?.trim() || '',
    (fencedMatch?.[1]?.trim() || '').replace(/\\\$/g, '$'),
  ].filter(Boolean)

  for (const candidate of candidateTexts) {
    try {
      const parsed = JSON.parse(candidate) as ParsedModelReplyCandidate
      const rawNeedsContactCapture = parsed.needsContactCapture
      const replyText =
        typeof parsed.reply === 'string'
          ? parsed.reply
          : typeof parsed.response === 'string'
            ? parsed.response
            : null

      if (replyText) {
        return {
          ...parsed,
          reply: replyText,
          needsContactCapture:
            rawNeedsContactCapture === true || rawNeedsContactCapture === 'true' || rawNeedsContactCapture === 1,
          replySource: 'model_reply'}
      }
    } catch {
      // continue
    }
  }

  if (cleanedText) {
    logWarn('websiteChatService', 'Website chat model reply JSON parse failed', {
      event_key: 'websiteChat.failure_boundary',
      failureBoundary: 'model_reply_parse',
      hasProviderOutput: true,
      providerOutputLength: cleanedText.length,
      language
    })
  }

  return {
    reply:
      language === 'es'
        ? 'Puedo ayudar con preguntas sobre Conecta, precios y demos. ¿Qué te gustaría saber?'
        : 'I can help with questions about Conecta, pricing, and demos. What would you like to know?',
    suggestedAction: 'none',
    needsContactCapture: false,
    replySource: 'fallback'}
}

export function shouldRequestContactCapture(params: {
  leadSignals: WebsiteLeadSignals
  modelReply?: Pick<WebsiteChatModelReply, 'needsContactCapture'> | null
}): boolean {
  if (params.leadSignals.bookingIntent || params.leadSignals.followUpIntent) return true
  if (params.modelReply?.needsContactCapture && !params.leadSignals.asksPricing) return true
  return false
}

export function resolveWebsiteChatSuggestedAction(params: {
  leadSignals: WebsiteLeadSignals
  modelReply?: Pick<WebsiteChatModelReply, 'suggestedAction'> | null
  pageUrl?: string | null
}): WebsiteChatSuggestedAction | null {
  const modelSuggestedAction = params.modelReply?.suggestedAction || 'none'

  if (params.leadSignals.asksPricing && !params.leadSignals.bookingIntent && !params.leadSignals.followUpIntent) {
    if (isPricingPage(params.pageUrl)) return null
    return {
      type: 'view_pricing',
      label: 'View pricing',
      url: WEBSITE_CHAT_PRICING_URL
    }
  }

  if (params.leadSignals.bookingIntent || modelSuggestedAction === 'book_demo') {
    return {
      type: 'book_demo',
      label: 'Book a demo',
      url: WEBSITE_CHAT_BOOKING_URL
    }
  }

  if (modelSuggestedAction === 'view_pricing') {
    if (isPricingPage(params.pageUrl)) return null
    return {
      type: 'view_pricing',
      label: 'View pricing',
      url: WEBSITE_CHAT_PRICING_URL
    }
  }

  return null
}

export interface WebsiteChatResult {
  reply: string
  response?: string
  sessionId: string
  suggestedNextAction?: WebsiteChatSuggestedAction | null
  needsContactCapture: boolean
  conversationEnded: boolean
  followUpChannels: Array<'email' | 'text'>
  closingMessage: string | null
}

function sanitizeMessage(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function buildHelpDeskContext(matches: Awaited<ReturnType<typeof searchPublicHelpDesk>>): string {
  if (!matches.length) {
    return 'No matching help desk articles were found for this question.'
  }

  return matches
    .slice(0, 4)
    .map((match, index) => {
      const excerpt = match.content.replace(/\s+/g, ' ').slice(0, 1200)
      return `${index + 1}. ${match.title}${match.url ? ` (${match.url})` : ''}\n${excerpt}`
    })
    .join('\n\n')
}

function summarizeHelpDeskMatches(matches: Awaited<ReturnType<typeof searchPublicHelpDesk>>) {
  return matches.slice(0, 4).map((match) => ({
    id: match.id,
    title: match.title,
    category: match.category,
    priority: match.priority,
    topicType: match.topicType || null,
    audience: match.audience || null,
    visibility: match.visibility || null,
    url: match.url || null}))
}

function buildClosingMessage(language: string, channels: FollowUpChannel[]): string {
  const followUpText =
    channels.length === 2
      ? language === 'es'
        ? 'Sofia te seguirá por email o mensaje.'
        : 'Sofia will follow up by email or text.'
      : channels[0] === 'email'
        ? language === 'es'
          ? 'Sofia te seguirá por email.'
          : 'Sofia will follow up by email.'
        : language === 'es'
          ? 'Sofia te seguirá por mensaje.'
          : 'Sofia will follow up by text.'

  return language === 'es'
    ? `Gracias. Cerramos este chat y ${followUpText}`
    : `Thanks. This chat is now closed and ${followUpText}`
}

function buildDefaultReply(language: string): string {
  return language === 'es'
    ? 'Puedo ayudarte con preguntas sobre Conecta, precios y demos.'
    : 'I can help with questions about Conecta, pricing, and demos.'
}

export async function runWebsiteChatSofiaPipeline(
  ctx: WebsiteChatVisitorSessionContext,
): Promise<WebsiteChatResult> {
  const {
    startedAt,
    sessionId,
    visitorId,
    traceId,
    language,
    pageUrl,
    pageTitle,
    pagePath,
    currentPageContext,
    message,
    effectiveContact,
    userConversation,
    leadSignals,
    workflowEnvelope,
    workflowIdentity,
    workflowMemory,
    preModelContext,
    pagesVisited,
    input
  } = ctx

  let visitor = ctx.visitor

  const helpdeskMatches = await searchPublicHelpDesk({
    query: message,
    limit: 6})
  await createSofiaWorkflowAuditEvent({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    eventType: 'rag_used',
    eventSummary: 'External website RAG context loaded',
    metadata: {
      entryPoint: 'external_website_chat',
      ragScope: 'external',
      matchCount: helpdeskMatches.length,
      contextCount: userConversation.length
    }
  })

  logInfo('websiteChatService', 'Website chat help desk retrieval complete', {
    event_key: 'websiteChat.flow',
    sessionId,
    mode: 'website',
    helpdeskMatchCount: helpdeskMatches.length,
    helpdeskMatches: summarizeHelpDeskMatches(helpdeskMatches)})
  emitConectaVokerEvent({
    agentKey: 'website_rag_mcp',
    channel: 'website_chat',
    direction: 'tool',
    orgId: WEBSITE_CHAT_ORG_ID,
    visitorId,
    sessionId,
    conversationId: sessionId,
    entryPoint: 'external_website_chat',
    pipeline: 'mcp',
    toolName: 'searchPublicHelpDesk',
    actionName: 'rag_retrieval',
    outcome: 'success',
    metadata: {
      matchCount: helpdeskMatches.length,
      helpdeskMatchCount: helpdeskMatches.length,
      contextCount: userConversation.length,
      pagePath,
      language,
      hasContactInfo: Boolean(effectiveContact.email || effectiveContact.phone || effectiveContact.name)
    }
  })

  const aiResponse = await aiGatewayService.generateText({
    orgId: WEBSITE_CHAT_ORG_ID,
    surface: 'website_chat',
    system: buildSystemPrompt({
      language,
      pageTitle,
      pageUrl,
      helpDeskContext: buildHelpDeskContext(helpdeskMatches),
      leadSignals}),
    messages: userConversation.slice(-8).map((entry) => ({
      role: entry.role,
      content: entry.content})),
    tools: [],
    jsonMode: true,
    temperature: 0.5,
    maxTokens: 400,
    metadata: {
      data_source: 'USER_PROVIDED',
      source_integration: 'website_chat',
      source_ref: sessionId}})
  await createSofiaWorkflowAuditEvent({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    eventType: 'orchestrator_called',
    eventSummary: 'AI gateway call completed for external website chat',
    metadata: {
      entryPoint: 'external_website_chat',
      provider: aiResponse.provider || 'unknown',
      model: aiResponse.model || 'unknown',
      status: aiResponse.text ? 'succeeded' : 'failed'
    }
  })

  logInfo('websiteChatService', 'Website chat model response received', {
    event_key: 'websiteChat.flow',
    sessionId,
    provider: aiResponse.provider,
    model: aiResponse.model,
    fallbackUsed: aiResponse.fallbackUsed,
    fallback: aiResponse.fallback || null,
    usage: aiResponse.usage,
    hasProviderOutput: Boolean(aiResponse.text),
    providerOutputLength: String(aiResponse.text || '').length})

  const modelReply = parseWebsiteChatModelReply(aiResponse.text || '', language)
  const replySource = modelReply.replySource || 'fallback'
  const modelRequestedContactCapture = Boolean(modelReply.needsContactCapture)
  const intentRequestedContactCapture = leadSignals.bookingIntent || leadSignals.followUpIntent
  const needsContactCapture = shouldRequestContactCapture({
    leadSignals,
    modelReply
  })
  const suggestedNextAction = resolveWebsiteChatSuggestedAction({
    leadSignals,
    modelReply,
    pageUrl
  })

  logInfo('websiteChatService', 'Website chat model reply parsed', {
    event_key: 'websiteChat.flow',
    sessionId,
    replySource,
    suggestedAction: suggestedNextAction?.type || 'none',
    modelSuggestedAction: modelReply.suggestedAction || 'none',
    modelRequestedContactCapture,
    intentRequestedContactCapture,
    needsContactCapture,
    hasParsedReply: Boolean(modelReply.reply),
    parsedReplyLength: String(modelReply.reply || '').length})

  const baseReply = sanitizeMessage(modelReply.reply || buildDefaultReply(language))
  const followUpChannels: FollowUpChannel[] = []
  const conversationEnded = needsContactCapture && followUpChannels.length > 0
  const closingMessage = conversationEnded ? buildClosingMessage(language, followUpChannels) : null
  const finalReply = sanitizeMessage(closingMessage || baseReply)
  const workflowPolicy = evaluateSofiaPolicyDecision({
    identity: workflowIdentity,
    memory: workflowMemory,
    draftResponseText: finalReply
  })
  await createSofiaWorkflowAuditEvent({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    eventType: 'policy_checked',
    eventSummary: 'Policy checkpoint evaluated external website chat response',
    metadata: {
      entryPoint: 'external_website_chat',
      policyStatus: workflowPolicy.status,
      requiresHumanHandoff: workflowPolicy.requiresHumanHandoff
    }
  })
  if (workflowPolicy.requiresHumanHandoff) {
    await createSofiaWorkflowAuditEvent({
      envelope: workflowEnvelope,
      identity: workflowIdentity,
      eventType: 'human_handoff_requested',
      eventSummary: 'Policy checkpoint requested human handoff',
      metadata: {
        entryPoint: 'external_website_chat',
        policyStatus: workflowPolicy.status,
        requiresHumanHandoff: true
      },
      sensitivity: 'medium'
    })
  }
  const workflowPersona = createSofiaPersonaGuidance({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    memory: workflowMemory,
    policy: workflowPolicy
  })
  const workflowResponse = composeSofiaResponse({
    envelope: workflowEnvelope,
    policy: workflowPolicy,
    persona: workflowPersona,
    responseText: finalReply,
    shouldEndInteraction: conversationEnded
  })
  await createSofiaWorkflowAuditEvent({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    eventType: 'response_composed',
    eventSummary: 'Response composer completed for external website chat',
    metadata: {
      entryPoint: 'external_website_chat',
      responseComposed: true,
      policyStatus: workflowPolicy.status
    }
  })
  const composedFinalReply = sanitizeMessage(workflowResponse.text)

  logInfo('websiteChatService', 'Website chat reply assembled', {
    event_key: 'websiteChat.flow',
    sessionId,
    replySource,
    pricingRequestDetected: leadSignals.asksPricing,
    baseReplyLength: baseReply.length,
    finalReplyLength: composedFinalReply.length,
    suggestedAction: suggestedNextAction?.type || 'none'})

  const assistantMessage = createChatMessage('assistant', composedFinalReply)
  const finalConversation = [...userConversation, assistantMessage]
  const sofiaCoreOutput = mapWebsiteChatOutputToSofiaCoreOutput({
    orgId: WEBSITE_CHAT_ORG_ID,
    sessionId,
    requestId: traceId,
    reply: composedFinalReply,
    needsContactCapture,
    conversationEnded,
    metadata: {
      helpdeskMatchCount: helpdeskMatches.length,
      leadHandoffCreated: false
    }
  })
  void sofiaCoreOutput

  const conversationContext: ConversationContext = {
    ...preModelContext,
    lastAssistantReplyAt: assistantMessage.createdAt,
    lastModel: aiResponse.model || null,
    lastSuggestedAction: suggestedNextAction?.type || null,
    lastHelpDeskTitles: helpdeskMatches.map((match) => match.title),
    lastReplySource: replySource,
    lastModelFallbackUsed: Boolean(aiResponse.fallbackUsed),
    liveChatEnded: conversationEnded,
    followUpChannels,
    closingMessage}

  visitor = await saveWebsiteVisitorConversation({
    sessionId,
    aiConversation: finalConversation,
    pagesVisited,
    conversationContext,
    email: effectiveContact.email,
    name: effectiveContact.name,
    phone: effectiveContact.phone,
    language,
    currentPageContext,
    bookingRequested: null})

  await recordMarketingVisitorAttribution({
    visitorId,
    marketingSessionId: typeof input.attribution?.marketing_session_id === 'string'
      ? input.attribution.marketing_session_id
      : null,
    chatSessionId: sessionId,
    eventName: 'chat_message_sent',
    sourceFlow: 'chat',
    attribution: input.attribution || null,
    pagePath,
    referrer: typeof input.attribution?.referrer === 'string' ? input.attribution.referrer : null,
  })
  if (effectiveContact.email || effectiveContact.phone) {
    await recordMarketingVisitorAttribution({
      visitorId,
      marketingSessionId: typeof input.attribution?.marketing_session_id === 'string'
        ? input.attribution.marketing_session_id
        : null,
      chatSessionId: sessionId,
      eventName: 'chat_contact_info_detected',
      sourceFlow: 'chat',
      attribution: input.attribution || null,
      pagePath,
      referrer: typeof input.attribution?.referrer === 'string' ? input.attribution.referrer : null,
    })
  }

  const leadHandoffCreated = false
  await createSofiaWorkflowAuditEvent({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    eventType: 'response_sent',
    eventSummary: 'External website chat response sent',
    metadata: {
      entryPoint: 'external_website_chat',
      model: aiResponse.model || 'unknown',
      latencyMs: Date.now() - startedAt,
      visitorKnown: Boolean(visitor.email || visitor.name || visitor.phone),
      leadHandoffCreated
    }
  })
  await completeSofiaWorkflowSessionTrace({
    envelope: workflowEnvelope,
    identity: workflowIdentity,
    finalStatus: 'completed',
    humanHandoff: false,
    summary: 'Response sent successfully',
    metadata: {
      entryPoint: 'external_website_chat',
      policyStatus: workflowPolicy.status,
      model: aiResponse.model || 'unknown',
      latencyMs: Date.now() - startedAt,
      leadHandoffCreated
    }
  })
  await persistSofiaMemoryCandidates({
    envelope: workflowEnvelope,
    identity: {
      ...workflowIdentity,
      contactId: workflowIdentity.contactId || null,
      trustLevel: workflowIdentity.trustLevel
    },
    policy: workflowPolicy,
    response: workflowResponse,
    summary: conversationEnded
      ? 'Website chat ended with follow-up and potential handoff.'
      : 'Website chat response delivered.',
    metadata: {
      bookingIntent: leadSignals.bookingIntent,
      serviceInterest: leadSignals.asksPricing,
      callbackRequested: false,
      requiresHumanHandoff: workflowPolicy.requiresHumanHandoff
    }
  })
  emitConectaVokerEvent({
    agentKey: 'website_chat',
    channel: 'website_chat',
    direction: 'sofia',
    orgId: WEBSITE_CHAT_ORG_ID,
    visitorId,
    sessionId,
    conversationId: sessionId,
    entryPoint: 'external_website_chat',
    pipeline: 'website_chat',
    outputText: composedFinalReply,
    modelName: aiResponse.model || null,
    latencyMs: Date.now() - startedAt,
    outcome: 'success',
    metadata: {
      pagePath,
      language,
      hasContactInfo: Boolean(effectiveContact.email || effectiveContact.phone || effectiveContact.name),
      replySource,
      helpdeskMatchCount: helpdeskMatches.length,
      needsContactCapture,
      conversationEnded
    }
  })

  logInfo('websiteChatService', 'Website chat reply generated', {
    event_key: 'websiteChat.flow',
    sessionId,
    orgId: WEBSITE_CHAT_ORG_ID,
    replySource,
    aiProvider: aiResponse.provider,
    aiModel: aiResponse.model,
    aiFallbackUsed: Boolean(aiResponse.fallbackUsed),
    pricingRequestDetected: leadSignals.asksPricing,
    helpDeskMatches: helpdeskMatches.length,
    aiConversationLength: Array.isArray(visitor.ai_conversation) ? visitor.ai_conversation.length : undefined,
    helpDeskTitles: helpdeskMatches.map((match) => match.title)})

  await Promise.resolve(logInfo('alert_log', 'Website chat flow', {
    sessionId,
    language,
    pagePath,
    pageTitle,
    inputLength: message.length,
    helpdeskMatchCount: helpdeskMatches.length,
    helpdeskTitles: helpdeskMatches.map((match) => match.title),
    helpdeskTopicTypes: helpdeskMatches.map((match) => match.topicType || null),
    helpdeskAudiences: helpdeskMatches.map((match) => match.audience || null),
    helpdeskVisibilities: helpdeskMatches.map((match) => match.visibility || null),
    replySource,
    suggestedAction: suggestedNextAction?.type || null,
    pricingRequestDetected: leadSignals.asksPricing,
    conversationEnded,
    followUpChannels,
    finalReplyLength: composedFinalReply.length,
    aiProvider: aiResponse.provider,
    aiModel: aiResponse.model,
    aiFallbackUsed: Boolean(aiResponse.fallbackUsed)})).catch(() => undefined)

  return {
    reply: composedFinalReply,
    response: composedFinalReply,
    sessionId,
    suggestedNextAction,
    needsContactCapture,
    conversationEnded,
    followUpChannels,
    closingMessage}
}
