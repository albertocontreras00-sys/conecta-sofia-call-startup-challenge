import * as businessOwnershipModel from '../../../../models/businessOwnership.ts';
import { sql } from '../../../../db/neon.js';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';
import { blockResponse, booleanValue, isPinVerified, logIdentityBoundary, requireCrmDomain, requireMatchedIdentity, stringValue, writeAudit } from './common.ts';
export async function handleLookupHouseholdContextTool(
  context: SofiaIdentityCrmVoiceToolContext,
  _args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'lookup_household_context';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args: _args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Verify the caller PIN before reading household context.'));
    return;
  }
  const rows = await sql<{ household_id: string | null; household_role: string | null; member_count: number }>`
    SELECT c.household_id::text AS household_id, c.household_role, COUNT(m.id)::int AS member_count
    FROM contacts c
    LEFT JOIN contacts m ON m.org_id = c.org_id AND m.household_id = c.household_id AND m.deleted_at IS NULL
    WHERE c.org_id = ${context.session.orgId}::uuid
      AND c.id = ${contactId}::uuid
      AND c.deleted_at IS NULL
    GROUP BY c.household_id, c.household_role
    LIMIT 1
  `;
  const row = rows[0] || null;
  logIdentityBoundary(context, 'voice.mcp.profile.household.response_shape', toolName, toolCallId, {
    row,
    rowCount: rows.length
  });
  await writeAudit({ context, contactId, fieldKey: 'household_summary', action: 'read_household', toolName, sensitivity: 'medium' });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    household: row?.household_id ? {
      householdId: row.household_id,
      callerRole: row.household_role,
      memberCount: row.member_count
    } : null,
    message: 'Only speak this household summary. Do not invent household member names or details.'
  });
}

export async function handleLookupBusinessContextTool(
  context: SofiaIdentityCrmVoiceToolContext,
  _args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'lookup_business_context';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args: _args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!isPinVerified(context.callerIdentity)) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Verify the caller PIN before reading business context.'));
    return;
  }
  const businesses = await businessOwnershipModel.getContactBusinesses(contactId, context.session.orgId);
  logIdentityBoundary(context, 'voice.mcp.profile.business.response_shape', toolName, toolCallId, {
    businesses,
    businessCount: businesses.length
  });
  await writeAudit({ context, contactId, fieldKey: 'business_summary', action: 'read_business', toolName, sensitivity: 'medium' });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    businesses: businesses.map((business) => ({
      businessId: stringValue(business.id),
      businessName: stringValue(business.business_name),
      role: stringValue(business.role),
      isPrimary: booleanValue(business.is_primary)
    })).filter((business) => business.businessId && business.businessName),
    message: 'Only speak returned business names and roles. Do not expose EIN, balances, or internal business fields.'
  });
}
