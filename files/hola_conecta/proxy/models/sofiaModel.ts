import { sql } from '../db/neon.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import { isValidUUID } from '../utils/validation.js'
import {
  searchInternalSofiaRag,
  searchPublicSofiaRag} from '../services/ai/vertexRagService.ts'
import { requiredRow } from '../utils/strictTyping.ts'
import type {
  SofiaDraftArticleInput,
  SofiaDraftArticleRow,
  SofiaHelpDeskMatch,
  SofiaInteractionMeta,
  SofiaInteractionRow} from '../types/sofia.js'

type QueryableSql = typeof sql & {
  query: (
    queryText: string,
    params?: Array<string | number | boolean | null | Date | object | undefined>,
  ) => Promise<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>
}

const queryableSql = sql as QueryableSql

function toRowArray<T>(result: { rows?: Record<string, unknown>[] } | Record<string, unknown>[]): T[] {
  return (Array.isArray(result) ? result : (result.rows ?? [])) as T[]
}

function normalizeUuid(value: string | null): string | null {
  return value && isValidUUID(value) ? value : null
}

export async function createInteraction({
  orgId = null,
  userId = null,
  sessionId,
  requestId,
  channel = 'sofia',
  inputText,
  outputText,
  rating = null,
  reason = null,
  comment = null,
  meta = {}}: {
  orgId?: string | null
  userId?: string | null
  sessionId: string
  requestId: string
  channel?: string
  inputText: string
  outputText: string | null
  rating?: number | null
  reason?: string | null
  comment?: string | null
  meta?: SofiaInteractionMeta
}): Promise<SofiaInteractionRow> {
  try {
    const orgUuid = normalizeUuid(orgId)
    const userUuid = normalizeUuid(userId)

    const query = `
      INSERT INTO ai_support_feedback (
        org_id,
        user_id,
        session_id,
        request_id,
        channel,
        input_text,
        output_text,
        rating,
        reason,
        comment,
        meta
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
      ON CONFLICT (request_id) DO UPDATE SET
        output_text = EXCLUDED.output_text,
        rating = EXCLUDED.rating,
        reason = EXCLUDED.reason,
        comment = EXCLUDED.comment,
        meta = COALESCE(ai_support_feedback.meta, '{}'::jsonb) || EXCLUDED.meta,
        updated_at = NOW()
      RETURNING *;
    `

    const params = [
      orgUuid,
      userUuid,
      sessionId,
      requestId,
      channel,
      inputText,
      outputText,
      rating,
      reason,
      comment,
      meta,
    ]

    const result = await queryableSql.query(query, params)
    const row = requiredRow(toRowArray<SofiaInteractionRow>(result)[0], 'Sofia interaction upsert did not return a row')

    logInfo('SofiaModel', 'Interaction stored', { requestId, orgId, userId, channel })
    return row
  } catch (error) {
    logError('SofiaModel', 'Failed to store interaction', error, { orgId, requestId })
    throw error
  }
}

export async function updateFeedbackByRequestId({
  orgId = null,
  requestId,
  rating,
  reason = null,
  comment = null}: {
  orgId?: string | null
  requestId: string
  rating: number | null | undefined
  reason?: string | null
  comment?: string | null
}): Promise<SofiaInteractionRow | null> {
  try {
    const orgUuid = normalizeUuid(orgId)
    const query = orgUuid
      ? `UPDATE ai_support_feedback
         SET rating = $1,
             reason = $2,
             comment = $3,
             updated_at = NOW()
         WHERE request_id = $4
           AND org_id = $5
         RETURNING *;`
      : `UPDATE ai_support_feedback
         SET rating = $1,
             reason = $2,
             comment = $3,
             updated_at = NOW()
         WHERE request_id = $4
         RETURNING *;`

    const params = orgUuid ? [rating, reason, comment, requestId, orgUuid] : [rating, reason, comment, requestId]
    const result = await queryableSql.query(query, params)
    const row = toRowArray<SofiaInteractionRow>(result)[0]

    return row || null
  } catch (error) {
    logError('SofiaModel', 'Failed to update feedback', error, { orgId, requestId })
    throw error
  }
}

export async function updateFeedbackByInteractionIdentifier({
  orgId,
  interactionIdentifier,
  rating,
  reason = null,
  comment = null}: {
  orgId: string
  interactionIdentifier: string
  rating: number | null | undefined
  reason?: string | null
  comment?: string | null
}): Promise<SofiaInteractionRow | null> {
  try {
    const orgUuid = normalizeUuid(orgId)
    if (!orgUuid) {
      logWarn('SofiaModel', 'Feedback update skipped because org id was invalid', {
        hasOrgId: Boolean(orgId),
        hasInteractionIdentifier: Boolean(interactionIdentifier)
      })
      return null
    }

    const query = `
      UPDATE ai_support_feedback
      SET rating = $1,
          reason = $2,
          comment = $3,
          updated_at = NOW()
      WHERE org_id = $4
        AND (
          id::text = $5
          OR request_id = $5
        )
      RETURNING *;
    `

    const params = [rating, reason, comment, orgUuid, interactionIdentifier]
    const result = await queryableSql.query(query, params)
    const row = toRowArray<SofiaInteractionRow>(result)[0]

    if (!row) {
      logWarn('SofiaModel', 'Feedback interaction lookup missed', {
        orgId: orgUuid,
        identifierType: isValidUUID(interactionIdentifier) ? 'uuid' : 'non_uuid',
        hasInteractionIdentifier: Boolean(interactionIdentifier)
      })
    }

    return row || null
  } catch (error) {
    logError('SofiaModel', 'Failed to update feedback by interaction identifier', error, {
      orgId,
      identifierType: isValidUUID(interactionIdentifier) ? 'uuid' : 'non_uuid',
      hasInteractionIdentifier: Boolean(interactionIdentifier)
    })
    throw error
  }
}

export async function getRecentInteractions({
  orgId = null,
  days = 7,
  limit = 5000}: {
  orgId?: string | null
  days?: number
  limit?: number
}): Promise<SofiaInteractionRow[]> {
  try {
    const orgUuid = normalizeUuid(orgId)
    const query = orgUuid
      ? `SELECT *
         FROM ai_support_feedback
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND org_id = $2
         ORDER BY created_at DESC
         LIMIT $3`
      : `SELECT *
         FROM ai_support_feedback
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY created_at DESC
         LIMIT $2`

    const params = orgUuid ? [days, orgUuid, limit] : [days, limit]
    const result = await queryableSql.query(query, params)
    return toRowArray<SofiaInteractionRow>(result)
  } catch (error) {
    logError('SofiaModel', 'Failed to fetch recent interactions', error, { orgId, days })
    throw error
  }
}

export async function getSessionInteractions({
  orgId = null,
  sessionId,
  channel = 'sofia',
  limit = 20}: {
  orgId?: string | null
  sessionId: string
  channel?: string
  limit?: number
}): Promise<Array<Pick<SofiaInteractionRow, 'request_id' | 'input_text' | 'output_text' | 'created_at'>>> {
  if (!sessionId) return []
  try {
    const orgUuid = normalizeUuid(orgId)
    const query = orgUuid
      ? `SELECT request_id, input_text, output_text, created_at
         FROM ai_support_feedback
         WHERE org_id = $1
           AND session_id = $2
           AND channel = $3
         ORDER BY created_at ASC
         LIMIT $4`
      : `SELECT request_id, input_text, output_text, created_at
         FROM ai_support_feedback
         WHERE session_id = $1
           AND channel = $2
         ORDER BY created_at ASC
         LIMIT $3`

    const params = orgUuid
      ? [orgUuid, sessionId, channel, limit]
      : [sessionId, channel, limit]

    const result = await queryableSql.query(query, params)
    return toRowArray<Pick<SofiaInteractionRow, 'request_id' | 'input_text' | 'output_text' | 'created_at'>>(result)
  } catch (error) {
    logError('SofiaModel', 'Failed to fetch session interactions', error, { orgId, sessionId, channel })
    return []
  }
}

async function searchSofiaRag({
  orgId = null,
  query,
  limit = 5,
  profile}: {
  orgId?: string | null
  query: string
  limit?: number
  profile: 'internal' | 'public'
}): Promise<SofiaHelpDeskMatch[]> {
  const raw = query.trim()
  if (!raw) return []

  try {
    const effectiveLimit = Math.min(Math.max(Number(limit) || 5, 1), 10)
    const { matches, meta } = profile === 'public'
      ? await searchPublicSofiaRag({ query: raw, limit: effectiveLimit })
      : await searchInternalSofiaRag({ query: raw, limit: effectiveLimit })

    if (meta?.ragUnavailable) {
      const unavailableError = new Error(`Vertex RAG unavailable: ${meta.reason || 'unknown'}`) as Error & {
        status?: number
        detail?: string | null
      }
      unavailableError.status = 503
      unavailableError.detail = meta.reason || null
      throw unavailableError
    }

    logInfo('SofiaModel', 'Vertex RAG help desk search completed', {
      orgId,
      profile,
      query: raw.slice(0, 80),
      count: matches.length,
      titles: matches.slice(0, 4).map((match: { title?: string }) => match.title),
      topicTypes: matches.slice(0, 4).map((match: { topicType?: string | null }) => match.topicType || null),
      audiences: matches.slice(0, 4).map((match: { audience?: string | null }) => match.audience || null),
      visibilities: matches.slice(0, 4).map((match: { visibility?: string | null }) => match.visibility || null),
      ragUnavailable: Boolean(meta?.ragUnavailable),
      ragReason: meta?.reason || null,
      cached: Boolean(meta?.cached)})

    return matches as SofiaHelpDeskMatch[]
  } catch (error) {
    logError('SofiaModel', 'Failed to search help desk', error, { orgId })
    throw error
  }
}

export async function searchInternalHelpDesk({
  orgId = null,
  query,
  limit = 5}: {
  orgId?: string | null
  query: string
  limit?: number
}): Promise<SofiaHelpDeskMatch[]> {
  return searchSofiaRag({ orgId, query, limit, profile: 'internal' })
}

export async function searchPublicHelpDesk({
  orgId = null,
  query,
  limit = 5}: {
  orgId?: string | null
  query: string
  limit?: number
}): Promise<SofiaHelpDeskMatch[]> {
  return searchSofiaRag({ orgId, query, limit, profile: 'public' })
}

export async function insertHelpDeskDrafts({
  orgId = null,
  drafts = []}: {
  orgId?: string | null
  drafts?: SofiaDraftArticleInput[]
}): Promise<SofiaDraftArticleRow[]> {
  if (!drafts.length) return []

  try {
    const orgUuid = normalizeUuid(orgId)
    const titles = drafts.map((draft) => draft.title)
    const existingRows = orgUuid
      ? (await sql`
          SELECT title
          FROM help_desk_articles
          WHERE status = 'draft'
            AND category = 'Sofia Autolearn'
            AND org_id = ${orgUuid}::uuid
            AND title = ANY(${titles})
        `) as Array<{ title: string }>
      : (await sql`
          SELECT title
          FROM help_desk_articles
          WHERE status = 'draft'
            AND category = 'Sofia Autolearn'
            AND org_id IS NULL
            AND title = ANY(${titles})
        `) as Array<{ title: string }>

    const existingTitles = new Set(existingRows.map((row) => row.title))
    const filteredDrafts = drafts.filter((draft) => !existingTitles.has(draft.title))
    if (!filteredDrafts.length) return []

    const results = await Promise.all(filteredDrafts.map((draft) =>
      sql`
        INSERT INTO help_desk_articles (
          article_id,
          title,
          category,
          content,
          keywords,
          url,
          is_published,
          priority,
          org_id,
          status
        )
        VALUES (
          gen_random_uuid()::text,
          ${draft.title},
          ${draft.category || 'General'},
          ${draft.content},
          ${draft.keywords || []},
          ${draft.url || '/help-desk'},
          false,
          ${draft.priority || 0},
          ${orgUuid},
          'draft'
        )
        RETURNING article_id, title, category, org_id
      `
    ))

    const rows = results.map((result) => {
      const row = result[0] as { article_id?: string; title?: string; category?: string | null; org_id?: string | null }
      return {
        article_id: String(row.article_id || ''),
        title: String(row.title || ''),
        category: row.category || null,
        org_id: row.org_id || null,
      } as SofiaDraftArticleRow
    })

    logInfo('SofiaModel', 'Draft help desk articles inserted', {
      count: rows.length,
      orgId})

    return rows
  } catch (error) {
    logError('SofiaModel', 'Failed to insert help desk drafts', error, { orgId })
    throw error
  }
}
