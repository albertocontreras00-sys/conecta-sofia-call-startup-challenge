import { sql } from '../db/neon.js'
import { logError, logInfo, logWarn } from '../utils/logger.js'
import type { SofiaFlags, SofiaModeSettingsRecord } from '../types/sofia.js'

const DEFAULT_FLAGS: SofiaFlags = {
  debug: false,
  facebook_live: false,
  demo: false,
  verbose_logs: false,
  allow_write_tools: true,
  founder_mode: false}

interface CacheEntry {
  data: SofiaModeSettingsRecord
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 15000

function getCacheKey(orgId: string): string {
  return `sofia_mode_${orgId}`
}

function getCached(orgId: string): SofiaModeSettingsRecord | null {
  const key = getCacheKey(orgId)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache(orgId: string, data: SofiaModeSettingsRecord): void {
  const key = getCacheKey(orgId)
  cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS})
}

function invalidateCache(orgId: string): void {
  cache.delete(getCacheKey(orgId))
}

function normalizeRecord(row: Partial<SofiaModeSettingsRecord> | undefined): SofiaModeSettingsRecord {
  return {
    flags: { ...DEFAULT_FLAGS, ...(row?.flags ?? {}) },
    updated_at: row?.updated_at ?? new Date().toISOString(),
    updated_by_email: row?.updated_by_email ?? null}
}

export async function getModeSettings(orgId: string): Promise<SofiaModeSettingsRecord> {
  if (!orgId) {
    throw new Error('orgId is required')
  }

  const cached = getCached(orgId)
  if (cached) {
    logInfo('SofiaModeSettings', 'Cache hit', { orgId })
    return cached
  }

  try {
    const rows = (await sql`
      SELECT flags, updated_at, updated_by_email
      FROM sofia_mode_settings
      WHERE org_id = ${orgId}
    `) as SofiaModeSettingsRecord[]

    if (rows.length === 0) {
      const defaultRow = (await sql`
        INSERT INTO sofia_mode_settings (org_id, flags)
        VALUES (${orgId}, ${JSON.stringify(DEFAULT_FLAGS)}::jsonb)
        ON CONFLICT (org_id) DO NOTHING
        RETURNING flags, updated_at, updated_by_email
      `) as SofiaModeSettingsRecord[]

      const result = normalizeRecord(defaultRow[0])
      setCache(orgId, result)
      logInfo('SofiaModeSettings', 'Created default settings', { orgId })
      return result
    }

    const result = normalizeRecord(rows[0])
    setCache(orgId, result)
    logInfo('SofiaModeSettings', 'Loaded settings', { orgId, flags: Object.keys(result.flags) })
    return result
  } catch (error) {
    logError('SofiaModeSettings', 'Failed to get settings', error, { orgId })
    throw error
  }
}

export async function updateModeSettings(
  orgId: string,
  flags: Partial<SofiaFlags>,
  updatedByUid: string | null,
  updatedByEmail: string | null,
): Promise<SofiaModeSettingsRecord> {
  if (!orgId) {
    throw new Error('orgId is required')
  }
  if (!flags || typeof flags !== 'object') {
    throw new Error('flags must be an object')
  }

  const allowedFlags = Object.keys(DEFAULT_FLAGS) as Array<keyof SofiaFlags>
  const providedFlags = Object.keys(flags)
  const unknownFlags = providedFlags.filter((flag) => !allowedFlags.includes(flag as keyof SofiaFlags))

  if (unknownFlags.length > 0) {
    logWarn('SofiaModeSettings', 'Ignoring unknown flags', { orgId, unknownFlags })
  }

  const validFlags = {} as Partial<SofiaFlags>
  for (const key of allowedFlags) {
    if (key in flags) {
      validFlags[key] = Boolean(flags[key])
    }
  }

  try {
    const rows = (await sql`
      INSERT INTO sofia_mode_settings (org_id, flags, updated_by_uid, updated_by_email, updated_at)
      VALUES (
        ${orgId},
        ${JSON.stringify({ ...DEFAULT_FLAGS, ...validFlags })}::jsonb,
        ${updatedByUid || null},
        ${updatedByEmail || null},
        NOW()
      )
      ON CONFLICT (org_id) DO UPDATE SET
        flags = sofia_mode_settings.flags || ${JSON.stringify(validFlags)}::jsonb,
        updated_by_uid = EXCLUDED.updated_by_uid,
        updated_by_email = EXCLUDED.updated_by_email,
        updated_at = NOW()
      RETURNING flags, updated_at, updated_by_email
    `) as SofiaModeSettingsRecord[]

    const result = normalizeRecord(rows[0])
    invalidateCache(orgId)

    logInfo('SofiaModeSettings', 'Updated settings', {
      orgId,
      updatedFlags: Object.keys(validFlags),
      updatedByEmail})

    return result
  } catch (error) {
    logError('SofiaModeSettings', 'Failed to update settings', error, { orgId })
    throw error
  }
}

export function getDefaultFlags(): SofiaFlags {
  return { ...DEFAULT_FLAGS }
}

export default {
  getModeSettings,
  updateModeSettings,
  getDefaultFlags}
