import { sql } from '../../../../db/neon.js';
import type { JsonObject, JsonValue } from '../../../../types/json.ts';
import type { ContactFieldPolicy } from './fieldPolicies.ts';
import type { ContactRecord } from './types.ts';
import { stringValue } from './fieldValues.ts';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CustomMetadata = ContactFieldPolicy & {
  fieldType: string | null;
};

export function isClientVisibleCustomMetadata(metadata: JsonObject | null | undefined): boolean {
  if (!metadata) return false;
  const source = String(metadata.source || '').toLowerCase();
  const origin = String(metadata.origin || '').toLowerCase();
  const visibility = String(metadata.visibility || '').toLowerCase();
  const isCustom = metadata.is_custom === true || source === 'custom' || origin === 'custom';
  if (!isCustom) return false;
  if (source === 'internal' || origin === 'internal' || visibility === 'internal' || visibility === 'admin') return false;
  return visibility === 'user' || visibility === '';
}

export async function loadCustomFieldMetadata(orgId: string, fieldMetadataId: string): Promise<CustomMetadata | null> {
  if (!UUID_REGEX.test(fieldMetadataId)) return null;
  const rows = await sql<JsonObject & {
    id: string;
    label: string;
    field_type: string | null;
    source: string | null;
    origin: string | null;
    visibility: string | null;
    is_custom: boolean;
  }>`
    SELECT id::text AS id, label, field_type, source, origin, visibility, is_custom
    FROM field_metadata
    WHERE id = ${fieldMetadataId}::uuid
      AND entity_type = 'contact'
      AND source = 'custom'
      AND is_active = true
      AND deleted_at IS NULL
      AND COALESCE(scope_org_id, org_id) = ${orgId}::uuid
    LIMIT 1
  `;
  const row = rows[0] || null;
  if (!row || !row.label || !isClientVisibleCustomMetadata(row)) return null;
  return {
    key: row.id,
    label: row.label,
    source: 'custom_field_values',
    sensitivity: 'custom',
    canReadBeforePin: false,
    canReadWithPin: true,
    canUpdateWithPin: true,
    fieldType: row.field_type || null
  };
}

export function customPoliciesFromContact(contact: ContactRecord): CustomMetadata[] {
  const metadata = contact.custom_field_metadata && typeof contact.custom_field_metadata === 'object'
    ? contact.custom_field_metadata
    : {};
  const policies: CustomMetadata[] = [];
  for (const [fieldMetadataId, row] of Object.entries(metadata)) {
      const label = stringValue(row.label as JsonValue | undefined);
      if (!UUID_REGEX.test(fieldMetadataId) || !label || !isClientVisibleCustomMetadata(row)) continue;
      policies.push({
        key: fieldMetadataId,
        label,
        source: 'custom_field_values',
        sensitivity: 'custom',
        canReadBeforePin: false,
        canReadWithPin: true,
        canUpdateWithPin: true,
        fieldType: stringValue(row.field_type as JsonValue | undefined)
      });
  }
  return policies;
}

export async function loadCustomPoliciesForContact(orgId: string, contactId: string): Promise<CustomMetadata[]> {
  const rows = await sql<JsonObject & {
    id: string;
    label: string;
    field_type: string | null;
    source: string | null;
    origin: string | null;
    visibility: string | null;
    is_custom: boolean;
  }>`
    SELECT DISTINCT fm.id::text AS id, fm.label, fm.field_type, fm.source, fm.origin, fm.visibility, fm.is_custom
    FROM custom_field_values cfv
    JOIN field_metadata fm ON fm.id = cfv.field_metadata_id
    WHERE cfv.org_id = ${orgId}::uuid
      AND cfv.entity_type = 'contact'
      AND cfv.entity_id = ${contactId}::uuid
      AND fm.entity_type = 'contact'
      AND fm.source = 'custom'
      AND fm.is_active = true
      AND fm.deleted_at IS NULL
      AND COALESCE(fm.scope_org_id, fm.org_id) = ${orgId}::uuid
    ORDER BY fm.label ASC
  `;
  const policies: CustomMetadata[] = [];
  for (const row of rows) {
      if (!UUID_REGEX.test(row.id) || !row.label || !isClientVisibleCustomMetadata(row)) continue;
      policies.push({
        key: row.id,
        label: row.label,
        source: 'custom_field_values',
        sensitivity: 'custom',
        canReadBeforePin: false,
        canReadWithPin: true,
        canUpdateWithPin: true,
        fieldType: row.field_type || null
      });
  }
  return policies;
}
