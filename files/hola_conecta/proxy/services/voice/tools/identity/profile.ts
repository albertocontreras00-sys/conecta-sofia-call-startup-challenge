import { verifyCallerVoicePin } from '../../../client/voicePinService.js';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import { BLOCKED_STANDARD_FIELDS, STANDARD_POLICIES } from './fieldPolicies.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';
import { blockResponse, buildReadModel, isPinVerified, loadContact, loadCustomPoliciesForContact, logIdentityBoundary, requestedFieldKeys, requireCrmDomain, requireMatchedIdentity, writeAudit } from './common.ts';
export async function handleLookupCallerProfileTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'lookup_caller_profile';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  const contact = await loadContact(context.session.orgId, contactId);
  if (!contact) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_NOT_FOUND', 'The matched contact no longer exists.'));
    return;
  }
  const customPolicies = await loadCustomPoliciesForContact(context.session.orgId, contactId);
  const model = buildReadModel(context.callerIdentity, contact, requestedFieldKeys(args), customPolicies);
  logIdentityBoundary(context, 'voice.mcp.identity.lookup_profile.response_shape', toolName, toolCallId, {
    contact,
    customPolicies,
    model
  });
  await writeAudit({ context, contactId, fieldKey: 'profile', action: 'read_profile', toolName });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    profile: model,
    message: isPinVerified(context.callerIdentity)
      ? 'PIN is verified. You may speak allowed full field values returned with value.'
      : 'PIN is not verified. Speak only maskedValue fields and ask for PIN before full PII.'
  });
}

export async function handleVerifyCallerPinTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'verify_caller_pin';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  const pin = stringArg(args, 'pin');
  if (!contactId || !context.session || !context.callerIdentity) return;
  if (!pin) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('PIN_REQUIRED', 'Ask the caller for their 6 digit voice PIN.'));
    return;
  }
  const result = await verifyCallerVoicePin({ orgId: context.session.orgId, contactId, pin });
  logIdentityBoundary(context, 'voice.mcp.identity.verify_pin.response_shape', toolName, toolCallId, {
    result,
    identityAfterVerification: context.callerIdentity
  });
  if (result.verified) {
    context.callerIdentity.identityStatus = 'pin_verified';
    context.callerIdentity.trustLevel = 'verified_sensitive';
    context.callerIdentity.verifiedFactors = Array.from(new Set([...context.callerIdentity.verifiedFactors, 'voice_pin']));
  }
  await writeAudit({ context, contactId, fieldKey: 'voice_pin', action: result.verified ? 'pin_verified' : 'pin_failed', toolName, sensitivity: 'high' });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: result.verified,
    verified: result.verified,
    reason: result.reason,
    remainingAttempts: result.remainingAttempts,
    identityStatus: context.callerIdentity.identityStatus,
    trustLevel: context.callerIdentity.trustLevel,
    verifiedFactors: context.callerIdentity.verifiedFactors,
    message: result.verified ? 'PIN verified. Continue with allowed profile tools.' : 'PIN was not verified. Do not reveal full PII.'
  });
}

export async function handleReadCallerContactFieldsTool(
  context: SofiaIdentityCrmVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'read_caller_contact_fields';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  const contact = await loadContact(context.session.orgId, contactId);
  if (!contact) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_NOT_FOUND', 'The matched contact no longer exists.'));
    return;
  }
  const keys = requestedFieldKeys(args);
  const customPolicies = await loadCustomPoliciesForContact(context.session.orgId, contactId);
  const profile = buildReadModel(context.callerIdentity, contact, keys, customPolicies);
  const blockedKeys = (keys || []).filter((key) => !profile.fields.some((field) => field.key === key));
  logIdentityBoundary(context, 'voice.mcp.profile.read_fields.response_shape', toolName, toolCallId, {
    contact,
    keys,
    customPolicies,
    profile,
    blockedKeys
  });
  for (const field of profile.fields) {
    await writeAudit({ context, contactId, fieldKey: field.key, action: 'read_field', toolName, sensitivity: field.sensitivity === 'pii' || field.sensitivity === 'custom' ? 'medium' : 'low' });
  }
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    contactId,
    identityStatus: context.callerIdentity.identityStatus,
    trustLevel: context.callerIdentity.trustLevel,
    fields: profile.fields,
    blockedKeys,
    message: isPinVerified(context.callerIdentity)
      ? 'Speak only fields with canReadByVoice true. Never infer blocked or missing fields.'
      : 'PIN is required before full PII. Speak only maskedValue for fields with canReadByVoice true.'
  });
}

export async function handleListAvailableContactFieldsTool(
  context: SofiaIdentityCrmVoiceToolContext,
  _args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'list_available_contact_fields';
  logIdentityBoundary(context, 'voice.policy.identity_crm.request_shape', toolName, toolCallId, {
    args: _args,
    identity: context.callerIdentity
  });
  if (!requireCrmDomain(context, toolName, toolCallId)) return;
  const contactId = requireMatchedIdentity(context, toolName, toolCallId);
  if (!contactId || !context.session || !context.callerIdentity) return;
  const contact = await loadContact(context.session.orgId, contactId);
  if (!contact) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_NOT_FOUND', 'The matched contact no longer exists.'));
    return;
  }
  const pinVerified = isPinVerified(context.callerIdentity);
  const fields = [...STANDARD_POLICIES, ...await loadCustomPoliciesForContact(context.session.orgId, contactId)].map((policy) => ({
    key: policy.key,
    label: policy.label,
    source: policy.source,
    sensitivity: policy.sensitivity,
    canReadByVoice: pinVerified ? policy.canReadWithPin : policy.canReadBeforePin,
    canUpdateByVoice: pinVerified && policy.canUpdateWithPin
  }));
  logIdentityBoundary(context, 'voice.mcp.profile.available_fields.response_shape', toolName, toolCallId, {
    contactId,
    fields,
    blockedFields: BLOCKED_STANDARD_FIELDS
  });
  context.sendGeminiToolResponse(toolName, toolCallId, {
    ok: true,
    contactId,
    fields,
    blockedFields: BLOCKED_STANDARD_FIELDS
  });
}
