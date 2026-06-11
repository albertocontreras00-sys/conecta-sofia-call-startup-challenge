import { logInfo } from '../../../../utils/logger.js';
import type { SofiaIdentityResolutionResult } from '../../../../sofia/sofia_identity_agent/identityTypes.ts';
import type { GeminiDomain } from '../../infobipMediaWebSocketGeminiTypes.ts';
import type { GeminiToolResponseBody } from '../../sofiaVoiceToolArgs.ts';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import type { VoiceSession } from '../../voiceSessionTypes.ts';
import type { SendGeminiToolResponse } from '../booking/common.ts';

export type SofiaReceptionistVoiceToolContext = {
  activeGeminiDomain: GeminiDomain;
  callerIdentity: SofiaIdentityResolutionResult | null;
  logContext: string;
  sendGeminiToolResponse: SendGeminiToolResponse;
  session: VoiceSession | null;
};

export type RuntimeRecord = Record<string, unknown>;

export function blockResponse(errorCode: string, message: string): GeminiToolResponseBody {
  return { ok: false, errorCode, message };
}

export function logReceptionistBoundary(
  context: SofiaReceptionistVoiceToolContext,
  event: string,
  toolName: string,
  toolCallId: string | null,
  value: Record<string, unknown>
): void {
  logInfo(context.logContext, event, {
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    orgId: context.session?.orgId || null,
    activeDomain: context.activeGeminiDomain,
    toolCallId,
    toolName,
    dump: buildSofiaVoiceDebugJsonDump({
      label: `${toolName}_${event}`,
      value
    })
  });
}

export function requireDomain(
  context: SofiaReceptionistVoiceToolContext,
  allowed: GeminiDomain[],
  toolName: string,
  toolCallId: string | null
): boolean {
  void context;
  void allowed;
  void toolName;
  void toolCallId;
  return true;
}

export function requireSessionAndContact(
  context: SofiaReceptionistVoiceToolContext,
  toolName: string,
  toolCallId: string | null
): { session: VoiceSession; contactId: string; displayName: string | null } | null {
  const session = context.session;
  if (!session) return null;
  const identity = context.callerIdentity;
  if (!identity || identity.identityStatus === 'anonymous' || identity.identityStatus === 'channel_only' || identity.identityStatus === 'unknown_caller') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('UNKNOWN_CALLER', 'No contact-specific status can be read until the caller phone matches exactly one active contact.'));
    return null;
  }
  if (identity.identityStatus === 'ambiguous_phone_match') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('AMBIGUOUS_PHONE_MATCH', 'The caller phone matches multiple contacts. Do not guess. Offer human follow-up.'));
    return null;
  }
  if (!identity.contactId) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONTACT_ID_MISSING', 'The identity layer did not provide a contact id. Offer human follow-up.'));
    return null;
  }
  return { session, contactId: identity.contactId, displayName: identity.displayName };
}

export function asRecord(value: unknown): RuntimeRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RuntimeRecord : {};
}

export function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function statusValue(value: unknown): string | null {
  return textValue(value)?.toLowerCase() || null;
}
