// server.refactored.js - Clean refactored server entry point
// Runtime env is loaded by bootstrap.js before this file.

const runtimeDbUrl = process.env.DATABASE_URL
const CLIENT_URL = (process.env.CLIENT_URL || '').trim()
if (!CLIENT_URL) {
  throw new Error('Missing required environment variable: CLIENT_URL')
}
if (
  process.env.NODE_ENV !== 'development' &&
  /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(CLIENT_URL)
) {
  throw new Error(`CLIENT_URL cannot point to localhost: ${CLIENT_URL}`)
}
const databaseUrlSource = runtimeDbUrl ? 'runtime' : 'missing'

import express from 'express'
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import http from 'http'
import type { IncomingMessage } from 'http'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
// WebSocket setup moved to websockets/index.js
import { setupWebSockets } from './websockets/index.js'
// import { sendMagicLinkNotification } from "./services/notifications/notificationService.js"; // Removed - was causing duplicate emails

// Import URL config validation (must be after dotenv loads)
import { validateUrlConfig } from './config/urlConfig.js'

// Middleware
import authMiddleware, { machineAuthMiddleware } from './middleware/auth.ts'
import { adminAuthMiddleware } from './middleware/adminAuth.ts'
import { impersonationMiddleware } from './middleware/impersonation.ts'
import { orgContextMiddleware } from './middleware/orgContext.ts'
import { loadUserContext } from './middleware/userContext.ts'
import {
  buildGenericOperationName,
  getRequestPathForContext,
  requestContextMiddleware,
  updateRequestContext,
} from './utils/requestContextStore.js'
import { jsonErrorHandler, validateJsonContentType } from './middleware/jsonErrorHandler.js'
import {
  validateCommonParams,
  validatePagination,
  sanitizeRequestBody,
} from './middleware/validationMiddleware.js'
import { applyCorsHeaders, getAllowedOrigins, isAllowedOrigin } from './utils/corsOrigins.js'
import { serviceErrorHandler } from './middleware/serviceErrorHandler.js'
import {
  externalApiErrorHandler,
  checkExternalServicesHealth,
} from './middleware/externalApiHandler.js'
import { handleExternalWebhook } from './middleware/providerRouter.js'
import { globalErrorHandler } from './middleware/globalErrorHandler.js'
import { databaseErrorHandler } from './middleware/databaseErrorHandler.js'
import { formsStrictErrorMiddleware } from './middleware/formsStrictErrorMiddleware.js'
import {
  startCommunicationWorker,
  stopCommunicationWorker,
} from './services/messaging/communicationWorkerService.ts'
import { cronAuth } from './middleware/cronAuth.ts'
import { createRateLimiter } from './middleware/rateLimiter.ts'
import { logInfo, logWarn, logError } from './utils/logger.js'

const CORS_ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'x-requested-with',
  'accept',
  'x-ui-token',
  'x-org-id',
  'x-firebase-id-token',
  'x-impersonation-token',
  'x-debug-request-id',
  'x-request-id',
  'x-ui-page',
  'x-page-context',
  'x-internal-key',
  'x-voice-internal-key',
  'x-trace-id',
  'x-conecta-test-run-id',
  'x-conecta-candidate-id',
  'x-conecta-test-mode',
  'x-conecta-workflow',
  'cache-control',
  'x-sofia-client',
  'x-sofia-session',
  'baggage',
  'traceparent',
  'tracestate',
  'x-datadog-origin',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
  'x-datadog-trace-id',
].join(',')

type HeaderValue = string | string[] | undefined

type OperationContext = {
  context_type?: string
  operation_name?: string
  route_name?: string | null
  background_job_name?: string
  webhook_name?: string
}

type InitializerLoader = () => Promise<() => void>

type StartupStep<T> = () => Promise<T> | T

type ServerRouteHandler = (req: Request, res: Response, next: NextFunction) => unknown

type RetiredTelemetryPayload = {
  body_type: string
  body_keys: string[]
  body_length: number
  body_hash: string
}

declare function sendCorsIssueToDiscord(
  issueType: string,
  details: Record<string, unknown>,
  severity: string,
): Promise<void>

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined
}

function toErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function normalizeHeaderValue(value: HeaderValue): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  return raw
}

function getQueryString(value: Request['query'][string]): string | null {
  return typeof value === 'string' ? value : null
}

function getRequestFromParser(req: IncomingMessage): Request {
  return req as Request
}

// Routes
import indexRoutes from './routes/index.js'
import contactsRoutes from './routes/contacts.ts'
import messagesRoutes from './routes/messages.ts'
import workflowAssetsRoutes from './routes/workflowAssets.js'
import workflowDocumentsRoutes from './routes/workflowDocuments.ts'
import workflowsRoutes from './routes/workflows.ts'
import workflowTemplatesRoutes from './routes/workflowTemplates.ts'
import v1WorkflowsRoutes from './routes/v1Workflows.ts'
import emailTextBlastRoutes from './routes/emailTextBlast.ts'
import blastAndWorkflowDraftsRoutes from './routes/blastAndWorkflowDrafts.ts'
import blastAndWorkflowTemplatesRoutes from './routes/blastAndWorkflowTemplates.ts'
import tagsRoutes from './routes/tags.js'
import internalLobbyResetRoutes from './routes/internalLobbyReset.ts'
import lobbyQueueRoutes from './routes/lobbyQueue.ts'
import opportunitiesRoutes from './routes/opportunities.ts'
import notificationsRoutes from './routes/notifications.js'
import provisionRoutes from './routes/provision.ts'
import {
  createAccountStepLog as createAccountStepLogHandler,
  createRecoveryRequest as createRecoveryRequestHandler,
  provisionN8nFreeTrial as provisionN8nFreeTrialHandler,
} from './controllers/provisionController.ts'
import usersRoutes from './routes/users.js'
import userManagementRoutes from './routes/userManagement.js'
import orgRoutes from './routes/orgs.js'
import settingsRoutes from './routes/settings.js'
import uiPreferencesRoutes from './routes/uiPreferences.ts'
import smsCreditsRoutes from './routes/smsCredits.js'
import emailDomainSetupRoutes from './routes/emailDomainSetup.ts'
import onboardingRoutes from './routes/onboarding.js'
import orgGetStartedRoutes from './routes/orgGetStarted.ts'
import documentRequestRoutes from './routes/documentRequests.ts'
import documentRequestPacketRoutes from './routes/documentRequestPackets.ts'
import clientAuthRoutes from './routes/client/auth.ts'
import clientPortalRoutes from './routes/client/portal.ts'
import folderRoutes from './routes/folders.ts'
import unsubscribeController from './controllers/unsubscribeController.js'
import internalConversationsRoutes from './routes/internalConversations.ts'
import internalBlastTasksRoutes from './routes/internalBlastTasks.ts'
import teamRoutes from './routes/team.ts'
import partnerPortalsRoutes from './routes/partnerPortals.ts'
import partnerReferralsRoutes from './routes/partnerReferrals.ts'
import inboxRoutes from './routes/inbox.ts'
import tasksPageRoutes, { validateTasksPageRequestShape } from './routes/tasksPage.ts'
import phoneCallsRoutes from './routes/phoneCalls.ts'
import phoneUserExtensionsRoutes from './routes/phoneUserExtensions.ts'
import internalPhonePresenceRoutes from './routes/internalPhonePresence.ts'
import resolutionCasesRoutes from './routes/resolutionCases.ts'
import bookingsPageRoutes from './routes/bookingsPage.ts'
import businessesPageRoutes from './routes/businessesPage.ts'
import sesWebhookRoutes from './routes/ses-webhooks.js'
import blastAnalyticsRoutes from './routes/blastAnalytics.ts'
import messageAnalyticsRoutes from './routes/messageAnalytics.ts'
// Removed: legacy non-Connect Stripe purchase routes
import bookingRoutes from './routes/bookings.ts'
import blogPostsRoutes from './routes/blogPosts.ts'
import newsletterRoutes from './routes/newsletter.js'
import websiteFormRoutes from './routes/websiteForm.js'
import websiteChatRoutes from './routes/websiteChat.ts'
import marketingLiveChatRoutes from './routes/marketingLiveChat.ts'
import publicRoutes from './routes/public.js'
import pseoPublicRoutes from './routes/pseoPublic.js'
import directoryRoutes from './routes/directory.ts'
import imageUploadRoutes from './routes/imageUpload.ts'
import babyLeoncitoPhotosRoutes from './routes/babyLeoncitoPhotos.ts'
import sitemapRoutes from './routes/sitemap.js'
import leadsWebhookRoutes from './routes/leadsWebhook.ts'
import adminRoutes from './routes/admin.ts'
import devTestRoutes from './routes/dev-script.ts'
import openaiRoutes from './routes/openai.js'
import dependentsRoutes from './routes/dependents.ts'
import aiReadRoutes from './routes/aiRead.ts'
import timeContextRoutes from './routes/timeContext.js'
import helpDeskRoutes from './routes/helpDesk.ts'
import emailEventsRoutes from './routes/emailEvents.ts'
import integrationsRoutes from './routes/integrations.js'
import googleBusinessProfileController from './controllers/googleBusinessProfileController.js'
import websocketEventsRoutes from './routes/websocketEvents.js'
import mcpRoutes from './routes/mcp.ts'
import mcpWellKnownRoutes from './routes/mcpWellKnown.ts'
import paymentPlanRequestsRoutes from './routes/paymentPlanRequests.ts'
import billingRoutes from './routes/billing.ts'
import stripeRoutes from './routes/stripe.ts'
import publicStripeCheckoutRoutes from './routes/publicStripeCheckout.js'
import stripeConnectWebhookRoutes from './routes/stripeConnectWebhook.js'
import infobipWebhooksRoutes from './routes/infobipWebhooks.ts'
import infobipMmsWebhookRoutes from './routes/infobipMmsWebhook.ts'
import infobipVoiceGatewayRoutes from './routes/infobipVoiceGateway.ts'
import customFieldsRoutes from './routes/customFields.ts'
import customTypesRoutes from './routes/customTypes.ts'
import zoomIntegrationPublicRoutes from './routes/zoomIntegrationPublic.js'
import publicCheckinRoutes from './routes/publicCheckin.js'
import eventsRoutes from './routes/events.ts'
import householdsRoutes from './routes/households.ts'
import importsRoutes from './routes/imports.ts'
import signRoutes from './routes/sign.js'
import cronRoutes from './routes/cronRoutes.ts'
import scheduledMessagesRoutes from './routes/scheduledMessages.ts'
import esignEnvelopesRoutes from './routes/esignEnvelopes.ts'
import searchRoutes from './routes/search.js'
import formsRoutes from './routes/formsRoutes.ts'
import * as formsController from './controllers/forms/index.ts'
import * as formsIngestController from './controllers/formsIngestController.ts'
import wsTicketRoutes from './routes/wsTicket.js'
import queryApiRoutes from './routes/queryApi.ts'
import sofiaRoutes from './routes/sofia.ts'
import sofiaToolRoutes from './sofia/tools/sofiaToolRoutes.ts'
import agentRoutes from './routes/agent.ts'
import sheetsRoutes from './routes/sheets.js'
import driveRoutes from './routes/drive.ts'
import rssCraigslistRouter from './routes/rssCraigslist.js'

// External API Provider Routes
import awsRoutes from './external-routes/providers/aws/external-routes.js'
import { handleInboxEmailIngestion } from './external-routes/providers/aws/inboxIngestionController.js'
import aiBoardRoutes from './external-routes/providers/ai-board/external-routes.js'

// Note: Client portal routes are inline below (magic link auth, profile, messages, logout)

// ----- Config -----
const app = express()

const API_BASE = process.env.API_BASE || 'https://api.holaconecta.com'

// Request ID middleware (must run before routes)
app.use((req, res, next) => {
  const headerRequestId = normalizeHeaderValue(req.headers['x-request-id'])
  const headerTraceId = normalizeHeaderValue(req.headers['x-trace-id'])
  const requestId =
    req.requestId || headerRequestId || headerTraceId || crypto.randomUUID()
  const requestPath = getRequestPathForContext(req)
  const normalizeTestHeader = (value: HeaderValue) => {
    const raw = normalizeHeaderValue(value)
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed ? trimmed.slice(0, 120).replace(/[^a-zA-Z0-9_.:-]/g, '_') : null
  }
  const testRunId = normalizeTestHeader(req.headers['x-conecta-test-run-id'])
  const candidateId = normalizeTestHeader(req.headers['x-conecta-candidate-id'])
  const testMode = normalizeTestHeader(req.headers['x-conecta-test-mode'])
  const workflow = normalizeTestHeader(req.headers['x-conecta-workflow'])
  const isCrashLabRequest = Boolean(testRunId || candidateId || testMode || workflow)
  req.requestId = requestId
  req.request_id = req.requestId
  req.testRunId = testRunId
  req.candidateId = candidateId
  req.testMode = testMode
  req.workflow = workflow
  req.isCrashLabRequest = isCrashLabRequest
  req.context_type = req.context_type || 'request'
  req.operation_name = req.operation_name || buildGenericOperationName(req.method, requestPath)
  req.route_name = req.route_name || null
  res.setHeader('X-Request-Id', requestId)
  res.setHeader('X-Trace-Id', requestId)
  res.locals.requestId = requestId
  res.locals.request_id = requestId
  res.locals.context_type = req.context_type
  res.locals.operation_name = req.operation_name
  res.locals.testRunId = testRunId
  res.locals.candidateId = candidateId
  res.locals.testMode = testMode
  res.locals.workflow = workflow
  res.locals.isCrashLabRequest = isCrashLabRequest
  next()
})

app.use(requestContextMiddleware)

function applyNamedOperationContext(context: OperationContext): RequestHandler {
  return (req, res, next) => {
    if (context.context_type) req.context_type = context.context_type
    if (context.operation_name) req.operation_name = context.operation_name
    if (context.route_name) req.route_name = context.route_name
    if (context.background_job_name) req.background_job_name = context.background_job_name
    if (context.webhook_name) req.webhook_name = context.webhook_name
    if (context.context_type) res.locals.context_type = context.context_type
    if (context.operation_name) res.locals.operation_name = context.operation_name
    if (context.route_name) res.locals.route_name = context.route_name
    if (context.background_job_name) res.locals.background_job_name = context.background_job_name
    if (context.webhook_name) res.locals.webhook_name = context.webhook_name
    updateRequestContext(context)
    next()
  }
}

// Trust proxy for accurate IP addresses (Fly/Cloudflare)
app.set('trust proxy', 1)

const _ALLOWED_ORIGINS = getAllowedOrigins()

// Special handling for public booking API endpoints - allow requests from app.holaconecta.com
// even if origin is missing (for bot requests)
const PUBLIC_BOOKING_ENDPOINTS = ['/api/bookings/events/public', '/api/bookings/team/public']

const RETIRED_NOISE_ENDPOINTS = new Set(['/.well-known/appspecific/com.chrome.devtools.json'])

// Function to check if origin is allowed (including wildcards)
function isOriginAllowed(origin: string) {
  return isAllowedOrigin(origin)
}

// ----- Security Headers Middleware -----
function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Set permissions policy to allow browser extensions to work properly
  res.setHeader('Permissions-Policy', 'unload=*')

  // No active Server-Sent Event endpoints; add handling here if reintroduced.
  next()
}
app.use(securityHeaders)

// ----- CORS Middleware -----
// This middleware handles CORS (Cross-Origin Resource Sharing) for all requests.
// It logs to Discord only for actual CORS problems:
// - Blocked requests (disallowed origins) - logged as warnings
// - CORS middleware errors - logged as critical
// Normal operations (OPTIONS preflight, allowed requests) are not logged as they're expected behavior
app.use(async (req, res, next) => {
  try {
    const origin = req.headers.origin

    // Debug logging for booking routes (only in development)
    if (req.path.startsWith('/booking/') && process.env.NODE_ENV === 'development') {
    }

    // Skip CORS validation for health check endpoints and webhooks (called by external services)
    // Check both req.path (relative) and req.originalUrl (full path) to catch mounted routes
    const isWebhookRoute =
      req.path.startsWith('/webhook/') ||
      req.originalUrl.startsWith('/webhook/') ||
      req.url.startsWith('/webhook/')
    if (
      req.path.startsWith('/health') ||
      isWebhookRoute ||
      req.path.startsWith('/ses-webhooks') ||
      req.path.startsWith('/api/test/') ||
      req.path.startsWith('/test/')
    ) {
      // For webhook routes, set CORS headers to allow all origins (they're public endpoints)
      if (isWebhookRoute && origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      } else if (isWebhookRoute) {
        // No origin header, allow all
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      }

      // Handle OPTIONS preflight for webhook routes
      if (isWebhookRoute && req.method === 'OPTIONS') {
        return res.status(204).end()
      }

      return next()
    }

    const isPublicBookingEndpoint =
      PUBLIC_BOOKING_ENDPOINTS.some((ep) => req.path.startsWith(ep)) ||
      /^\/api\/bookings\/[^/]+\/(events\/public|team\/public|team\/[^/]+\/available-slots|settings\/public|custom-fields\/public|booking-status\/[^/]+|book-public|event\/[^/]+\/resolve)$/.test(
        req.path
      )
    const isPublicStaticRoute = req.path.startsWith('/public/') || req.path === '/booking-widget.js'
    const isMcpRoute =
      req.path.startsWith('/mcp/master/') || req.originalUrl.startsWith('/mcp/master/')
    const isPublicCorsRoute =
      isPublicStaticRoute ||
      req.path.startsWith('/api/forms/public/') ||
      req.path.startsWith('/api/website-form/') ||
      req.path.startsWith('/api/website-chat') ||
      req.path.startsWith('/api/marketing/live-chat') ||
      req.path.startsWith('/api/stripe/create-checkout-session') ||
      req.path.startsWith('/api/stripe/create-sofia-checkout-session') ||
      req.path.startsWith('/api/make-offer-requests') ||
      req.path.startsWith('/api/public/') ||
      req.path.startsWith('/api/baby-leoncito/photos') ||
      req.path === '/api/directory/highlights' ||
      req.path.startsWith('/api/blog-posts') ||
      isPublicBookingEndpoint ||
      isMcpRoute

    // Special handling for public routes - allow CORS from ANY origin (public endpoints)
    // These routes are designed to be accessed from any website (e.g., public forms, embeds, booking widgets)
    if (isPublicCorsRoute) {
      // Set CORS headers for public routes - allow any origin
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)

      // Handle OPTIONS preflight for public routes
      if (req.method === 'OPTIONS') {
        return res.status(204).end()
      }

      return next()
    }

    // Handle OPTIONS preflight requests FIRST - they need CORS headers to work
    if (req.method === 'OPTIONS') {
      // Set CORS headers for OPTIONS if origin is allowed
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
        return res.status(204).end()
      } else if (!origin) {
        // Allow OPTIONS without origin (some clients don't send origin in preflight)
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
        return res.status(204).end()
      } else {
        // Origin provided but not allowed - log and block
        logWarn('cors-middleware', 'OPTIONS preflight blocked by CORS policy', {
          route: req.path,
          method: req.method,
          origin,
        })

        // Only log actual CORS problems (blocked requests) as warnings
        sendCorsIssueToDiscord(
          'OPTIONS_BLOCKED',
          {
            summary: `OPTIONS preflight BLOCKED - disallowed origin: ${origin}`,
            blockedOrigin: origin,
            reason: 'Origin not in allowed list',
            accessControlRequestMethod: req.headers['access-control-request-method'],
            accessControlRequestHeaders: req.headers['access-control-request-headers'],
          },
          'warning'
        ).catch((err: unknown) =>
          logWarn('cors-middleware', 'Failed to report blocked OPTIONS request', {
            error: toErrorMessage(err),
            route: req.path,
            method: req.method,
          })
        )

        // Don't set Access-Control-Allow-Origin for disallowed origins
        // This will cause browser to block the actual request
        return res.status(403).json({ error: 'CORS policy violation', origin: origin })
      }
    }

    // Allow requests without origin for client endpoints and booking routes (served directly from server)
    if ((req.path.startsWith('/client/') || req.path.startsWith('/booking/')) && !origin) {
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      return next()
    }

    if (!origin || origin === 'null') {
      // Allow requests without origin or with 'null' origin (direct server requests, Postman, browser console, etc.)
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      next()
    } else if (isOriginAllowed(origin)) {
      // Normal allowed requests are not logged - they're expected behavior
      // Only log actual CORS problems (blocked requests)
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
      next()
    } else {
      // Origin provided but not allowed - log and block
      logWarn('cors-middleware', 'Request blocked by CORS policy', {
        route: req.path,
        method: req.method,
        origin,
      })

      return res.status(403).json({ error: 'CORS policy violation', origin: origin })
    }
  } catch (corsError) {
    // If CORS middleware itself fails, log to Discord and allow request to continue
    // (fail open to prevent CORS middleware bugs from breaking the entire app)
    logError('cors-middleware', 'CORS middleware error', corsError, {
      route: req.originalUrl || req.url,
      method: req.method,
    })
    // CRITICAL: Set CORS headers even on error to prevent browser blocking
    // This ensures requests can proceed even if CORS middleware has issues
    const origin = req.headers.origin
    if (origin && isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
    }

    // Handle OPTIONS preflight even on error
    if (req.method === 'OPTIONS') {
      return res.status(204).end()
    }

    // Continue with request (fail open)
    next()
  }
})

// ----- Compression Middleware -----
app.use(
  compression({
    level: 6, // Compression level (1-9, 6 is good balance)
    threshold: 1024, // Only compress files larger than 1KB
    filter: (req, res) => {
      return compression.filter(req, res)
    },
  })
)

// ----- Body Parsers -----
// Text parser for AWS SNS webhooks (they send text/plain)
app.use(
  express.text({
    limit: '2mb',
    type: (req) => {
      const expressReq = getRequestFromParser(req)
      const contentType = (expressReq.headers['content-type'] || '') as string
      const isWebhook =
        expressReq.path.includes('/webhook/aws') || expressReq.path.includes('/ses-webhooks')
      return isWebhook && contentType.includes('text/plain')
    },
  })
)

// CRITICAL: Register webhook routes BEFORE JSON parser to preserve raw body for signature verification
// Stripe Connect webhook route - NO AUTH, called by Stripe
app.use('/stripe', stripeConnectWebhookRoutes)
// Public Stripe Checkout routes for pricing page lead capture and webhooks
app.use('/api/stripe', publicStripeCheckoutRoutes)
// Infobip voice route must be mounted before the generic /webhooks/infobip router.
app.use('/webhooks/infobip/voice', infobipVoiceGatewayRoutes)
// Compatibility sink for a typo in an Infobip callback URL seen in production logs.
// The active Sofia voice event endpoint is /webhooks/infobip/voice/events.
app.post(
  ['/infobio/calls', '/infobio/calls/'],
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res) => {
    logWarn('infobipVoiceGateway', 'Received legacy typo Infobip voice callback', {
      configuredPath: '/infobio/calls/',
      correctPath: '/webhooks/infobip/voice/events',
      method: req.method,
      payloadBytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 120),
      infobipTransactionId:
        req.headers['x-infobip-transaction-id'] || req.headers['x-request-id'] || null,
    })
    res.status(200).json({
      ok: true,
      ignored: true,
      correctPath: '/webhooks/infobip/voice/events',
    })
  }
)
// Infobip WhatsApp Webhook Routes - NO AUTH, called by Infobip
app.use('/webhooks/infobip', infobipWebhooksRoutes)
app.use('/webhooks/infobip/mms', infobipMmsWebhookRoutes)

app.use(
  express.json({
    limit: '10mb', // Increased from 2mb to support logo uploads (max 5MB) + safety margin
    verify: (req, res, buf) => {
      getRequestFromParser(req).rawBody = buf
    },
    type: (req) => {
      const expressReq = getRequestFromParser(req)
      // Skip JSON parsing for webhook endpoints (they need raw body for signature verification)
      const isStripeConnectWebhook =
        expressReq.path === '/stripe/connect-webhook' || expressReq.path === '/stripe/connect-webhook/'
      const isInfobipWebhook =
        expressReq.path === '/webhooks/infobip/whatsapp' ||
        expressReq.path === '/webhooks/infobip/whatsapp/'

      if (isStripeConnectWebhook || isInfobipWebhook) {
        return false // Don't parse JSON for webhook endpoints
      }

      // Skip JSON parsing for multipart/form-data requests
      const contentType = (expressReq.headers['content-type'] || '') as string
      const isJsonContent =
        contentType.includes('application/json') && !contentType.includes('multipart/form-data')
      const isSesWebhook =
        (expressReq.path.includes('/ses-webhooks') || expressReq.path.includes('/webhook/aws')) &&
        contentType.includes('text/plain')
      const shouldParse = isJsonContent && !isSesWebhook // Don't parse JSON if it's a text/plain webhook

      return shouldParse
    },
  })
)
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      getRequestFromParser(req).rawBody = buf
    },
    type: (req) => {
      const expressReq = getRequestFromParser(req)
      // Skip URL encoded parsing for multipart/form-data requests
      const contentType = (expressReq.headers['content-type'] || '') as string
      return (
        contentType.includes('application/x-www-form-urlencoded') &&
        !contentType.includes('multipart/form-data')
      )
    },
  })
)

// ----- JSON Error Handling -----
app.use(jsonErrorHandler)

// ----- Input Validation Middleware -----
app.use(validateJsonContentType)
app.use(sanitizeRequestBody)
app.use(validateCommonParams)
app.use(validatePagination)

// ----- Database Error Handling Middleware -----
// Temporarily disabled due to import issue
// app.use(validateDatabaseOperation);
// app.use(logDatabaseOperation);

app.use(cookieParser())

const LEGACY_ACCESS_LOG_SAMPLE_RATE = Number(process.env.ACCESS_LOG_SAMPLE_RATE || 20)
const ACCESS_LOG_SAMPLE_RATE_DEFAULT = Math.max(
  Number(process.env.ACCESS_LOG_SAMPLE_RATE_DEFAULT || LEGACY_ACCESS_LOG_SAMPLE_RATE || 20),
  1
)
const ACCESS_LOG_SAMPLE_RATE_HIGH_FREQ = Math.max(
  Number(process.env.ACCESS_LOG_SAMPLE_RATE_HIGH_FREQ || 100),
  1
)
const ACCESS_LOG_404_THROTTLE_MS = Number(process.env.ACCESS_LOG_404_THROTTLE_MS || 300000)
const ACCESS_LOG_HIGH_FREQ_4XX_THROTTLE_MIN_MS = 300000

const ACCESS_LOG_HIGH_FREQUENCY_PREFIXES = [
  '/api/ws',
  '/api/analytics/',
  '/api/monitoring/',
  '/api/ws-ticket',
  '/api/user/role',
  '/api/user/organizations',
  '/api/lobby-queue',
  '/api/internal-conversations',
  '/api/internal-messages',
]

const ACCESS_LOG_ERROR_THROTTLE_MS = Number(process.env.ACCESS_LOG_ERROR_THROTTLE_MS || 60000)
const ACCESS_LOG_ERROR_THROTTLE_OVERRIDES = [
  { prefix: '/api/user/role', throttleMs: 300000 },
  { prefix: '/api/user/organizations', throttleMs: 300000 },
  { prefix: '/api/ws-ticket', throttleMs: 300000 },
]

function getRequestPathForLogging(req: Request) {
  const rawPath = req.originalUrl || req.url || req.path || ''
  const queryIndex = rawPath.indexOf('?')
  return queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath
}

function isAccessLogExcludedPath(pathname: string) {
  if (!pathname) return false
  if (pathname === '/health' || pathname === '/healthz' || pathname.startsWith('/health/'))
    return true
  return false
}

function isHighFrequencyPath(pathname: string) {
  if (/^\/api\/[^/]+\/stream/.test(pathname)) return true
  return ACCESS_LOG_HIGH_FREQUENCY_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function shouldSampleAccessLog(pathname: string, statusCode: number) {
  if (statusCode >= 400) return false
  const sampleRate = isHighFrequencyPath(pathname)
    ? ACCESS_LOG_SAMPLE_RATE_HIGH_FREQ
    : ACCESS_LOG_SAMPLE_RATE_DEFAULT
  if (sampleRate <= 1) return false
  return Math.floor(Math.random() * sampleRate) !== 0
}

function shouldSkipAccessLog(req: Request, statusCode: number, pathname: string) {
  if (req.isCrashLabRequest) return false
  if (req._skipAccessLog) return true
  if (req.method === 'OPTIONS') return true
  if (isAccessLogExcludedPath(pathname)) return true
  if (shouldSampleAccessLog(pathname, statusCode)) return true

  return false
}

function getAccessErrorThrottleMs(pathname: string, statusCode: number) {
  if (statusCode === 404) {
    return ACCESS_LOG_404_THROTTLE_MS
  }

  const matched = ACCESS_LOG_ERROR_THROTTLE_OVERRIDES.find((rule) =>
    pathname.startsWith(rule.prefix)
  )
  const baseThrottleMs = matched ? matched.throttleMs : ACCESS_LOG_ERROR_THROTTLE_MS

  // High-frequency 4xx should be heavily throttled to suppress noisy client loops.
  if (statusCode >= 400 && statusCode < 500 && isHighFrequencyPath(pathname)) {
    return Math.max(baseThrottleMs, ACCESS_LOG_HIGH_FREQ_4XX_THROTTLE_MIN_MS)
  }

  // Keep visibility for important 4xx while still deduping repeats.
  if ([401, 403, 409, 422, 429].includes(statusCode)) {
    return baseThrottleMs
  }

  // Remaining 4xx are lower signal and can be throttled more aggressively.
  if (statusCode >= 400 && statusCode < 500) {
    return Math.max(baseThrottleMs, 120000)
  }

  return baseThrottleMs
}

// Canonical request access log: one concise structured line per request.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    const normalizedPath = getRequestPathForLogging(req)
    const statusCode = Number(res.statusCode || 0)
    if (shouldSkipAccessLog(req, statusCode, normalizedPath)) return

    const elapsedNs = process.hrtime.bigint() - startedAt
    const durationMs = Math.max(Number(elapsedNs) / 1e6, 0)
    const errorThrottleMs =
      statusCode >= 400 ? getAccessErrorThrottleMs(normalizedPath, statusCode) : null

    logInfo('http.access', 'request_complete', {
      event_key: 'http.access',
      method: req.method,
      route: req.route?.path
        ? `${req.baseUrl || ''}${req.route.path}`
        : req.path || req.originalUrl || null,
      route_name:
        req.route_name || (req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : null),
      path: normalizedPath,
      statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      requestId: req.requestId || res.locals?.requestId || res.locals?.request_id || null,
      operation_name:
        req.operation_name ||
        res.locals?.operation_name ||
        buildGenericOperationName(req.method, normalizedPath),
      context_type: req.context_type || res.locals?.context_type || 'request',
      testRunId: req.testRunId || res.locals?.testRunId || null,
      candidateId: req.candidateId || res.locals?.candidateId || null,
      testMode: req.testMode || res.locals?.testMode || null,
      workflow: req.workflow || res.locals?.workflow || null,
      isCrashLabRequest: req.isCrashLabRequest === true || res.locals?.isCrashLabRequest === true,
      orgId:
        req.orgId || req.user?.org_id || req.userData?.org_id || req.headers['x-org-id'] || null,
      userId: req.user?.uid || req.userData?.id || null,
      ...(errorThrottleMs
        ? {
            _throttleKey: `http.access.error:${req.method}:${normalizedPath}:${statusCode}`,
            _throttleMs: errorThrottleMs,
          }
        : {}),
    })
  })
  next()
})
app.disable('x-powered-by')

// Retired client telemetry endpoints. Some long-lived or cached clients can
// keep posting these for hours; handle them before auth and fallback routes.
app.all(Array.from(RETIRED_NOISE_ENDPOINTS), (req, res) => {
  req._skipAccessLog = true
  return res.sendStatus(204)
})

// ----- Public Booking Routes -----
// Booking routes are now handled by the Vue app (ui/app)
// The Vue Router handles all /booking/* routes - no backend routes needed

// ----- Static File Serving -----
app.use(express.static('public'))

// ----- Client Portal Routes -----
// Client portal pages are now served by the Vue app (ui/app)
// These routes are handled by Vue Router at /client-login and /client-inbox
// The proxy only handles API endpoints like /api/client/magic-link, /api/client/profile, etc.

// ----- Debug Middleware -----
// Enable debug middleware in development or when DEBUG=true
if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
  logInfo('server', 'Pipeline logging enabled')
}

// ----- Health Checks -----
app.get('/health', (req, res) => res.json({ ok: true }))

// Enhanced /healthz endpoint - validates SES configuration
app.get('/healthz', async (req, res) => {
  try {
    // Import config module - will throw if required vars are missing
    const sesConfig = await import('./config/ses.js')
    const { USE_SES_EMAIL, AWS_SES_REGION, getConfigSummary, getSesAwsCredentials } = sesConfig

    // Try to construct SES client to verify credentials are valid
    if (USE_SES_EMAIL) {
      const { SESClient } = await import('@aws-sdk/client-ses')
      // Create client instance (no external call, just validation)
      new SESClient({
        region: AWS_SES_REGION,
        credentials: getSesAwsCredentials(),
      })

      // Client construction successful - config is valid
      const summary = getConfigSummary()
      return res.status(200).json({
        ok: true,
        status: 'healthy',
        ses: {
          enabled: summary.useSES,
          region: summary.region,
          configurationSet: summary.configurationSet,
          hasDLQ: summary.hasDLQ,
        },
        timestamp: new Date().toISOString(),
      })
    } else {
      // SES disabled but config is present
      return res.status(200).json({
        ok: true,
        status: 'healthy',
        ses: {
          enabled: false,
          message: 'SES email sending is disabled',
        },
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    // Configuration error - return 500
    return res.status(500).json({
      ok: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

app.get('/health/ping', (req, res) => res.json({ pong: true, timestamp: new Date().toISOString() }))

// WebSocket health check
app.get('/health/websocket', (req, res) => {
  const rawProxyBaseUrl = (process.env.PROXY_BASE_URL || '').trim()
  const endpoints = []
  let protocol = null

  if (rawProxyBaseUrl) {
    try {
      const proxyUrl = new URL(rawProxyBaseUrl)
      protocol = proxyUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      proxyUrl.protocol = protocol
      proxyUrl.pathname = '/api/notifications/stream'
      endpoints.push(proxyUrl.toString())
    } catch (_error) {
      return res.status(500).json({
        ok: false,
        websocketEnabled: false,
        error: 'Invalid PROXY_BASE_URL',
        timestamp: new Date().toISOString(),
      })
    }
  }

  res.json({
    ok: true,
    websocketEnabled: true,
    transportProtocol: protocol,
    endpoints,
    timestamp: new Date().toISOString(),
  })
})

// External services health check
app.get('/health/external', async (req, res) => {
  try {
    const healthStatus = await checkExternalServicesHealth()
    res.json(healthStatus)
  } catch (error) {
    logError('health-external', 'Failed to check external services health', error)
    res.status(500).json({
      status: 'error',
      message: 'Failed to check external services health',
      timestamp: new Date().toISOString(),
    })
  }
})

app.get(['/', '/readyz'], (_req, res) => {
  res.type('application/json').send({ ok: true, upstream: API_BASE })
})

// Serve main application UI
app.get('/app', (req, res) => {
  const indexPath = path.resolve('./ui/index.html')
  fs.readFile(indexPath, 'utf8')
    .then((html) => {
      res.type('html').send(html)
    })
    .catch((error) => {
      logError('ui-shell', 'Failed to serve app shell', error)
      res.sendFile('index.html', { root: './ui' })
    })
})

// Serve UI files from ui directory
app.use('/ui', express.static('ui'))

// ===== AWS SES CLICK TRACKING REDIRECT HANDLER =====
// Handles links rewritten by AWS SES configuration set: proxy.holaconecta.com/CL0/{encoded_url}/...
// CloudFront routes /CL0/* paths to this server
app.get('/CL0/*', (req, res) => {
  const correlationId =
    req.requestId || req.headers['x-correlation-id'] || req.headers['x-request-id'] || null
  try {
    const raw = String(((req.params as unknown) as { 0?: string })[0] || '')
    let decoded = raw.trim()

    // Keep decoding until it no longer changes (AWS often double-encodes)
    let previous
    do {
      previous = decoded
      decoded = decodeURIComponent(decoded)
    } while (decoded !== previous && /%[0-9A-F]{2}/i.test(decoded))

    // Check if already has valid protocol - if so, skip protocol fixes
    const hasValidProtocol = /^https?:\/\//i.test(decoded)

    if (!hasValidProtocol) {
      // Normalize protocol errors like https// or missing colon
      decoded = decoded
        .replace(/^https\/\//i, 'https://')
        .replace(/^http\/\//i, 'http://')
        .replace(/^https(?=\w)/i, 'https://')
        .replace(/^http(?=\w)/i, 'http://')

      // If still no valid protocol, add https://
      if (!/^https?:\/\//i.test(decoded)) decoded = 'https://' + decoded
    }

    // Strip AWS tracking junk like =235 and trailing slashes
    decoded = decoded.replace(/=+\d+$/, '').replace(/\/+$/, '')

    // Normalize double slashes in path (but keep https:// protocol)
    // Split on protocol, normalize path, then rejoin
    const protocolMatch = decoded.match(/^(https?:\/\/[^/]+)(.*)$/i)
    if (protocolMatch) {
      const [, protocol, path] = protocolMatch
      const normalizedPath = path.replace(/\/+/g, '/')
      decoded = protocol + normalizedPath
    }

    // Cal.com deep links → trim to base
    const calMatch = decoded.match(/^(https:\/\/cal\.com\/[^/]+\/[^/]+)/i)
    if (calMatch) decoded = calMatch[1]

    // Normalize netaxservicesinc.com → remove excess subpaths or tracking params
    const netaxMatch = decoded.match(/^https:\/\/(www\.)?netaxservicesinc\.com\/tax-school/i)
    if (netaxMatch) decoded = 'https://netaxservicesinc.com/tax-school/'

    // Remove AWS SES tracking path segments (pattern: /number/UUID/token)
    // This matches paths like /1/010f019a4fed17aa-61194eb6-0158-464b-b959-f8e72ef35ed3-000000/NnpqeV3iWKvgnQ63lWxPonQVu40DvS69LFBowsF0Zek
    decoded = decoded.replace(/\/\d+\/[a-f0-9-]+\/[a-zA-Z0-9_-]+$/i, '')

    // Preserve essential query params (like token for magic links) while removing tracking params
    const urlParts = decoded.split('?')
    if (urlParts.length > 1) {
      const queryString = urlParts[1]
      const params = new URLSearchParams(queryString)

      // Keep essential params (token, id, etc.) and remove tracking params (utm_*, ref, etc.)
      const essentialParams = new URLSearchParams()
      for (const [key, value] of params) {
        // Keep essential params that are not tracking-related
        if (!key.match(/^(utm_|ref|source|campaign|medium|gclid|fbclid|_ga|mc_|mc_cid|mc_eid)/i)) {
          essentialParams.append(key, value)
        }
      }

      // Reconstruct URL with preserved essential params
      const preservedQuery = essentialParams.toString()
      decoded = urlParts[0] + (preservedQuery ? `?${preservedQuery}` : '')
    }

    // ✅ Safe but permissive domain check
    const isSafe = /^https:\/\/[a-z0-9][a-z0-9.-]+\.[a-z]{2}(\/.*)?$/i.test(decoded)
    if (!isSafe) {
      logWarn('ses-click-redirect', 'Blocked invalid redirect', { decoded })
      return res.status(400).send('Invalid redirect target')
    }

    return res.redirect(302, decoded)
  } catch (err) {
    logError('[SES-CLICK-REDIRECT]', 'Redirect decode error', err, {
      path: req.path,
      correlationId,
    })
    res.status(400).send('Bad redirect')
  }
})

// ===== CLIENT PORTAL AUTHENTICATION =====
// Magic link authentication routes are now in routes/client/auth.js
// All other client portal routes are now in routes/client/portal.ts

// ===== REFACTORED ROUTES =====

// Helper function to apply auth + impersonation + org context middleware in correct order
// Impersonation middleware must run after auth but before org context
const shouldTraceContactsRequest = (req: Request) => {
  const originalUrl = String(req.originalUrl || req.url || '')
  return originalUrl.startsWith('/api/contacts')
}

const withStageTiming = (stage: string, middleware: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    if (!shouldTraceContactsRequest(req)) {
      return middleware(req, res, next)
    }

    const startedAt = Date.now()
    let completed = false
    const wrappedNext = (err?: unknown) => {
      if (completed) return
      completed = true
      logInfo('contacts.pipeline', 'contacts_pipeline_stage', {
        event_key: 'contacts.pipeline',
        stage,
        method: req.method,
        path: req.originalUrl || req.url || null,
        duration_ms: Date.now() - startedAt,
        requestId: req.requestId || res.locals?.requestId || res.locals?.request_id || null,
        has_error: Boolean(err),
        statusCode: Number(res.statusCode || 0),
      })
      next(err)
    }

    try {
      return middleware(req, res, wrappedNext)
    } catch (error) {
      return wrappedNext(error)
    }
  }
}

const withAuthAndOrg = (routes: RequestHandler) => {
  return [
    withStageTiming('auth', authMiddleware),
    withStageTiming('impersonation', impersonationMiddleware),
    withStageTiming('org_context', orgContextMiddleware),
    routes,
  ]
}

app.use('/api/integrations/zoom', zoomIntegrationPublicRoutes)

// SSE logging stream for real-time log streaming (NO AUTH - public visualization tool)

// Team chat routes (BEFORE catch-all to allow WebSocket)
app.use(
  '/api/internal-conversations',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  internalConversationsRoutes
)
app.use(
  '/api/internal-messages',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  internalConversationsRoutes
)
app.use('/api/team', authMiddleware, impersonationMiddleware, orgContextMiddleware, teamRoutes)

// Environment config endpoint: disabled in production to avoid leaking runtime internals
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/config', (req, res) => {
    res.json({
      debug: process.env.DEBUG === 'true',
      nodeEnv: process.env.NODE_ENV,
    })
  })
}

// Blog routes (public access for GET, auth required for POST/PUT/DELETE)
// Canonical API mount is /api/blog-posts. /blog-flow is a legacy public/admin
// compatibility mount kept only for existing links until callers are migrated.
app.use('/blog-flow', blogPostsRoutes)
app.use('/api/blog-posts', blogPostsRoutes)

// Newsletter routes (public)
app.use('/api/newsletter', newsletterRoutes)

// Website form submission routes (public - no auth required)
app.use('/api/website-form', websiteFormRoutes)
app.use('/api/website-chat', websiteChatRoutes)
app.use('/api/marketing/live-chat', marketingLiveChatRoutes)

// Public config routes (public - no auth required)
// Canonical API mounts are /api/public and /api/public/pseo. The non-/api
// mounts are public URL compatibility aliases for links outside the app shell.
app.use('/public', publicRoutes)
app.use('/api/public', publicRoutes)
app.use('/public/pseo', pseoPublicRoutes)
app.use('/api/public/pseo', pseoPublicRoutes)
app.use('/api/public/checkin', publicCheckinRoutes)

// Unsubscribe route (public - no auth required)
app.post(
  '/api/unsubscribe',
  unsubscribeController.unsubscribe.bind(unsubscribeController) as unknown as RequestHandler,
)

// Directory routes (public - no auth required)
app.use('/api/directory', directoryRoutes)

// Query API routes (API key authentication required)
app.use('/api/query', queryApiRoutes)

// Me routes (current user info) - separate from provision - MUST BE FIRST
const meHandler: RequestHandler = async (req, res) => {
  const { getMe } = await import('./controllers/provisionController.js')
  await getMe(req, res)
}

app.get('/api/me', authMiddleware, meHandler)
app.post('/api/me', authMiddleware, meHandler)

// WebSocket ticket issuance (auth + org context required)
app.use(
  '/api/ws-ticket',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  wsTicketRoutes
)

// Provision routes
// /provision is the unauthenticated public create-account flow mount.
// /api/provision is the authenticated user/org provisioning API.
app.use('/provision', provisionRoutes)
app.post('/api/provision/create-account-step-log', createAccountStepLogHandler)
app.post('/api/provision/recovery-request', createRecoveryRequestHandler)
app.post('/api/provision/n8n-free-trial', provisionN8nFreeTrialHandler)
app.use('/api/provision', authMiddleware, impersonationMiddleware, provisionRoutes)

// Cron routes (external scheduler endpoints)
app.use(
  '/api/cron',
  (req, res, next) => {
    next()
  },
  cronRoutes
)
app.use('/api/scheduled-messages', scheduledMessagesRoutes)

// Job routes (dynamic scheduler endpoints - OIDC protected)
import jobRoutes from './routes/jobRoutes.ts'
app.use('/api/jobs', jobRoutes)
app.use('/api/internal/blasts', internalBlastTasksRoutes)
app.use('/api/internal/phone/presence', internalPhonePresenceRoutes)

// Notification routes (Bell notifications + WebSocket)
app.use(
  '/api/notifications',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  notificationsRoutes
)

// Public make offer flow. Saves a Stripe payment method with SetupIntent; never charges.
app.use('/api/make-offer-requests', paymentPlanRequestsRoutes)

// Billing routes (invoices, payments)
// Canonical API mount is /api/billing. /billing is a compatibility API mount;
// do not add new frontend callers to it.
app.use('/api/billing', ...withAuthAndOrg(billingRoutes))
app.use('/billing', ...withAuthAndOrg(billingRoutes))

// Stripe (authenticated API routes)
app.use('/api/stripe', ...withAuthAndOrg(stripeRoutes))

// Payment Links routes (Stripe Payment Links management)

// User routes (current user profile, role, permissions)
// NOTE: /api/user/organizations doesn't require org context (used to initialize it)
app.use('/api/user', authMiddleware, usersRoutes)

// User management routes (specific user operations)
app.use(
  '/api/users',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  userManagementRoutes
)

// Org routes (team management - read-only list)
app.use('/api/org', authMiddleware, impersonationMiddleware, orgContextMiddleware, orgRoutes)

// Settings routes (organization settings including payment link)
app.use('/api/settings', authMiddleware, settingsRoutes)
app.use('/api/ui-preferences', ...withAuthAndOrg(uiPreferencesRoutes))
app.post(
  '/api/frontend-logs/contacts-table',
  ...withAuthAndOrg((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const frontendLevel = typeof body.level === 'string' ? body.level.trim().toLowerCase() : 'info'
    const route = typeof body.route === 'string' ? body.route : null
    const pathname = typeof body.pathname === 'string' ? body.pathname : null
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? body.context
        : {}

    if (!message.startsWith('contacts_table_')) {
      logWarn(
        'frontend.contacts_table',
        'Rejected unexpected frontend contacts-table log message',
        {
          message,
          route,
          pathname,
          frontendLevel,
          uid: req.user?.uid ?? null,
        }
      )
      return res.status(400).json({ error: 'Invalid contacts table log message' })
    }

    const meta = {
      route,
      pathname,
      frontendLevel,
      frontend_context: context,
      browserPhoneJson: context,
      uid: req.user?.uid ?? null,
      orgId: req.orgId || req.org_id || req.user?.org_id || null,
      userId: req.userId || req.user_id || req.user?.uid || null,
    }

    if (frontendLevel === 'error') {
      logError('frontend.contacts_table', message, new Error(message), meta)
    } else if (frontendLevel === 'warn') {
      logWarn('frontend.contacts_table', message, meta)
    } else {
      // Map browser debug/info to info so they always land in Cloud Run logs.
      logInfo('frontend.contacts_table', message, meta)
    }

    return res.status(204).end()
  })
)

app.post(
  '/api/frontend-logs/app-startup',
  ...withAuthAndOrg((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const frontendLevel = typeof body.level === 'string' ? body.level.trim().toLowerCase() : 'info'
    const route = typeof body.route === 'string' ? body.route : null
    const pathname = typeof body.pathname === 'string' ? body.pathname : null
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? body.context
        : {}

    if (!message.startsWith('app_startup_')) {
      logWarn('frontend.app_startup', 'Rejected unexpected frontend startup log message', {
        message,
        route,
        pathname,
        frontendLevel,
        uid: req.user?.uid ?? null,
      })
      return res.status(400).json({ error: 'Invalid app startup log message' })
    }

    const meta = {
      route,
      pathname,
      frontendLevel,
      frontend_context: context,
      uid: req.user?.uid ?? null,
      orgId: req.orgId || req.org_id || req.user?.org_id || null,
      userId: req.userId || req.user_id || req.user?.uid || null,
    }

    if (frontendLevel === 'error') {
      logError('frontend.app_startup', message, new Error(message), meta)
    } else if (frontendLevel === 'warn') {
      logWarn('frontend.app_startup', message, meta)
    } else {
      logInfo('frontend.app_startup', message, meta)
    }

    return res.status(204).end()
  })
)

app.post(
  '/api/frontend-logs/browser-phone',
  ...withAuthAndOrg((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const frontendLevel = typeof body.level === 'string' ? body.level.trim().toLowerCase() : 'info'
    const route = typeof body.route === 'string' ? body.route : null
    const pathname = typeof body.pathname === 'string' ? body.pathname : null
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? body.context
        : {}

    if (!message.startsWith('[PhoneWebRTC]') && !message.startsWith('phone_webrtc_')) {
      logWarn('frontend.browser_phone', 'Rejected unexpected frontend browser-phone log message', {
        message,
        route,
        pathname,
        frontendLevel,
        uid: req.user?.uid ?? null,
      })
      return res.status(400).json({ error: 'Invalid browser phone log message' })
    }

    const meta = {
      route,
      pathname,
      frontendLevel,
      frontend_context: context,
      uid: req.user?.uid ?? null,
      orgId: req.orgId || req.org_id || req.user?.org_id || null,
      userId: req.userId || req.user_id || req.user?.uid || null,
    }

    if (frontendLevel === 'error') {
      logError('frontend.browser_phone', message, new Error(message), meta)
    } else if (frontendLevel === 'warn') {
      logWarn('frontend.browser_phone', message, meta)
    } else {
      logInfo('frontend.browser_phone', message, meta)
    }

    return res.status(204).end()
  })
)

app.post(
  '/api/frontend-logs/business-esign',
  ...withAuthAndOrg((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const frontendLevel = typeof body.level === 'string' ? body.level.trim().toLowerCase() : 'info'
    const route = typeof body.route === 'string' ? body.route : null
    const pathname = typeof body.pathname === 'string' ? body.pathname : null
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? body.context
        : {}

    if (!message.startsWith('business_esign_')) {
      logWarn(
        'frontend.business_esign',
        'Rejected unexpected frontend business e-sign log message',
        {
          message,
          route,
          pathname,
          frontendLevel,
          uid: req.user?.uid ?? null,
        }
      )
      return res.status(400).json({ error: 'Invalid business e-sign log message' })
    }

    const meta = {
      route,
      pathname,
      frontendLevel,
      frontend_context: context,
      uid: req.user?.uid ?? null,
      orgId: req.orgId || req.org_id || req.user?.org_id || null,
      userId: req.userId || req.user_id || req.user?.uid || null,
    }

    if (frontendLevel === 'error') {
      logError('frontend.business_esign', message, new Error(message), meta)
    } else if (frontendLevel === 'warn') {
      logWarn('frontend.business_esign', message, meta)
    } else {
      logInfo('frontend.business_esign', message, meta)
    }

    return res.status(204).end()
  })
)

// SMS Credits routes
app.use('/api/sms-credits', smsCreditsRoutes)
app.use('/api/onboarding', authMiddleware, impersonationMiddleware, onboardingRoutes)
app.use('/api/get-started', orgGetStartedRoutes)
app.use('/api/email-domain', emailDomainSetupRoutes)
app.use('/api/email-events', emailEventsRoutes)

// Custom Types routes (organization-specific client/lead types)
app.use('/api/custom-types', authMiddleware, customTypesRoutes)

// Booking routes (native booking system)
app.use('/api/bookings', bookingRoutes)

// Index page routes
app.use('/api/index', authMiddleware, impersonationMiddleware, orgContextMiddleware, indexRoutes)

// Partner portal routes
app.use('/api/partner-portals', ...withAuthAndOrg(partnerPortalsRoutes))
app.use('/api/partner-referrals', ...withAuthAndOrg(partnerReferralsRoutes))

// Inbox page routes (page-specific pipeline, requires org context)
app.use('/api/inbox', ...withAuthAndOrg(inboxRoutes))

// Note: Direct inbox email sending moved to inbox routes for proper pipeline handling

// Tasks page routes (page-specific pipeline, requires org context)
app.use('/api/tasks-page', validateTasksPageRequestShape, ...withAuthAndOrg(tasksPageRoutes))
// Canonical phone API prefix is /api/phone. User-extension and call-history
// routers share the prefix because their subpaths are disjoint.
app.use('/api/phone', ...withAuthAndOrg(phoneUserExtensionsRoutes))
app.use('/api/phone', ...withAuthAndOrg(phoneCallsRoutes))
app.use('/api/resolution-cases', ...withAuthAndOrg(resolutionCasesRoutes))

app.use(
  '/api/businesses-page',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  businessesPageRoutes
)

// Bookings page routes (page-specific pipeline)
app.use(
  '/api/bookings-page',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  bookingsPageRoutes
)

// SIMPLE NO-AUTH TEST ENDPOINT
app.get('/api/simple-tasks', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Simple endpoint working', tasks: [] })
  } catch (error) {
    logError('server.test', 'Simple no-auth endpoint error', error)
    res.status(500).json({ ok: false, error: toErrorMessage(error) })
  }
})

// Contact routes
// Machine-auth contact requests must terminate before the authenticated mount below,
// otherwise they fall through and get rejected for missing Bearer auth.
app.use('/api/contacts', (req, res, next) => {
  if (!shouldTraceContactsRequest(req)) {
    return next()
  }

  const startedAt = Date.now()
  res.on('finish', () => {
    logInfo('contacts.pipeline', 'contacts_request_finished', {
      event_key: 'contacts.pipeline',
      stage: 'request_total',
      method: req.method,
      path: req.originalUrl || req.url || null,
      duration_ms: Date.now() - startedAt,
      statusCode: Number(res.statusCode || 0),
      requestId: req.requestId || res.locals?.requestId || res.locals?.request_id || null,
      orgId: req.orgId || req.headers['x-org-id'] || null,
      userId: req.userData?.id || req.userId || req.user?.uid || null,
    })
  })

  return next()
})

app.use('/api/contacts', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next()
  }

  if (!req.headers['x-secret-key']) {
    return next()
  }

  return machineAuthMiddleware(req, res, (authErr) => {
    if (authErr) {
      return next(authErr)
    }

    if (!req.secretKeyAuth) {
      return next()
    }

    return contactsRoutes(req, res, next)
  })
})
app.use('/api/contacts', ...withAuthAndOrg(contactsRoutes))
app.use('/api/households', ...withAuthAndOrg(householdsRoutes))

// Unified search routes (Phase 2)
app.use('/api/search', authMiddleware, impersonationMiddleware, orgContextMiddleware, searchRoutes)

// Conecta-native esign envelope routes (router enforces auth/org context)
app.use('/api/esign/envelopes', esignEnvelopesRoutes)

app.use('/api/sign', signRoutes)

// AI-assisted CSV import routes
app.use(
  '/api/imports',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  importsRoutes
)

// Mobile contact routes (optimized for mobile)
// /api/mobile/contacts is a compatibility surface for mobile callers. The
// canonical web/API contact workflow remains /api/contacts.
import mobileContactsRoutes from './routes/mobileContacts.js'
app.use(
  '/api/mobile',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  mobileContactsRoutes
)

// Message routes (requires org context for multi-org support)
app.use('/api/messages', ...withAuthAndOrg(messagesRoutes))

// ========== EXTERNAL API PROVIDER ROUTES ==========

// Unified external webhook endpoint with provider detection
app.post(
  '/webhook/external',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'external.webhook',
    webhook_name: 'external',
    route_name: '/webhook/external',
  }),
  handleExternalWebhook
)

// Provider-specific webhook endpoints
app.use('/webhook/aws', (req, res, next) => {
  if (req.path === '/ses-inbound') {
    return applyNamedOperationContext({
      context_type: 'webhook',
      operation_name: 'ses.inbound_email',
      webhook_name: 'ses_inbound_email',
      route_name: '/webhook/aws/ses-inbound',
    })(req, res, next)
  }
  return next()
})
app.use('/webhook/aws', awsRoutes)

// n8n IMAP email ingestion endpoint
app.post(
  '/inbox/ingest-email',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'n8n.inbox_ingest',
    webhook_name: 'n8n_inbox_ingest',
    route_name: '/inbox/ingest-email',
  }),
  handleInboxEmailIngestion
)

// ========== WEBSITE LEADS WEBHOOK ==========
// Shared marketing form capture forwarded to n8n. The route name is historical:
// this is not CRM opportunities, contacts.leads metadata, or legacy public.leads.
app.use(
  '/webhook/leads',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'leads.webhook',
    webhook_name: 'leads',
    route_name: '/webhook/leads',
  }),
  leadsWebhookRoutes
)

// AI Board external API routes
app.use('/api/ai-board', aiBoardRoutes)
app.use('/api/sheets', sheetsRoutes)
app.use('/api/drive', driveRoutes)
app.use(rssCraigslistRouter)

// ========== BACKWARD COMPATIBILITY ALIASES ==========

// Legacy Twilio SMS webhook disabled (backward compatibility endpoint kept for explicit fail)
app.post('/webhook/receive-sms', async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'Twilio disabled',
  })
})

// Workflow routes
app.use(
  '/api/workflows',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  workflowsRoutes
)
app.use(
  '/api/workflow-templates',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  workflowTemplatesRoutes
)
app.use(
  '/api/v1/workflows',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  v1WorkflowsRoutes
)
app.use(
  '/api/workflow-assets',
  authMiddleware,
  impersonationMiddleware,
  loadUserContext,
  workflowAssetsRoutes
)
app.use(
  '/api/workflow-documents',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  workflowDocumentsRoutes
)

// N8N API routes (supports both Firebase and MCP authentication)
// MCP Authentication middleware for N8N routes
const mcpAuthMiddleware: RequestHandler = async (req, res, next) => {
  try {
    // Check if this is an MCP request
    const mcpToken = req.headers['x-mcp-token'] || req.headers['x-api-key']
    const expectedToken = process.env.MCP_API_KEY || process.env.FIREBASE_ID_TOKEN

    if (mcpToken && expectedToken && mcpToken === expectedToken) {
      // MCP authentication successful - add auth context
      req.mcpAuth = {
        type: 'mcp',
        orgId: process.env.CONECTA_ORG_ID,
        userId: process.env.FIREBASE_ID_TOKEN,
      }
      return next()
    }

    // Not MCP auth, continue to regular Firebase auth
    next()
  } catch (error) {
    logError('Server', 'MCP auth middleware error', error)
    return res.status(500).json({ error: 'Authentication error' })
  }
}
void mcpAuthMiddleware

// Email and Text Blast routes
app.use(
  '/api/email-text-blast',
  authMiddleware,
  impersonationMiddleware,
  loadUserContext,
  emailTextBlastRoutes
)

// Campaign Drafts routes
app.use(
  '/api/blast-drafts',
  authMiddleware,
  impersonationMiddleware,
  loadUserContext,
  blastAndWorkflowDraftsRoutes
)

// Campaign Templates routes
app.use(
  '/api/blast-templates',
  authMiddleware,
  impersonationMiddleware,
  loadUserContext,
  blastAndWorkflowTemplatesRoutes
)

// Tag routes
app.use('/api/tags', authMiddleware, impersonationMiddleware, orgContextMiddleware, tagsRoutes)
app.use(
  '/api/lobby-queue',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  lobbyQueueRoutes
)
app.use('/api/internal/lobby', cronAuth, internalLobbyResetRoutes)

// Form template routes - public routes registered first (no auth required)
// Public form routes (must come before auth-protected routes)

function createPublicFormsRateLimiter(scope: string, maxRequests: number) {
  return createRateLimiter(`/api/forms/public/${scope}`, {
    windowMs: 60 * 1000,
    maxRequests,
    keyGenerator: (req) => {
      const forwarded = req.headers['x-forwarded-for']
      const forwardedIp = Array.isArray(forwarded)
        ? forwarded[0]
        : typeof forwarded === 'string'
          ? forwarded.split(',')[0]
          : ''
      const ip = String(forwardedIp || req.ip || req.connection?.remoteAddress || 'unknown').trim()
      return `forms-public:${scope}:${ip}`
    },
  })
}

const publicFormsSchemaLimiter = createPublicFormsRateLimiter('schema', 100)
const publicFormsUploadLimiter = createPublicFormsRateLimiter('upload-temp', 20)
const publicFormsDraftLimiter = createPublicFormsRateLimiter('draft', 60)
const publicFormsIngestLimiter = createPublicFormsRateLimiter('ingest', 30)
const publicFormsStatusLimiter = createPublicFormsRateLimiter('status', 120)

// Public file upload for form FileElement
import { uploadTempFile as formsUploadTempFile } from './controllers/formsFileUploadController.ts'
app.post('/api/forms/public/upload-temp', publicFormsUploadLimiter, formsUploadTempFile)

// Form schema endpoint (used for headless rendering)
app.get(
  '/api/forms/public/:orgSlug/:slug/schema',
  publicFormsSchemaLimiter,
  formsController.getFormSchema
)
app.get(
  '/api/forms/public/:formId/submissions/:submissionId/status',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'forms.public.submission_status',
    webhook_name: 'forms_public_submission_status',
    route_name: '/api/forms/public/:formId/submissions/:submissionId/status',
  }),
  publicFormsStatusLimiter,
  formsIngestController.publicGetSubmissionStatus
)
app.post(
  '/api/forms/public/:formId/ingest',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'forms.public.ingest',
    webhook_name: 'forms_public_ingest',
    route_name: '/api/forms/public/:formId/ingest',
  }),
  publicFormsIngestLimiter,
  formsIngestController.publicIngestSubmission as RequestHandler
)
app.post(
  '/api/forms/public/:formId/draft',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'forms.public.draft_create',
    webhook_name: 'forms_public_draft_create',
    route_name: '/api/forms/public/:formId/draft',
  }),
  publicFormsDraftLimiter,
  formsIngestController.publicSaveDraft
)
app.put(
  '/api/forms/public/:formId/draft/:draftToken',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'forms.public.draft_update',
    webhook_name: 'forms_public_draft_update',
    route_name: '/api/forms/public/:formId/draft/:draftToken',
  }),
  publicFormsDraftLimiter,
  formsIngestController.publicUpdateDraft
)
app.get(
  '/api/forms/public/:formId/draft/:draftToken',
  applyNamedOperationContext({
    context_type: 'webhook',
    operation_name: 'forms.public.draft_get',
    webhook_name: 'forms_public_draft_get',
    route_name: '/api/forms/public/:formId/draft/:draftToken',
  }),
  publicFormsDraftLimiter,
  formsIngestController.publicGetDraft
)
app.use(
  '/api/forms',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  formsRoutes
)

// Custom field routes
app.use(
  '/api/custom-fields',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  customFieldsRoutes
)

app.use('/api/opportunities', ...withAuthAndOrg(opportunitiesRoutes))

// Events routes (event query API)
app.use(
  '/api/events',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  loadUserContext,
  eventsRoutes
)

// OpenAI routes (AI-powered features)
app.use('/api/openai', authMiddleware, impersonationMiddleware, openaiRoutes)
app.use(
  '/api/dependents',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  dependentsRoutes
)
const goneOpenAiLearning: RequestHandler = (req, res) => res.status(410).json({ error: 'Gone' })
app.all('/api/openai-learning', goneOpenAiLearning)
app.all('/api/openai-learning/*', goneOpenAiLearning)
app.use('/api/agent', agentRoutes)

function summarizeDebugTelemetryPayload(body: unknown): RetiredTelemetryPayload {
  if (body == null) {
    return { body_type: 'null', body_keys: [], body_length: 0, body_hash: '' }
  }

  if (typeof body === 'string') {
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)
    return {
      body_type: 'string',
      body_keys: [],
      body_length: body.length,
      body_hash: bodyHash,
    }
  }

  if (typeof body === 'object') {
    const keys = Object.keys(body).slice(0, 40)
    const serialized = JSON.stringify(body)
    const bodyHash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)
    return {
      body_type: Array.isArray(body) ? 'array' : 'object',
      body_keys: keys,
      body_length: serialized.length,
      body_hash: bodyHash,
    }
  }

  const asString = String(body)
  const bodyHash = crypto.createHash('sha256').update(asString).digest('hex').slice(0, 16)
  return {
    body_type: typeof body,
    body_keys: [],
    body_length: asString.length,
    body_hash: bodyHash,
  }
}

const RETIRED_TELEMETRY_ENDPOINTS = new Set([
  '/api/discord-error',
  '/api/sofia/debug-events',
  '/api/presence/heartbeat',
])

const RETIRED_TELEMETRY_SAMPLE_RATE = Number(process.env.RETIRED_TELEMETRY_SAMPLE_RATE || 0.01)

function isRetiredTelemetryPath(pathname: string) {
  return RETIRED_TELEMETRY_ENDPOINTS.has(String(pathname || ''))
}

function readAuthContext(req: Request) {
  const orgId =
    req.orgId ||
    req.org_id ||
    req.user?.org_id ||
    req.userData?.org_id ||
    req.headers['x-org-id'] ||
    null
  const userId =
    req.user?.uid || req.user?.id || req.userData?.id || req.userId || req.user_id || null
  const authHeader = req.headers.authorization || ''
  return {
    hasAuthContext: Boolean(orgId || userId || authHeader),
    orgId: orgId || null,
    userId: userId || null,
  }
}

function getExpectedRetiredBodyKeys(endpoint: string) {
  if (endpoint === '/api/presence/heartbeat') {
    return new Set([
      'sessionId',
      'trigger',
      'routeName',
      'currentPath',
      'canonicalPath',
      'pageTitle',
      'isDemoMode',
    ])
  }
  if (endpoint === '/api/discord-error') {
    return new Set(['error', 'context', 'severity'])
  }
  return new Set(['severity', 'source', 'event_type', 'error', 'classification', 'context'])
}

function getRetiredTelemetryFingerprint(req: Request) {
  const referer = String(req.headers.referer || '')
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  const userAgent = String(req.headers['user-agent'] || '')
  const isKnownReferer =
    referer.startsWith('https://app.holaconecta.com/inbox') ||
    referer.startsWith('https://app.holaconecta.com/google-dashboard')
  const isKnownUa = userAgent.includes('Chrome/') && userAgent.includes('Windows NT')
  return {
    referer,
    contentType,
    userAgent,
    isKnownReferer,
    isKnownUa,
    isJson: contentType.includes('application/json'),
  }
}

function hasUnexpectedRetiredTelemetryShape(
  endpoint: string,
  req: Request,
  payload: RetiredTelemetryPayload,
) {
  if (!isRetiredTelemetryPath(endpoint)) return true
  if (req.method !== 'POST') return true
  if (!payload || payload.body_type !== 'object') return true

  const expected = getExpectedRetiredBodyKeys(endpoint)
  if (!expected.size) return false

  const bodyKeys = Array.isArray(payload.body_keys) ? payload.body_keys : []
  if (bodyKeys.length === 0) return true
  return !bodyKeys.some((key: string) => expected.has(String(key)))
}

function shouldSuppressRetiredTelemetryLog(
  endpoint: string,
  req: Request,
  payload: RetiredTelemetryPayload,
) {
  const auth = readAuthContext(req)
  if (auth.hasAuthContext) return false
  if (hasUnexpectedRetiredTelemetryShape(endpoint, req, payload)) return false

  const fp = getRetiredTelemetryFingerprint(req)
  if (!fp.isJson) return false
  if (!fp.isKnownUa) return false
  if (!fp.isKnownReferer) return false

  return true
}

function logRetiredDebugTelemetryCall(endpoint: string, req: Request) {
  const payload = summarizeDebugTelemetryPayload(req.body)
  const traceIdFromHeader = req.headers['x-retired-telemetry-trace-id']
  const traceIdFromQuery = req.query?.trace_id
  const traceIdFromBody = req.body?.trace_id
  const traceId =
    (typeof traceIdFromHeader === 'string' && traceIdFromHeader) ||
    (typeof traceIdFromQuery === 'string' && traceIdFromQuery) ||
    (typeof traceIdFromBody === 'string' && traceIdFromBody) ||
    ''
  const auth = readAuthContext(req)
  const suppress = shouldSuppressRetiredTelemetryLog(endpoint, req, payload)

  if (suppress) {
    req._skipAccessLog = true
    if (Math.random() < RETIRED_TELEMETRY_SAMPLE_RATE) {
      logInfo('retired-debug-telemetry', 'Retired debug telemetry endpoint suppressed (sampled)', {
        event_key: 'retired_debug_telemetry_call',
        sampled: true,
        sample_rate: RETIRED_TELEMETRY_SAMPLE_RATE,
        trace_id: traceId,
        endpoint,
        method: req.method,
        originalUrl: req.originalUrl,
        referer: req.headers.referer || '',
        origin: req.headers.origin || '',
        userAgent: req.headers['user-agent'] || '',
        xForwardedFor: req.headers['x-forwarded-for'] || '',
        contentType: req.headers['content-type'] || '',
        contentLength: req.headers['content-length'] || '',
        ...payload,
      })
    }
    return
  }

  logWarn('retired-debug-telemetry', 'Retired debug telemetry endpoint invoked', {
    event_key: 'retired_debug_telemetry_call',
    trace_id: traceId,
    endpoint,
    method: req.method,
    originalUrl: req.originalUrl,
    referer: req.headers.referer || '',
    origin: req.headers.origin || '',
    userAgent: req.headers['user-agent'] || '',
    xForwardedFor: req.headers['x-forwarded-for'] || '',
    contentType: req.headers['content-type'] || '',
    contentLength: req.headers['content-length'] || '',
    auth_present: auth.hasAuthContext,
    orgId: auth.orgId,
    userId: auth.userId,
    ...payload,
  })
}

const retiredDebugTelemetryResponse = {
  ok: false,
  error: 'SOFIA_DEBUG_TELEMETRY_REMOVED',
  message: 'Sofia debug telemetry endpoint has been removed',
}

app.post('/api/discord-error', (req, res) => {
  logRetiredDebugTelemetryCall('/api/discord-error', req)
  return res.status(410).json(retiredDebugTelemetryResponse)
})

app.post('/api/sofia/debug-events', (req, res) => {
  logRetiredDebugTelemetryCall('/api/sofia/debug-events', req)
  return res.status(410).json(retiredDebugTelemetryResponse)
})

app.post('/api/presence/heartbeat', (req, res) => {
  logRetiredDebugTelemetryCall('/api/presence/heartbeat', req)
  return res.status(410).json({
    ok: false,
    error: 'PRESENCE_HEARTBEAT_REMOVED',
    message: 'Presence heartbeat endpoint has been removed',
  })
})

app.use('/api/sofia/tools', sofiaToolRoutes)
app.use('/api/sofia', ...withAuthAndOrg(sofiaRoutes))
app.use('/api/time-context', ...withAuthAndOrg(timeContextRoutes))
app.use('/api/help-desk', helpDeskRoutes)
app.use('/api/ai-read', aiReadRoutes)

// Google Calendar OAuth callback (public - no auth required)
function buildCalendarSettingsRedirectUrl(query: Record<string, string>) {
  const params = new URLSearchParams(query)
  return `${CLIENT_URL}/settings?${params.toString()}`
}

app.get('/api/integrations/google-calendar/callback', async (req, res) => {
  try {
    const code = getQueryString(req.query.code)
    const state = getQueryString(req.query.state)

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing authorization code or state' })
    }

    let stateData
    try {
      stateData = JSON.parse(state)
    } catch {
      return res.status(400).json({ error: 'Invalid state parameter' })
    }

    const { userId, orgId } = stateData

    // Import the Google Calendar service
    const googleCalendarService = (await import('./services/calendar/googleCalendarService.ts'))
      .default

    // Exchange code for tokens
    const tokenData = await googleCalendarService.exchangeCodeForTokens(code)

    // Store refresh token
    await googleCalendarService.storeRefreshToken(orgId, userId, tokenData.refreshToken as string)

    // Redirect to settings page with success
    const redirectUrl = buildCalendarSettingsRedirectUrl({
      domain: 'scheduling',
      category: 'scheduling',
      section: 'google-calendar',
      calendarTab: 'google-calendar',
      google_connected: 'true',
    })
    res.redirect(redirectUrl)
  } catch (err) {
    logError('google-calendar-callback', 'Error handling Google Calendar callback', err)
    const redirectUrl = buildCalendarSettingsRedirectUrl({
      domain: 'scheduling',
      category: 'scheduling',
      section: 'google-calendar',
      calendarTab: 'google-calendar',
      google_error: 'true',
    })
    res.redirect(redirectUrl)
  }
})

// Microsoft Calendar OAuth callback (public - no auth required)
const handleMicrosoftCalendarCallback: RequestHandler = async (req, res) => {
  try {
    const code = getQueryString(req.query.code)
    const state = getQueryString(req.query.state)
    const oauthError = getQueryString(req.query.error)

    // Check for OAuth errors from Microsoft
    if (oauthError) {
      logError('MicrosoftCalendarCallback', 'OAuth error from Microsoft', null, {
        oauthError,
        errorDescription: req.query.error_description,
        errorUri: req.query.error_uri,
        query: req.query,
      })
      const redirectUrl = buildCalendarSettingsRedirectUrl({
        domain: 'scheduling',
        category: 'scheduling',
        section: 'microsoft-calendar',
        calendarTab: 'microsoft-calendar',
        microsoft_calendar: `error=${oauthError}`,
      })
      return res.redirect(redirectUrl)
    }

    if (!code || !state) {
      logError('MicrosoftCalendarCallback', 'Missing authorization code or state', null, {
        hasCode: !!code,
        hasState: !!state,
        query: req.query,
      })
      return res.status(400).json({ error: 'Missing authorization code or state' })
    }

    let stateData
    try {
      stateData = JSON.parse(state)
    } catch (err) {
      logError('MicrosoftCalendarCallback', 'Invalid state parameter', err, {
        state,
        query: req.query,
      })
      return res.status(400).json({ error: 'Invalid state parameter' })
    }

    const { userId, orgId } = stateData

    if (!userId || !orgId) {
      logError('MicrosoftCalendarCallback', 'Missing userId or orgId in state', null, {
        stateData,
        query: req.query,
      })
      const redirectUrl = buildCalendarSettingsRedirectUrl({
        domain: 'scheduling',
        category: 'scheduling',
        section: 'microsoft-calendar',
        calendarTab: 'microsoft-calendar',
        microsoft_calendar: 'error=invalid_state',
      })
      return res.redirect(redirectUrl)
    }

    // Import the Outlook Calendar service
    const outlookCalendarService = (await import('./services/calendar/outlookCalendarService.ts'))
      .default

    // Exchange code for tokens
    const tokenData = await outlookCalendarService.exchangeCodeForTokens(code)

    // Store refresh token
    await outlookCalendarService.storeRefreshToken(orgId, userId, tokenData.refreshToken as string)

    // Redirect to settings page with success
    const redirectUrl = buildCalendarSettingsRedirectUrl({
      domain: 'scheduling',
      category: 'scheduling',
      section: 'microsoft-calendar',
      calendarTab: 'microsoft-calendar',
      microsoft_calendar: 'connected',
    })
    res.redirect(redirectUrl)
  } catch (err) {
    logError('MicrosoftCalendarCallback', 'Error handling Microsoft Calendar callback', err, {
      query: req.query,
      errorMessage: toErrorMessage(err),
      errorStack: toErrorStack(err),
      errorName: toErrorName(err),
    })

    // Try to extract error message for redirect
    const errorMessage = toErrorMessage(err) || 'unknown_error'
    const redirectUrl = buildCalendarSettingsRedirectUrl({
      domain: 'scheduling',
      category: 'scheduling',
      section: 'microsoft-calendar',
      calendarTab: 'microsoft-calendar',
      microsoft_calendar: `error=${errorMessage}`,
    })
    res.redirect(redirectUrl)
  }
}

app.get('/auth/microsoft/callback', handleMicrosoftCalendarCallback)

// Google Business Profile OAuth callback (public - no auth required)
import googleBusinessDashboardRouter from './routes/googleBusinessDashboard.js'
app.use('/api/google-business', googleBusinessDashboardRouter)

app.get(
  '/api/integrations/google-business-profile/callback',
  googleBusinessProfileController.callback.bind(googleBusinessProfileController)
)

app.use('/api/integrations', authMiddleware, integrationsRoutes)

// Document routes
app.use(
  '/api/document-requests',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  documentRequestRoutes
)
app.use(
  '/api/document-request-packets',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  documentRequestPacketRoutes
)
// Canonical client portal API surface.
app.use('/api/client', clientAuthRoutes)
app.use('/api/client', clientPortalRoutes)
app.use('/api/folders', authMiddleware, impersonationMiddleware, orgContextMiddleware, folderRoutes)

// SES webhook routes (NO AUTH - AWS SNS calls this endpoint)
app.use('/ses-webhooks', sesWebhookRoutes)

// Campaign analytics routes
app.use(
  '/api/blast-analytics',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  blastAnalyticsRoutes
)

// Message analytics routes (for individual inbox messages)
app.use(
  '/api/message-analytics',
  authMiddleware,
  impersonationMiddleware,
  orgContextMiddleware,
  messageAnalyticsRoutes
)

// Internal conversation routes (team chat) - moved above catch-all route

// Website AI routes (public for chatbot)

// Image upload routes (auth required)
// Use scoped endpoint at /api/image-upload/*
// NOTE: Do NOT register at /api/* as it conflicts with other routes
app.use('/api/image-upload', imageUploadRoutes)
app.use('/api/baby-leoncito/photos', babyLeoncitoPhotosRoutes)

// Sitemap route (public)
app.use('/', sitemapRoutes)

// Admin routes
app.use('/api/admin', adminRoutes)

// Dev-only test routes (disabled in production)
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/dev-test', devTestRoutes)
}

// WebSocket events routes (auth required)
app.use('/api/websocket', adminAuthMiddleware, websocketEventsRoutes)

// MCP routes (Model Context Protocol server endpoints)
app.use('/', mcpWellKnownRoutes)
app.use('/mcp', mcpRoutes)

// Client portal API routes are mounted under /api/client.
// /test routes for client portal utilities can be added here if needed

// Token endpoint
app.post(
  '/token',
  authMiddleware,
  (req, res, next) =>
    void import('./tokencontroller.js')
      .then((mod) => {
        const issueCustomToken = (mod.issueCustomToken ?? mod.default?.issueCustomToken) as
          | ServerRouteHandler
          | undefined

        if (!issueCustomToken) {
          throw new Error('tokencontroller.js must export issueCustomToken')
        }

        return issueCustomToken(req, res, next)
      })
      .catch((error) => {
        next(error)
      })
)

// Preflight catch-all (CORS middleware handles OPTIONS, but this ensures all OPTIONS get a response)
// Note: CORS middleware runs before routes, so this is mainly a fallback
app.options('*', (req, res) => {
  const origin = req.headers.origin
  // Set CORS headers if origin is present and allowed
  if (origin) {
    applyCorsHeaders(res, origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
  }
  return res.sendStatus(204)
})

// ----- Error Handling -----
// Forms strict errors must be serialized consistently before other handlers.
app.use(formsStrictErrorMiddleware)

// Service error handling (must come before database error handlers)
app.use(serviceErrorHandler)

// External API error handling (must come before database error handlers)
app.use(externalApiErrorHandler)

// Database error handling (must come before other error handlers)
app.use(databaseErrorHandler)

// Global error handling middleware (must be last, after all routes and other error handlers)
app.use(globalErrorHandler)

// API "no HTML" guardrail
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// If something tries to serve HTML under /api, force JSON
app.use('/api', ((err, req, res, next) => {
  void next
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number(err.status) || 500
      : typeof err === 'object' && err !== null && 'statusCode' in err
        ? Number(err.statusCode) || 500
        : 500
  res.status(status).json({
    ok: false,
    error: {
      message: err instanceof Error ? err.message : 'API error',
      status,
    },
  })
}) as ErrorRequestHandler)

// /api 404 fallback to avoid HTML responses
app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: {
      message: 'Not found',
      status: 404,
    },
  })
})

// ----- Start Server -----
export default app

// CRITICAL: Validate required configuration before starting server
// This ensures we fail fast in production if required config is missing
/**
 * Validate client portal base URL configuration
 *
 * CRITICAL: CLIENT_PORTAL_URL is REQUIRED in all environments.
 * No fallbacks - fail loudly if missing to prevent hidden configuration issues.
 */
function validateClientPortalConfig() {
  const clientPortalUrl = process.env.CLIENT_PORTAL_URL

  // CRITICAL: Fail loudly if missing - no fallbacks in any environment
  if (!clientPortalUrl || clientPortalUrl.trim() === '') {
    const error = new Error(
      'CLIENT_PORTAL_URL is required to generate portal magic links. ' +
        'Set it to https://<your-client-portal-host> (e.g., https://app.holaconecta.com). ' +
        'This environment variable must be set in all environments (development, staging, production).'
    )
    logError('server', 'Configuration error', error, { field: 'CLIENT_PORTAL_URL' })
    throw error
  }

  // Validate format
  if (!clientPortalUrl.startsWith('http://') && !clientPortalUrl.startsWith('https://')) {
    const error = new Error(
      `Invalid CLIENT_PORTAL_URL: "${clientPortalUrl}". ` +
        'Must be a full origin URL starting with http:// or https:// (e.g., https://app.holaconecta.com).'
    )
    logError('server', 'Configuration error', error, { field: 'CLIENT_PORTAL_URL' })
    throw error
  }
}

async function runPostListenInitializer(name: string, loadInitializer: InitializerLoader) {
  logInfo('startup', `${name} initializer started`, { initializer: name, essential: true })

  try {
    const initialize = await loadInitializer()
    initialize()
    logInfo('startup', `${name} initializer completed`, { initializer: name, essential: true })
  } catch (error) {
    logError('startup', `${name} initializer failed`, error, { initializer: name, essential: true })
  }
}

async function measureStartupStep<T>(name: string, step: StartupStep<T>) {
  const startedAt = Date.now()
  logInfo('startup', `${name} started`, { step: name, essential: true })

  try {
    const result = await step()
    logInfo('startup', `${name} completed`, {
      step: name,
      durationMs: Date.now() - startedAt,
      essential: true,
    })
    return result
  } catch (error) {
    logError('startup', `${name} failed`, error, {
      step: name,
      durationMs: Date.now() - startedAt,
      essential: true,
    })
    throw error
  }
}

function startPostListenInitializers() {
  void runPostListenInitializer('initializeWorkflowSubscriptions', async () => {
    const mod = await import('./services/workflow/entityEventHub.ts')
    return mod.initializeWorkflowSubscriptions
  })

  void runPostListenInitializer('initializeWorkflowExecutionEventHandler', async () => {
    const mod = await import('./services/workflow/workflowExecutionEventHandler.ts')
    return mod.initializeWorkflowExecutionEventHandler
  })

  void runPostListenInitializer('initializePortalDocumentNotifications', async () => {
    const mod = await import('./services/notifications/portalDocumentNotificationService.js')
    return mod.initializePortalDocumentNotifications
  })

  void runPostListenInitializer('initNotificationSubscriptions', async () => {
    const mod = await import('./services/notifications/notificationEventHandler.js')
    return mod.initNotificationSubscriptions
  })

}

try {
  // Validate client portal configuration first
  validateClientPortalConfig()

  if (process.env.NODE_ENV === 'production') {
    validateUrlConfig()
  } else {
    // In development, validate but don't fail - just warn
    try {
      validateUrlConfig()
    } catch (urlError) {
      logWarn('server', 'URL configuration validation failed in development (non-blocking)', {
        error: toErrorMessage(urlError),
      })
    }
  }
} catch (configError) {
  logError(
    'server',
    'CRITICAL: Configuration validation failed - server cannot start',
    configError,
    {
      nodeEnv: process.env.NODE_ENV,
    }
  )
  logError('server', 'Server startup failed during config validation', configError, {
    nodeEnv: process.env.NODE_ENV,
  })
  process.exit(1)
}

// Create HTTP server explicitly for WebSocket support
const server = http.createServer(app)

const preferredPort = Number.parseInt(process.env.PORT || '8080', 10) || 8080
const maxPortAttempts = Math.max(1, Number.parseInt(process.env.PORT_TRIES || '10', 10) || 10)
let currentPort = preferredPort
let portAttempts = 0
// Use '::' for dual-stack (IPv4 + IPv6) to support Fly.io internal networking
const host = '::'

server.on('error', (error) => {
  if (getErrorCode(error) === 'EADDRINUSE') {
    if (portAttempts >= maxPortAttempts || currentPort >= 65535) {
      logError('server', `Port binding failed after ${portAttempts} attempts`, error, {
        preferredPort,
        currentPort,
        maxPortAttempts,
      })
      process.exit(1)
    }

    const nextPort = currentPort + 1
    logWarn('server', `Port ${currentPort} is in use, retrying on ${nextPort}`)
    currentPort = nextPort
    portAttempts += 1
    setTimeout(() => server.listen(currentPort, host), 50)
    return
  }

  logError('server', 'HTTP server startup failed', error, {
    host,
    currentPort,
  })
  process.exit(1)
})

server.listen(currentPort, host, async () => {
  const listeningAddress = server.address()
  const listeningPort =
    typeof listeningAddress === 'object' && listeningAddress ? listeningAddress.port : currentPort
  logInfo('startup', `Conecta proxy listening on ${host}:${listeningPort}`, {
    preferredPort,
    effectivePort: listeningPort,
    portAttempts,
    databaseUrlSource,
    essential: true,
  })

  startPostListenInitializers()

  // Setup WebSockets (notifications + monitoring)
  await measureStartupStep('setupWebSockets', async () => {
    setupWebSockets(server)
  })

  if (process.env.BACKGROUND_STARTUP_RECOVERY_ENABLED === 'true') {
    try {
      await measureStartupStep('recoverStuckBlasts', async () => {
        const emailTextBlastService = (
          await import('./services/messaging/emailTextBlastService.ts')
        ).default
        await emailTextBlastService.recoverStuckBlasts()
      })
    } catch (error) {
      logError('server', 'Blast recovery failed', error)
    }
  }

  await measureStartupStep('startCommunicationWorker', async () => {
    await startCommunicationWorker()
  })

  // All schedulers are now HTTP-triggered via Cloud Scheduler /api/cron endpoints

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logError('server', 'Uncaught exception captured', error, {
      route: 'process',
      method: 'uncaughtException',
    })
    process.exit(1)
  })

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, _promise) => {
    // Ensure reason is converted to a proper Error object with string message
    const errorMessage = reason instanceof Error ? reason.message : String(reason)
    const error = new Error(errorMessage)
    if (reason instanceof Error) {
      error.stack = reason.stack
    }

    logError('server', 'Unhandled rejection captured', error, {
      route: 'process',
      method: 'unhandledRejection',
    })
  })

  const gracefulShutdown = async (signal: string) => {
    try {
      await stopCommunicationWorker()
    } catch (error) {
      logError('server', 'Failed to stop communication worker during shutdown', error)
    } finally {
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        process.exit(0)
      }
    }
  }

  ;['SIGTERM', 'SIGINT', 'beforeExit'].forEach((signal) => {
    process.on(signal, () => gracefulShutdown(signal))
  })
})
