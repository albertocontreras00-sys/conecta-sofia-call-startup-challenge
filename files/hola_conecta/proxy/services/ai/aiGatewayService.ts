import crypto from 'crypto'
import { OpenAI } from 'openai'
import { enforceAiPolicyOrThrow, DATA_SOURCES } from '../../utils/aiPolicy.js'
import { getRequestContext } from '../../utils/requestContextStore.js'
import { logDebug, logError, logWarn } from '../../utils/logger.js'
import { getOpenAIKey } from '../../utils/openaiRuntimeConfig.js'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface ModelSpec {
  provider: string | null
  model: string
  fallback?: ModelSpec | null
}

interface ModelSpecInput {
  provider?: string | null
  model: string
  fallback?: string | ModelSpecInput | null
}

interface SurfaceRoute {
  provider: string
  model: string
  fallback: ModelSpec | null
}

interface UsageStats {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

interface GatewayMessage {
  role?: string
  type?: string
  content?: string | Array<string | JsonValue>
  call_id?: string
  output?: string
}

interface GatewayMetadata {
  requestId?: string
  userId?: string
  data_source?: string
  source_integration?: string
  source_ref?: string
  modelOverride?: string | ModelSpecInput | null
  fallbackOverride?: string | ModelSpecInput | null
  toolChoice?: string
  openaiOptions?: JsonObject | null
  geminiOptions?: JsonObject | null
}

interface GenerateTextArgs {
  orgId: string
  surface: string
  system?: string
  messages: GatewayMessage[] | string
  tools?: JsonObject[]
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
  metadata?: GatewayMetadata
}

interface ProviderResult {
  raw: object
  text: string
  usage: UsageStats
  model: string
  provider: string
}

interface GatewayResult {
  requestId: string
  provider: string
  model: string
  text: string
  raw: object
  usage: UsageStats
  latencyMs: number
  fallbackUsed: boolean
  fallback?: {
    from: { provider: string; model: string }
    to: { provider: string; model: string }
  }
}

interface GatewayError extends Error {
  code: string
  status: number
  requestId: string
  provider: string
  model: string
  fallbackUsed: boolean
}

interface GeminiPart {
  text?: string
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[]
  }
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
}

interface OpenAIResponseLike {
  output_text?: string | null
  output?: Array<{
    type?: string
    content?: Array<{
      type?: string
      text?: string
    }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
  }
  model?: string
}

interface RequestContextLike {
  requestId?: string
  userId?: string
}

const DEFAULT_MAX_TOKENS = 800
const DEFAULT_TEMPERATURE = 0.4
const GEMINI_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models'
const NO_FALLBACK_SURFACES = new Set([
  'sofia_chat',
  'sofia_booking_agent',
  'sofia_voice_orchestrator',
  'website_chat',
  'import_mapping',
  'import_intelligence',
  'import_post_summary'
])

let cachedOpenAiClient: OpenAI | null = null

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function normalizeModelSpec(spec: string | ModelSpecInput | null | undefined): ModelSpec | null {
  if (!spec) return null

  if (typeof spec === 'string') {
    if (spec.includes('/')) {
      const [provider, ...rest] = spec.split('/')
      return { provider: String(provider || '').toLowerCase(), model: rest.join('/') }
    }
    return { provider: null, model: spec }
  }

  if (typeof spec === 'object' && typeof spec.model === 'string') {
    return {
      provider: typeof spec.provider === 'string' ? spec.provider.toLowerCase() : null,
      model: spec.model,
      fallback: normalizeModelSpec(spec.fallback || null)}
  }

  return null
}

function defaultRegistry(): Record<string, ModelSpecInput> {
  const defaultGeminiModel = process.env.AI_MODEL_GEMINI_DEFAULT || 'gemini-2.0-flash'
  return {
    sofia_chat: {
      provider: process.env.AI_PROVIDER_SOFIA_CHAT || 'gemini',
      model: process.env.AI_MODEL_SOFIA_CHAT || defaultGeminiModel,
      fallback: null},
    sofia_booking_agent: {
      provider: process.env.AI_PROVIDER_SOFIA_BOOKING_AGENT || 'gemini',
      model: process.env.AI_MODEL_SOFIA_BOOKING_AGENT || 'gemini-2.5-flash-lite',
      fallback: null},
    sofia_voice_orchestrator: {
      provider: process.env.AI_PROVIDER_SOFIA_BOOKING_AGENT || 'gemini',
      model: process.env.AI_MODEL_SOFIA_BOOKING_AGENT || 'gemini-2.5-flash-lite',
      fallback: null},
    website_chat: {
      provider: process.env.AI_PROVIDER_WEBSITE_CHAT || 'gemini',
      model: process.env.AI_MODEL_WEBSITE_CHAT || defaultGeminiModel,
      fallback: null},
    workflow_assistant: {
      provider: process.env.AI_PROVIDER_WORKFLOW_ASSISTANT || process.env.AI_PROVIDER_DEFAULT || 'openai',
      model: process.env.AI_MODEL_WORKFLOW_ASSISTANT || 'gpt-4o-mini',
      fallback: process.env.AI_FALLBACK_WORKFLOW_ASSISTANT || 'openai/gpt-4o-mini'},
    inbox_action: {
      provider: process.env.AI_PROVIDER_INBOX_ACTION || process.env.AI_PROVIDER_DEFAULT || 'openai',
      model:
        process.env.AI_MODEL_INBOX_ACTION ||
        process.env.OPENAI_INBOX_ACTION_MODEL ||
        process.env.AI_MODEL_DEFAULT ||
        process.env.OPENAI_MODEL ||
        'gpt-4o-mini',
      fallback: null},
    translation: {
      provider: process.env.AI_PROVIDER_TRANSLATION || process.env.AI_PROVIDER_DEFAULT || 'openai',
      model:
        process.env.AI_MODEL_TRANSLATION ||
        process.env.OPENAI_TRANSLATION_MODEL ||
        process.env.AI_MODEL_DEFAULT ||
        process.env.OPENAI_MODEL ||
        'gpt-4o-mini',
      fallback: null}}
}

function getModelRegistry(): Record<string, ModelSpecInput> {
  const custom = safeJsonParse<Record<string, ModelSpecInput>>(process.env.AI_MODEL_REGISTRY_JSON, {})
  return {
    ...defaultRegistry(),
    ...(custom && typeof custom === 'object' ? custom : {})}
}

function getTenantOverrides(): Record<string, Record<string, string | ModelSpecInput>> {
  return safeJsonParse<Record<string, Record<string, string | ModelSpecInput>>>(
    process.env.AI_TENANT_MODEL_OVERRIDES_JSON,
    {},
  )
}

function buildSurfaceRoute(params: { orgId: string; surface: string; metadata?: GatewayMetadata }): SurfaceRoute {
  const { orgId, surface, metadata = {} } = params
  const registry = getModelRegistry()
  const tenantOverrides = getTenantOverrides()
  const surfaceKey = String(surface || 'default')

  const base =
    normalizeModelSpec(registry[surfaceKey]) ||
    normalizeModelSpec(registry.default) || {
      provider: process.env.AI_PROVIDER_DEFAULT || 'openai',
      model: process.env.AI_MODEL_DEFAULT || 'gpt-4o-mini',
      fallback: null}

  const tenant = orgId ? tenantOverrides[orgId] : undefined
  const surfaceOverride = tenant ? tenant[surfaceKey] || tenant.default : undefined
  const override = normalizeModelSpec(metadata.modelOverride || null) || normalizeModelSpec(surfaceOverride || null)

  const route: SurfaceRoute = {
    provider: String(override?.provider || base.provider || process.env.AI_PROVIDER_DEFAULT || 'openai').toLowerCase(),
    model: String(override?.model || base.model || process.env.AI_MODEL_DEFAULT || 'gpt-4o-mini'),
    fallback:
      normalizeModelSpec(metadata.fallbackOverride || null) ||
      normalizeModelSpec(override?.fallback || null) ||
      normalizeModelSpec(base.fallback || null)}

  if (NO_FALLBACK_SURFACES.has(surfaceKey)) {
    route.fallback = null
  }

  return route
}

function getOpenAIClient(): OpenAI {
  if (cachedOpenAiClient) return cachedOpenAiClient
  const apiKey = getOpenAIKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured for aiGatewayService')
  }
  cachedOpenAiClient = new OpenAI({ apiKey })
  return cachedOpenAiClient
}

function toGeminiContents(messages: GatewayMessage[]): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const out: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
  for (const msg of messages) {
    if (!msg) continue

    if (msg.type === 'function_call_output') {
      out.push({
        role: 'user',
        parts: [{ text: `Tool result (${msg.call_id || 'result'}): ${msg.output || ''}` }]})
      continue
    }

    const roleRaw = msg.role || msg.type || 'user'
    const role: 'user' | 'model' = roleRaw === 'assistant' || roleRaw === 'model' ? 'model' : 'user'

    if (Array.isArray(msg.content)) {
      out.push({
        role,
        parts: msg.content.map((part) => ({ text: typeof part === 'string' ? part : JSON.stringify(part) }))})
    } else {
      out.push({ role, parts: [{ text: String(msg.content || '') }] })
    }
  }
  return out
}

function readResponseText(response: OpenAIResponseLike): string {
  if (response.output_text) return String(response.output_text)
  const output = Array.isArray(response.output) ? response.output : []
  const message = output.find((item) => item.type === 'message')
  const parts = Array.isArray(message?.content) ? message.content : []
  const textPart = parts.find((part) => part.type === 'output_text' || typeof part.text === 'string')
  return textPart?.text || ''
}

function normalizeUsage(provider: 'openai' | 'gemini', usage?: OpenAIResponseLike['usage'] | GeminiUsageMetadata): UsageStats {
  if (provider === 'gemini') {
    const geminiUsage = usage as GeminiUsageMetadata | undefined
    return {
      input_tokens: Number(geminiUsage?.promptTokenCount || 0),
      output_tokens: Number(geminiUsage?.candidatesTokenCount || 0),
      total_tokens: Number(geminiUsage?.totalTokenCount || 0)}
  }

  const openaiUsage = usage as OpenAIResponseLike['usage'] | undefined
  return {
    input_tokens: Number(openaiUsage?.input_tokens || openaiUsage?.prompt_tokens || 0),
    output_tokens: Number(openaiUsage?.output_tokens || openaiUsage?.completion_tokens || 0),
    total_tokens: Number(openaiUsage?.total_tokens || 0) || Number(openaiUsage?.input_tokens || 0) + Number(openaiUsage?.output_tokens || 0)}
}

function buildGeminiGenerationConfig(params: {
  jsonMode: boolean
  temperature: number
  maxTokens: number
  metadata: GatewayMetadata
}): JsonObject {
  const { jsonMode, temperature, maxTokens, metadata } = params
  const rawOptions = metadata.geminiOptions && typeof metadata.geminiOptions === 'object'
    ? metadata.geminiOptions
    : {}
  const geminiOptions = { ...rawOptions }
  const responseJsonSchema = geminiOptions.responseJsonSchema
  delete geminiOptions.responseJsonSchema
  const explicitResponseSchema = geminiOptions.responseSchema
  delete geminiOptions.responseSchema

  const generationConfig: JsonObject = {
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isFinite(maxTokens) ? { maxOutputTokens: maxTokens } : {}),
    ...geminiOptions}

  if (jsonMode) {
    generationConfig.responseMimeType = generationConfig.responseMimeType || 'application/json'
    const schema = explicitResponseSchema || responseJsonSchema
    if (schema && !generationConfig.responseSchema) {
      generationConfig.responseSchema = toGeminiResponseSchema(schema)
    }
  }

  return generationConfig
}

export function toGeminiResponseSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(item => toGeminiResponseSchema(item))
  }
  if (!value || typeof value !== 'object') return value

  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'additionalProperties' || key === '$schema') continue
    if (key === 'type' && Array.isArray(child)) {
      const types = child.map(item => typeof item === 'string' ? item : null).filter(Boolean)
      const nonNullTypes = types.filter(type => type !== 'null')
      if (types.includes('null')) {
        out.nullable = true
      }
      out.type = nonNullTypes.length > 0 ? nonNullTypes[0] : 'string'
      continue
    }
    out[key] = toGeminiResponseSchema(child as JsonValue)
  }
  return out
}

function buildGeminiFailureDiagnostics(params: {
  route: SurfaceRoute
  jsonMode: boolean
  temperature: number
  maxTokens: number
  metadata: GatewayMetadata
}): JsonObject {
  const { route, jsonMode, temperature, maxTokens, metadata } = params
  if (route.provider !== 'gemini') return {}

  const generationConfig = buildGeminiGenerationConfig({ jsonMode, temperature, maxTokens, metadata })
  const schema = generationConfig.responseSchema
  return {
    gemini_generation_config_keys: Object.keys(generationConfig),
    gemini_response_mime_type: typeof generationConfig.responseMimeType === 'string'
      ? generationConfig.responseMimeType
      : null,
    gemini_has_response_json_schema: Boolean(schema),
    gemini_response_schema_json: schema ? JSON.stringify(schema).slice(0, 4000) : null,
  }
}

function buildGatewayError(
  error: Error | { message?: string } | null | undefined,
  route: { provider: string; model: string },
  requestId: string,
  fallbackUsed = false,
): GatewayError {
  const wrapped = new Error(
    `AI gateway request failed (${route.provider}/${route.model}): ${error?.message || 'request failed'}`,
  ) as GatewayError
  wrapped.code = 'AI_GATEWAY_REQUEST_FAILED'
  wrapped.status = 502
  wrapped.requestId = requestId
  wrapped.provider = route.provider
  wrapped.model = route.model
  wrapped.fallbackUsed = fallbackUsed
  return wrapped
}

async function callOpenAI(params: {
  route: SurfaceRoute
  messages: GatewayMessage[]
  tools?: JsonObject[]
  jsonMode: boolean
  temperature: number
  maxTokens: number
  metadata: GatewayMetadata
}): Promise<OpenAIResponseLike> {
  const { route, messages, tools, jsonMode, temperature, maxTokens, metadata } = params
  const client = getOpenAIClient()
  const key = process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

  const payload: Record<string, JsonValue> = {
    model: route.model,
    input: messages as JsonValue,
    text: jsonMode
      ? ({ format: { type: 'json_object' } } as JsonValue)
      : ({ format: { type: 'text' } } as JsonValue)}

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools as JsonValue
    payload.tool_choice = metadata.toolChoice || 'auto'
  }
  if (Number.isFinite(temperature)) {
    payload.temperature = temperature
  }
  if (Number.isFinite(maxTokens)) {
    payload.max_output_tokens = maxTokens
  }

  if (metadata.openaiOptions && typeof metadata.openaiOptions === 'object') {
    Object.assign(payload, metadata.openaiOptions)
  }

  try {
    const response = (await client.responses.create(payload as never)) as OpenAIResponseLike
    return response
  } catch (error) {
    const err = error as Error & { status?: number; code?: string; type?: string }
    logWarn('AIGatewayService', 'OpenAI request failed', {
      provider: 'openai',
      model: route.model,
      status: err.status,
      code: err.code,
      type: err.type,
      message: err.message,
      baseURL,
      has_key: Boolean(key)})
    throw err
  }
}

async function callGemini(params: {
  route: SurfaceRoute
  system?: string
  messages: GatewayMessage[]
  jsonMode: boolean
  temperature: number
  maxTokens: number
  metadata: GatewayMetadata
}): Promise<GeminiResponse> {
  const { route, system, messages, jsonMode, temperature, maxTokens, metadata } = params
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured for aiGatewayService')
  }
  if (!route.model) {
    throw new Error('Gemini route missing model')
  }

  const body: JsonObject = {
    contents: toGeminiContents(messages) as JsonValue,
    generationConfig: buildGeminiGenerationConfig({ jsonMode, temperature, maxTokens, metadata })}

  if (system) {
    body.systemInstruction = { parts: [{ text: String(system) }] }
  }

  const response = await fetch(`${GEMINI_URL}/${route.model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)})

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`Gemini API error ${response.status}: ${text.slice(0, 400)}`) as Error & {
      status?: number
      code?: string
      provider?: string
      model?: string
      responseBody?: string
    }
    err.status = response.status
    err.code = 'GEMINI_API_ERROR'
    err.provider = 'gemini'
    err.model = route.model
    err.responseBody = text.slice(0, 2000)
    throw err
  }

  return (await response.json()) as GeminiResponse
}

async function executeProvider(params: {
  route: SurfaceRoute
  system?: string
  messages: GatewayMessage[]
  tools?: JsonObject[]
  jsonMode: boolean
  temperature: number
  maxTokens: number
  metadata: GatewayMetadata
}): Promise<ProviderResult> {
  const { route, system, messages, tools, jsonMode, temperature, maxTokens, metadata } = params

  if (route.provider === 'gemini') {
    const raw = await callGemini({
      route,
      ...(system !== undefined ? { system } : {}),
      messages,
      jsonMode,
      temperature,
      maxTokens,
      metadata
    })
    const candidate = raw.candidates?.[0]
    const text = (candidate?.content?.parts || [])
      .map((part) => part?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim()
    const usage = normalizeUsage('gemini', raw.usageMetadata)
    return { raw, text, usage, model: route.model, provider: route.provider }
  }

  const raw = await callOpenAI({
    route,
    messages,
    ...(tools !== undefined ? { tools } : {}),
    jsonMode,
    temperature,
    maxTokens,
    metadata
  })
  const text = readResponseText(raw).trim()
  const usage = normalizeUsage('openai', raw.usage)
  return { raw, text, usage, model: raw.model || route.model, provider: route.provider }
}

export async function generateText({
  orgId,
  surface,
  system,
  messages,
  tools,
  jsonMode = false,
  temperature = DEFAULT_TEMPERATURE,
  maxTokens = DEFAULT_MAX_TOKENS,
  metadata = {}}: GenerateTextArgs): Promise<GatewayResult> {
  const requestContext = getRequestContext() as RequestContextLike | null
  const requestId = metadata.requestId || requestContext?.requestId || crypto.randomUUID()
  const startedAt = Date.now()

  if (!orgId) {
    const err = new Error('AI gateway requires orgId for tenant-scoped policy enforcement') as GatewayError
    err.code = 'AI_GATEWAY_ORG_REQUIRED'
    err.status = 400
    err.requestId = requestId
    err.provider = 'none'
    err.model = 'none'
    err.fallbackUsed = false
    throw err
  }

  const route = buildSurfaceRoute({ orgId, surface, metadata })
  const effectiveMessages = Array.isArray(messages)
    ? messages
    : [{ role: 'user', content: String(messages || '') }]

  if (system && !effectiveMessages.some((message) => message?.role === 'system')) {
    effectiveMessages.unshift({ role: 'system', content: String(system) })
  }

  await enforceAiPolicyOrThrow({
    orgId,
    userId: metadata.userId || requestContext?.userId || null,
    data_source: metadata.data_source || DATA_SOURCES.USER_PROVIDED,
    source_integration: metadata.source_integration || String(surface || 'ai_gateway'),
    source_ref: metadata.source_ref || requestId,
    route: `aiGateway.generateText:${surface || 'unknown-surface'}`})

  let usedRoute: { provider: string; model: string } = route
  let fallbackUsed = false

  try {
    const result = await executeProvider({
      route,
      ...(system !== undefined ? { system } : {}),
      messages: effectiveMessages,
      ...(tools !== undefined ? { tools } : {}),
      jsonMode,
      temperature,
      maxTokens,
      metadata})

    const latencyMs = Date.now() - startedAt
    logDebug('AIGatewayService', 'generateText success', {
      request_id: requestId,
      org_id: orgId,
      surface,
      provider: result.provider,
      model: result.model,
      latency_ms: latencyMs,
      tokens_in: result.usage.input_tokens,
      tokens_out: result.usage.output_tokens,
      tokens_total: result.usage.total_tokens,
      fallback_used: false})

    return {
      requestId,
      provider: result.provider,
      model: result.model,
      text: result.text,
      raw: result.raw,
      usage: result.usage,
      latencyMs,
      fallbackUsed: false}
  } catch (primaryError) {
    const primary = primaryError as Error

    if (!route.fallback) {
      logError('AIGatewayService', 'generateText failed without fallback', primary, {
        request_id: requestId,
        org_id: orgId,
        surface,
        provider: route.provider,
        model: route.model,
        fallback_available: false,
        ...buildGeminiFailureDiagnostics({ route, jsonMode, temperature, maxTokens, metadata })})
      throw buildGatewayError(primary, route, requestId, false)
    }

    fallbackUsed = true
    usedRoute = {
      provider: route.fallback.provider || route.provider,
      model: route.fallback.model}

    logWarn('AIGatewayService', 'primary model failed, attempting explicit fallback', {
      request_id: requestId,
      org_id: orgId,
      surface,
      primary_provider: route.provider,
      primary_model: route.model,
      fallback_provider: usedRoute.provider,
      fallback_model: usedRoute.model,
      error: primary.message || 'request failed'})

    try {
      const fallbackResult = await executeProvider({
        route: { provider: usedRoute.provider, model: usedRoute.model, fallback: null },
        ...(system !== undefined ? { system } : {}),
        messages: effectiveMessages,
        ...(tools !== undefined ? { tools } : {}),
        jsonMode,
        temperature,
        maxTokens,
        metadata})

      const latencyMs = Date.now() - startedAt
      logDebug('AIGatewayService', 'generateText success via fallback', {
        request_id: requestId,
        org_id: orgId,
        surface,
        provider: fallbackResult.provider,
        model: fallbackResult.model,
        latency_ms: latencyMs,
        tokens_in: fallbackResult.usage.input_tokens,
        tokens_out: fallbackResult.usage.output_tokens,
        tokens_total: fallbackResult.usage.total_tokens,
        fallback_used: true})

      return {
        requestId,
        provider: fallbackResult.provider,
        model: fallbackResult.model,
        text: fallbackResult.text,
        raw: fallbackResult.raw,
        usage: fallbackResult.usage,
        latencyMs,
        fallbackUsed: true,
        fallback: {
          from: { provider: route.provider, model: route.model },
          to: { provider: fallbackResult.provider, model: fallbackResult.model }}}
    } catch (fallbackError) {
      const fallbackTyped = fallbackError as Error
      logError('AIGatewayService', 'generateText failed after explicit fallback', fallbackTyped, {
        request_id: requestId,
        org_id: orgId,
        surface,
        primary_provider: route.provider,
        primary_model: route.model,
        fallback_provider: usedRoute.provider,
        fallback_model: usedRoute.model})
      throw buildGatewayError(fallbackTyped, usedRoute, requestId, fallbackUsed)
    }
  }
}

export async function embed(): Promise<never> {
  throw new Error('aiGatewayService.embed is not implemented yet')
}

export async function searchWeb(): Promise<never> {
  throw new Error('aiGatewayService.searchWeb is not implemented yet')
}

const aiGatewayService = {
  generateText,
  embed,
  searchWeb}

export default aiGatewayService
