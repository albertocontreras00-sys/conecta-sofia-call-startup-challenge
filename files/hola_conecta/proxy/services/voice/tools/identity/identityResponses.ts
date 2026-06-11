import type { SofiaIdentityResolutionResult } from '../../../../sofia/sofia_identity_agent/identityTypes.ts';
import type { GeminiToolResponseBody } from '../../sofiaVoiceToolArgs.ts';
import type { SofiaIdentityCrmVoiceToolContext } from './types.ts';

export function isPinVerified(identity: SofiaIdentityResolutionResult | null): boolean {
  return identity?.identityStatus === 'pin_verified' || identity?.trustLevel === 'verified_sensitive';
}

export function blockResponse(errorCode: string, message: string): GeminiToolResponseBody {
  return { ok: false, errorCode, message };
}

export function duplicateEmailResponse(): GeminiToolResponseBody {
  return blockResponse(
    'EMAIL_ALREADY_IN_ORG',
    'There is already an account with that email in this organization. Do not update the email. Tell the caller it is best to have someone from the team reach out, unless they have another email.'
  );
}

export function requireCrmDomain(context: SofiaIdentityCrmVoiceToolContext, toolName: string, toolCallId: string | null): boolean {
  void context;
  void toolName;
  void toolCallId;
  return true;
}

export function requireMatchedIdentity(context: SofiaIdentityCrmVoiceToolContext, toolName: string, toolCallId: string | null): string | null {
  const identity = context.callerIdentity;
  if (!identity || identity.identityStatus === 'anonymous' || identity.identityStatus === 'channel_only' || identity.identityStatus === 'unknown_caller') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('UNKNOWN_CALLER', 'No private profile fields can be read or updated until the caller phone matches exactly one active contact.'));
    return null;
  }
  if (identity.identityStatus === 'ambiguous_phone_match') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('AMBIGUOUS_PHONE_MATCH', 'The caller phone matches multiple contacts. Ask a disambiguation question and do not read or update profile fields.'));
    return null;
  }
  if (!identity.contactId) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_ID_MISSING', 'The identity layer did not provide a contact id. Do not read or update profile fields.'));
    return null;
  }
  return identity.contactId;
}
