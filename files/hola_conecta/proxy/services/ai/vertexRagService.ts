/**
 * Vertex AI RAG Service
 *
 * Queries separate Vertex AI RAG corpora for Sofia internal help and public webchat.
 */

import { GoogleAuth, type JWTInput } from 'google-auth-library'
import { logError } from '../../utils/logger.js'

const PROJECT_ID = process.env.GCP_PROJECT_ID
const LOCATION = process.env.VERTEX_RAG_LOCATION || 'us-west4'
const INTERNAL_CORPUS_NAME = process.env.VERTEX_RAG_INTERNAL_CORPUS_NAME
const PUBLIC_CORPUS_NAME = process.env.VERTEX_RAG_PUBLIC_CORPUS_NAME

const VERTEX_RAG_CONCURRENCY = Math.max(1, Number.parseInt(process.env.VERTEX_RAG_CONCURRENCY || '2', 10) || 2)
const VERTEX_RAG_CACHE_TTL_MS = Math.max(1_000, Number.parseInt(process.env.VERTEX_RAG_CACHE_TTL_MS || '120000', 10) || 120000)
const VERTEX_RAG_CIRCUIT_MIN_MS = Math.max(1_000, Number.parseInt(process.env.VERTEX_RAG_CIRCUIT_MIN_MS || '30000', 10) || 30000)
const VERTEX_RAG_CIRCUIT_MAX_MS = Math.max(
  VERTEX_RAG_CIRCUIT_MIN_MS,
  Number.parseInt(process.env.VERTEX_RAG_CIRCUIT_MAX_MS || '60000', 10) || 60000,
)

const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const WEBSITE_ALLOWED_TOPIC_TYPES = new Set(['sales', 'pricing', 'promo', 'onboarding', 'feature', 'faq', 'objection'])

type RagProfile = 'internal' | 'public'

type Primitive = string | number | boolean | null | undefined

type LooseObject = Record<string, unknown>

export interface RagSearchInput {
  query: string
  limit?: number
}

export interface SofiaHelpDeskMatch {
  type: 'article'
  id: string
  title: string
  content: string
  category: string
  url: string | null
  sourceUri: string | null
  priority: number
  keywords: string[]
  relatedArticles: string[]
  topicType: string | null
  audience: string | null
  visibility: string | null
  summary: string | null
  details: string | null
  not_supported: string[]
}

interface RagMeta {
  cached: boolean
  cacheAgeMs?: number
  cacheTtlMs?: number
  durationMs?: number
  ragUnavailable?: boolean
  reason?: string | null
}

interface RagSearchResult {
  matches: SofiaHelpDeskMatch[]
  meta: RagMeta
}

interface CachedRagEntry {
  matches: SofiaHelpDeskMatch[]
  createdAt: number
  expiresAt: number
}

interface VertexContext {
  text?: string
  source_uri?: string
  distance?: number
}

interface VertexRetrieveResponse {
  contexts?: {
    contexts?: VertexContext[]
  }
}

interface ChunkMetadata {
  audience: string | null
  topicType: string | null
  visibility: string | null
}

interface VertexUnavailableError extends Error {
  name: 'VERTEX_RAG_UNAVAILABLE'
  status: 503
  statusCode: 503
  detail: string | null
}

interface HttpStatusError extends Error {
  status?: number
  statusCode?: number
  response?: { status?: number }
  statusText?: string
  errorBody?: string
}

let vertexUnavailableUntil = 0
const ragCache = new Map<string, CachedRagEntry>()
let cachedVertexAuthClientPromise: ReturnType<GoogleAuth['getClient']> | null = null

function nowMs(): number {
  return Date.now()
}

function randomInt(minInclusive: number, maxInclusive: number): number {
  const min = Math.ceil(minInclusive)
  const max = Math.floor(maxInclusive)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function openCircuitForRateLimit(): number {
  const duration = randomInt(VERTEX_RAG_CIRCUIT_MIN_MS, VERTEX_RAG_CIRCUIT_MAX_MS)
  vertexUnavailableUntil = nowMs() + duration
  return duration
}

function createVertexUnavailableError(message: string, detail: string | null = null): VertexUnavailableError {
  const error = new Error(message) as VertexUnavailableError
  error.name = 'VERTEX_RAG_UNAVAILABLE'
  error.status = 503
  error.statusCode = 503
  error.detail = detail
  return error
}

function asObject(value: unknown): LooseObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as LooseObject : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readObjectProperty(source: unknown, key: string): unknown {
  return asObject(source)?.[key]
}

function normalizeCacheKey(query: string, limit: number, profile: RagProfile): string {
  return `${profile}:${limit}:${query.trim().toLowerCase()}`
}

function getCachedResult(key: string): CachedRagEntry | null {
  const entry = ragCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= nowMs()) {
    ragCache.delete(key)
    return null
  }
  return entry
}

function setCachedResult(key: string, matches: SofiaHelpDeskMatch[]): void {
  ragCache.set(key, {
    matches,
    createdAt: nowMs(),
    expiresAt: nowMs() + VERTEX_RAG_CACHE_TTL_MS,
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '')
}

function isHttpStatusError(error: unknown): error is HttpStatusError {
  return error instanceof Error
}

function isRateLimitError(error: unknown): boolean {
  const status = isHttpStatusError(error) ? error.status ?? error.statusCode ?? error.response?.status : undefined
  if (status === 429) return true
  const message = getErrorMessage(error)
  return /\b429\b/.test(message) || /RESOURCE_EXHAUSTED/i.test(message) || /rate limit/i.test(message)
}

function createLimiter(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []

  const runNext = (): void => {
    if (active >= maxConcurrent) return
    const next = queue.shift()
    if (!next) return
    active++
    next()
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = async (): Promise<void> => {
        try {
          resolve(await fn())
        } catch (error) {
          reject(error)
        } finally {
          active--
          runNext()
        }
      }

      queue.push(task)
      runNext()
    })
  }
}

const ragLimiter = createLimiter(VERTEX_RAG_CONCURRENCY)

function getCorpusResourceName(corpusName: string): string {
  return `projects/${PROJECT_ID}/locations/${LOCATION}/ragCorpora/${corpusName}`
}

function parseServiceAccountCredentials(raw: string): JWTInput {
  const normalized = raw.trim()
  if (!normalized) {
    throw createVertexUnavailableError('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON', 'credentials_env_is_empty')
  }

  try {
    const parsed = JSON.parse(normalized) as unknown
    if (asObject(parsed)) return parsed as JWTInput

    if (typeof parsed === 'string') {
      const nested = JSON.parse(parsed) as unknown
      if (asObject(nested)) return nested as JWTInput
    }
  } catch (error) {
    const preview = normalized.slice(0, 40).replace(/\s+/g, ' ')
    throw createVertexUnavailableError(
      'Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON format',
      `length=${normalized.length};preview=${preview};cause=${getErrorMessage(error) || 'parse_failed'}`,
    )
  }

  throw createVertexUnavailableError(
    'Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON format',
    `length=${normalized.length};preview=${normalized.slice(0, 40).replace(/\s+/g, ' ')};cause=not_object`,
  )
}

async function createVertexAuthClient(): ReturnType<GoogleAuth['getClient']> {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON

  if (!serviceAccountJson) {
    throw createVertexUnavailableError('Missing Vertex Google credentials', 'expected GOOGLE_APPLICATION_CREDENTIALS_JSON')
  }

  const auth = new GoogleAuth({
    credentials: parseServiceAccountCredentials(serviceAccountJson),
    scopes: [GOOGLE_CLOUD_SCOPE],
  })
  return auth.getClient()
}

async function getVertexAuthClient(): ReturnType<GoogleAuth['getClient']> {
  if (!cachedVertexAuthClientPromise) {
    cachedVertexAuthClientPromise = createVertexAuthClient().catch((error) => {
      cachedVertexAuthClientPromise = null
      throw error
    })
  }

  return cachedVertexAuthClientPromise
}

async function getAccessToken(): Promise<string> {
  const client = await getVertexAuthClient()
  const tokenResponse = await client.getAccessToken()
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token

  if (!token) {
    throw createVertexUnavailableError('Failed to obtain Vertex access token', 'empty_access_token')
  }

  return token
}

export async function searchVertexRag({ query, limit = 5 }: RagSearchInput): Promise<SofiaHelpDeskMatch[]> {
  const { matches } = await searchInternalSofiaRag({ query, limit })
  return matches
}

function normalizeContentArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function firstNonEmptyString(...values: Primitive[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function parseLooseKeyValueText(text: string): LooseObject {
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const result: LooseObject = {}
  const content: LooseObject = {}
  const vertexMeta: LooseObject = {}

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_&.-]+(?:\s+[A-Za-z0-9_&.-]+)*)\s+(.+)$/)
    if (!match) continue

    const rawKey = match[1]
    const rawValue = match[2]
    if (!rawKey || !rawValue) continue

    const key = rawKey.trim().toLowerCase()
    const value = rawValue.trim()

    if (key.startsWith('content ')) {
      const contentKey = key.slice('content '.length).trim().replace(/\s+/g, '_')
      if (contentKey) content[contentKey] = value
      continue
    }

    if (key.startsWith('vertex_meta ')) {
      const metaKey = key.slice('vertex_meta '.length).trim().replace(/\s+/g, '_')
      if (metaKey) vertexMeta[metaKey] = value
      continue
    }

    result[key.replace(/\s+/g, '_')] = value
  }

  if (Object.keys(content).length) result.content = content
  if (Object.keys(vertexMeta).length) result.vertex_meta = vertexMeta
  return result
}

function getNestedMetadata(content: unknown): LooseObject {
  const contentObject = asObject(content)
  if (!contentObject) return {}
  return asObject(contentObject.vertex_meta) || asObject(contentObject.metadata) || contentObject
}

function getChunkMetadata(chunkData: LooseObject, content: unknown): ChunkMetadata {
  const contentObject = asObject(content)
  const contentMetadata = getNestedMetadata(content)
  const textMetadata = typeof content === 'string' ? parseLooseKeyValueText(content) : {}
  const parsedVertexMeta = asObject(textMetadata.vertex_meta) || textMetadata

  return {
    audience: firstNonEmptyString(
      readString(chunkData.audience),
      readString(chunkData.audience_type),
      readString(contentObject?.audience),
      readString(asObject(contentObject?.vertex_meta)?.audience),
      readString(contentMetadata.audience),
      readString(contentMetadata.audience_type),
      readString(textMetadata.audience),
      readString(textMetadata.audience_type),
      readString(parsedVertexMeta.audience),
      readString(parsedVertexMeta.audience_type),
    ) || null,
    topicType: firstNonEmptyString(
      readString(chunkData.topic_type),
      readString(chunkData.topicType),
      readString(contentObject?.topic_type),
      readString(contentObject?.topicType),
      readString(asObject(contentObject?.vertex_meta)?.topic_type),
      readString(asObject(contentObject?.vertex_meta)?.topicType),
      readString(contentMetadata.topic_type),
      readString(contentMetadata.topicType),
      readString(textMetadata.topic_type),
      readString(textMetadata.topicType),
      readString(parsedVertexMeta.topic_type),
      readString(parsedVertexMeta.topicType),
    ) || null,
    visibility: firstNonEmptyString(
      readString(chunkData.visibility),
      readString(contentObject?.visibility),
      readString(asObject(contentObject?.vertex_meta)?.visibility),
      readString(contentMetadata.visibility),
      readString(textMetadata.visibility),
      readString(parsedVertexMeta.visibility),
    ) || null,
  }
}

function buildSupportContent(content: unknown): string {
  if (typeof content === 'string') return content
  const contentObject = asObject(content)
  if (!contentObject) return ''

  const lines: string[] = []
  if (contentObject.summary) {
    lines.push(`SUMMARY:\n${String(contentObject.summary).trim()}`)
  }

  const keyPoints = normalizeContentArray(contentObject.key_points)
  if (keyPoints.length) {
    lines.push(`KEY POINTS:\n- ${keyPoints.join('\n- ')}`)
  }

  const details = normalizeContentArray(contentObject.details)
  if (details.length) {
    lines.push(`DETAILS:\n- ${details.join('\n- ')}`)
  }

  const commonQuestions = normalizeContentArray(contentObject.common_questions)
  if (commonQuestions.length) {
    lines.push(`COMMON QUESTIONS:\n- ${commonQuestions.join('\n- ')}`)
  }

  if (contentObject.cta) {
    lines.push(`CTA:\n${String(contentObject.cta).trim()}`)
  }

  return lines.join('\n\n').trim()
}

function buildWebsiteContent(content: unknown): string {
  if (typeof content === 'string') return content
  const contentObject = asObject(content)
  if (!contentObject) return ''

  const lines: string[] = []
  if (contentObject.summary) {
    lines.push(`SUMMARY:\n${String(contentObject.summary).trim()}`)
  }

  const keyPoints = normalizeContentArray(contentObject.key_points).slice(0, 8)
  if (keyPoints.length) {
    lines.push(`KEY POINTS:\n- ${keyPoints.join('\n- ')}`)
  }

  const commonQuestions = normalizeContentArray(contentObject.common_questions).slice(0, 5)
  if (commonQuestions.length) {
    lines.push(`COMMON QUESTIONS:\n- ${commonQuestions.join('\n- ')}`)
  }

  if (!lines.length) {
    const details = normalizeContentArray(contentObject.details).slice(0, 3)
    if (details.length) {
      lines.push(`DETAILS:\n- ${details.join('\n- ')}`)
    }
  }

  if (contentObject.cta) {
    lines.push(`CTA:\n${String(contentObject.cta).trim()}`)
  }

  return lines.join('\n\n').trim()
}

function chunkAllowedForProfile(chunkData: SofiaHelpDeskMatch, profile: RagProfile): boolean {
  const parsedText = typeof chunkData.content === 'string' ? parseLooseKeyValueText(chunkData.content) : {}
  const parsedVertexMeta = asObject(parsedText.vertex_meta) || parsedText
  const audience = String(chunkData.audience || parsedVertexMeta.audience || '').trim().toLowerCase()
  const topicType = String(chunkData.topicType || parsedVertexMeta.topic_type || parsedVertexMeta.topicType || '').trim().toLowerCase()
  const visibility = String(chunkData.visibility || parsedVertexMeta.visibility || '').trim().toLowerCase()

  if (profile === 'public') {
    return audience === 'public' && visibility === 'public' && WEBSITE_ALLOWED_TOPIC_TYPES.has(topicType)
  }

  return true
}

function parseVertexRetrieveResponse(value: unknown): VertexRetrieveResponse {
  const root = asObject(value)
  const contextsRoot = asObject(root?.contexts)
  const contextsValue = contextsRoot?.contexts
  const contexts = Array.isArray(contextsValue)
    ? contextsValue.map((item): VertexContext => {
      const source = asObject(item) || {}
      return {
        text: readString(source.text),
        source_uri: readString(source.source_uri),
        distance: readNumber(source.distance),
      }
    })
    : []

  return { contexts: { contexts } }
}

async function searchSofiaRag({ query, limit = 5, profile, corpusName }: RagSearchInput & {
  profile: RagProfile
  corpusName?: string
}): Promise<RagSearchResult> {
  if (!PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID environment variable is required')
  }

  if (!corpusName) {
    throw createVertexUnavailableError(
      `Missing Vertex RAG corpus for ${profile}`,
      `expected VERTEX_RAG_${profile === 'public' ? 'PUBLIC' : 'INTERNAL'}_CORPUS_NAME`,
    )
  }

  const startTime = nowMs()

  if (vertexUnavailableUntil > startTime) {
    throw createVertexUnavailableError(
      'Vertex RAG circuit is open',
      `retry_after_ms=${Math.max(0, vertexUnavailableUntil - startTime)}`,
    )
  }

  const effectiveLimit = Math.max(1, Math.min(Math.trunc(limit), 10))
  const cacheKey = normalizeCacheKey(query, effectiveLimit, profile)
  const cached = getCachedResult(cacheKey)
  if (cached) {
    return {
      matches: cached.matches,
      meta: {
        cached: true,
        cacheAgeMs: Math.max(0, startTime - cached.createdAt),
        cacheTtlMs: VERTEX_RAG_CACHE_TTL_MS,
      },
    }
  }

  try {
    return await ragLimiter(async () => {
      const accessToken = await getAccessToken()
      const corpusResourceName = getCorpusResourceName(corpusName)
      const url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}:retrieveContexts`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vertex_rag_store: {
            rag_resources: [{ rag_corpus: corpusResourceName }],
          },
          query: {
            text: query,
            similarity_top_k: effectiveLimit * 2,
          },
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        const error = new Error(
          `Vertex RAG API error: ${response.status} ${response.statusText} - ${errorText || 'No details'}`,
        ) as HttpStatusError
        error.status = response.status
        error.statusText = response.statusText
        error.errorBody = errorText || 'empty'

        logError('VertexRagService', 'RAG API error', error, {
          status: response.status,
          statusText: response.statusText,
          url,
          corpusName: corpusResourceName,
          query: query.slice(0, 100),
          errorBody: errorText || 'empty',
        })
        throw error
      }

      const data = parseVertexRetrieveResponse(await response.json())
      const contexts = data.contexts?.contexts || []
      const transformed = contexts.map((context, index) => transformRagContext(context, index, profile))
      const results = transformed.filter((result) => chunkAllowedForProfile(result, profile)).slice(0, effectiveLimit)

      setCachedResult(cacheKey, results)

      return { matches: results, meta: { cached: false, durationMs: nowMs() - startTime } }
    })
  } catch (error) {
    const duration = nowMs() - startTime

    if (isRateLimitError(error)) {
      const circuitMs = openCircuitForRateLimit()
      throw createVertexUnavailableError('Vertex RAG rate limited', `retry_after_ms=${circuitMs}`)
    }

    logError('VertexRagService', 'RAG search failed', error, {
      query: query.slice(0, 80),
      durationMs: duration,
    })

    throw error
  }
}

export async function searchInternalSofiaRag({ query, limit = 5 }: RagSearchInput): Promise<RagSearchResult> {
  return searchSofiaRag({
    query,
    limit,
    profile: 'internal',
    ...(INTERNAL_CORPUS_NAME !== undefined ? { corpusName: INTERNAL_CORPUS_NAME } : {}),
  })
}

export async function searchPublicSofiaRag({ query, limit = 5 }: RagSearchInput): Promise<RagSearchResult> {
  return searchSofiaRag({
    query,
    limit,
    profile: 'public',
    ...(PUBLIC_CORPUS_NAME !== undefined ? { corpusName: PUBLIC_CORPUS_NAME } : {}),
  })
}

function transformRagContext(context: VertexContext, index: number, profile: RagProfile = 'internal'): SofiaHelpDeskMatch {
  const text = context.text || ''
  const sourceUri = context.source_uri || ''
  const distance = context.distance || 0

  let chunkData: LooseObject
  try {
    chunkData = asObject(JSON.parse(text) as unknown) || {}
  } catch {
    chunkData = parseLooseKeyValueText(text)
    chunkData.content = text
  }

  const content = readObjectProperty(chunkData, 'content') || chunkData
  const contentObject = asObject(content)
  const metadata = getChunkMetadata(chunkData, content)
  const parsedTitle = text.match(/^title\s+(.+)$/im)?.[1]?.trim() || ''
  const parsedChunkId = text.match(/^chunk_id\s+(.+)$/im)?.[1]?.trim() || ''
  const summary = readString(contentObject?.summary).trim() || null
  const details = normalizeContentArray(contentObject?.details)
  const formattedContent = profile === 'public' ? buildWebsiteContent(content) : buildSupportContent(content)
  const keywords = normalizeContentArray(contentObject?.keywords)
  const notSupported = normalizeContentArray(contentObject?.not_supported)

  return {
    type: 'article',
    id: readString(chunkData.chunk_id) || parsedChunkId || readString(contentObject?.page_key) || `vertex-${index}`,
    title: readString(chunkData.title) || parsedTitle || readString(contentObject?.title) || 'Help Article',
    content: formattedContent || (typeof content === 'string' ? content : JSON.stringify(content, null, 2)),
    category: readString(chunkData.topic_type) || readString(contentObject?.page_key) || 'Help',
    url: readString(contentObject?.route_url) || sourceUri || null,
    sourceUri: sourceUri || null,
    priority: Math.round((1 - distance) * 100),
    keywords,
    relatedArticles: [],
    topicType: metadata.topicType,
    audience: metadata.audience,
    visibility: metadata.visibility,
    summary,
    details: details.length ? details.join('\n') : null,
    not_supported: notSupported,
  }
}

export async function healthCheck(): Promise<{ healthy: boolean; error?: string; corpus?: string }> {
  try {
    if (!PROJECT_ID) {
      return { healthy: false, error: 'GCP_PROJECT_ID not configured' }
    }

    if (!INTERNAL_CORPUS_NAME) {
      return { healthy: false, error: 'VERTEX_RAG_INTERNAL_CORPUS_NAME not configured' }
    }

    const accessToken = await getAccessToken()
    const corpusName = getCorpusResourceName(INTERNAL_CORPUS_NAME)
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${corpusName}:retrieveContexts`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        vertex_rag_store: {
          rag_resources: [{ rag_corpus: corpusName }],
        },
        query: {
          text: 'health check',
          similarity_top_k: 1,
        },
      }),
    })

    if (response.ok) {
      return { healthy: true, corpus: corpusName }
    }

    return { healthy: false, error: await response.text() }
  } catch (error) {
    return { healthy: false, error: getErrorMessage(error) }
  }
}

export default {
  searchVertexRag,
  searchInternalSofiaRag,
  searchPublicSofiaRag,
  healthCheck,
}
