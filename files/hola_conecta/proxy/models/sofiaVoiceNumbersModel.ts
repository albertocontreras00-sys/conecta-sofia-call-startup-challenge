import { sql } from '../db/neon.js';
import { logError } from '../utils/logger.js';
import type { JsonObject } from '../types/json.ts';

export type SofiaVoiceNumberProvider = 'infobip';
export type SofiaVoiceNumberStatus = 'active' | 'inactive' | 'retired';

export interface SofiaVoiceNumberRow {
  id: string;
  org_id: string;
  phone_e164: string;
  provider: SofiaVoiceNumberProvider;
  status: SofiaVoiceNumberStatus;
  label: string | null;
  infobip_number_id: string | null;
  websocket_endpoint_config_id: string | null;
  default_language: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  created_by_uid: string | null;
  updated_by_uid: string | null;
  deactivated_at: string | null;
}

export interface FindActiveSofiaVoiceNumbersInput {
  phoneE164: string;
  provider: SofiaVoiceNumberProvider;
  limit?: number;
}

const DEFAULT_LIMIT = 2;

export async function findActiveSofiaVoiceNumbers({
  phoneE164,
  provider,
  limit = DEFAULT_LIMIT
}: FindActiveSofiaVoiceNumbersInput): Promise<SofiaVoiceNumberRow[]> {
  try {
    return await sql<SofiaVoiceNumberRow>`
      SELECT
        id,
        org_id,
        phone_e164,
        provider,
        status,
        label,
        infobip_number_id,
        websocket_endpoint_config_id,
        default_language,
        metadata,
        created_at,
        updated_at,
        created_by_uid,
        updated_by_uid,
        deactivated_at
      FROM sofia_voice_numbers
      WHERE phone_e164 = ${phoneE164}
        AND provider = ${provider}
        AND status = 'active'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
  } catch (error) {
    logError('SofiaVoiceNumbersModel', 'Failed to find active Sofia voice number route', error, {
      provider,
      routePhoneLast4: phoneE164.replace(/\D/g, '').slice(-4)
    });
    throw error;
  }
}

export async function findActiveSofiaVoiceNumbersByOrg(
  orgId: string,
  provider: SofiaVoiceNumberProvider = 'infobip',
  limit = DEFAULT_LIMIT
): Promise<SofiaVoiceNumberRow[]> {
  try {
    return await sql<SofiaVoiceNumberRow>`
      SELECT
        id,
        org_id,
        phone_e164,
        provider,
        status,
        label,
        infobip_number_id,
        websocket_endpoint_config_id,
        default_language,
        metadata,
        created_at,
        updated_at,
        created_by_uid,
        updated_by_uid,
        deactivated_at
      FROM sofia_voice_numbers
      WHERE org_id = ${orgId}::uuid
        AND provider = ${provider}
        AND status = 'active'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
  } catch (error) {
    logError('SofiaVoiceNumbersModel', 'Failed to find active Sofia voice number routes by org', error, {
      orgId,
      provider,
    });
    throw error;
  }
}

export async function findSofiaVoiceNumberByOrg(
  orgId: string,
  routeId: string
): Promise<SofiaVoiceNumberRow | null> {
  try {
    const rows = await sql<SofiaVoiceNumberRow>`
      SELECT
        id,
        org_id,
        phone_e164,
        provider,
        status,
        label,
        infobip_number_id,
        websocket_endpoint_config_id,
        default_language,
        metadata,
        created_at,
        updated_at,
        created_by_uid,
        updated_by_uid,
        deactivated_at
      FROM sofia_voice_numbers
      WHERE org_id = ${orgId}::uuid
        AND id = ${routeId}::uuid
      LIMIT 1
    `;
    return rows[0] || null;
  } catch (error) {
    logError('SofiaVoiceNumbersModel', 'Failed to find Sofia voice route by org', error, {
      orgId,
      routeId
    });
    throw error;
  }
}

export async function updateSofiaVoiceNumberMetadata(
  orgId: string,
  routeId: string,
  metadataPatch: JsonObject,
  updatedByUid: string | null,
  defaultLanguage?: string | null
): Promise<SofiaVoiceNumberRow | null> {
  try {
    const rows = await sql<SofiaVoiceNumberRow>`
      UPDATE sofia_voice_numbers
      SET
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb,
        default_language = COALESCE(${defaultLanguage ?? null}, default_language),
        updated_by_uid = ${updatedByUid},
        updated_at = now()
      WHERE org_id = ${orgId}::uuid
        AND id = ${routeId}::uuid
      RETURNING
        id,
        org_id,
        phone_e164,
        provider,
        status,
        label,
        infobip_number_id,
        websocket_endpoint_config_id,
        default_language,
        metadata,
        created_at,
        updated_at,
        created_by_uid,
        updated_by_uid,
        deactivated_at
    `;
    return rows[0] || null;
  } catch (error) {
    logError('SofiaVoiceNumbersModel', 'Failed to update Sofia voice route metadata', error, {
      orgId,
      routeId
    });
    throw error;
  }
}
