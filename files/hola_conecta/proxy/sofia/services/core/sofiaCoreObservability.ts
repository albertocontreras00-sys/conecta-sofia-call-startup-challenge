import type { SofiaContextEnvelope } from './sofiaCoreContext.ts';
import type { SofiaCoreInput, SofiaCoreJsonObject, SofiaCoreJsonValue } from './types.ts';
import type { SofiaPolicyDecision } from './sofiaCorePolicy.ts';
import { sanitizeSofiaPolicyDecisionForLog } from './sofiaCorePolicyDryRun.ts';
import {
  buildCorePolicyCorrelationMetadata,
  type SofiaPolicyCorrelationMetadata
} from './sofiaCorePolicyCorrelation.ts';

export const SOFIA_CONTEXT_OBSERVABILITY_EVENT = 'sofia_context_envelope_built';
export const SOFIA_CONTEXT_OBSERVABILITY_VERSION = '1';

export interface SofiaContextObservabilityOptions {
  timestamp?: string;
  reason?: string;
  policyDecision?: SofiaPolicyDecision | null;
  policyCorrelation?: SofiaPolicyCorrelationMetadata | null;
}

export interface SofiaContextObservabilityPayload extends SofiaCoreJsonObject {
  event: typeof SOFIA_CONTEXT_OBSERVABILITY_EVENT;
  reason: string;
  contextVersion: string;
  timestamp: string;
  entryPoint: 'voice' | 'internal_chat' | 'website_chat';
  actorType: string;
  identityStatus: string;
  trustLevel: string;
  hasOrgId: boolean;
  hasUserId: boolean;
  hasContactId: boolean;
  hasBusinessId: boolean;
  hasSessionId: boolean;
  hasCallId: boolean;
  hasTurnId: boolean;
  hasRequestId: boolean;
  hasPageContext: boolean;
  language: string | null;
  source: string | null;
  policyDryRun?: SofiaCoreJsonObject | null;
  policyCorrelation?: SofiaPolicyCorrelationMetadata | null;
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

function readObjectValue(value: SofiaCoreJsonValue | undefined, key: string): SofiaCoreJsonValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
}

function normalizeEntryPoint(input: SofiaCoreInput, envelope: SofiaContextEnvelope): 'voice' | 'internal_chat' | 'website_chat' {
  const channel = envelope.channel.channel || input.channel;
  if (channel === 'voice') return 'voice';
  if (channel === 'internal_chat') return 'internal_chat';
  return 'website_chat';
}

function safeLanguage(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length > 16) return null;
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(normalized) ? normalized : null;
}

function safeSource(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 64) return null;
  return /^[a-zA-Z0-9_.:/-]+$/.test(normalized) ? normalized : null;
}

export function buildSofiaContextObservabilityPayload(
  input: SofiaCoreInput,
  envelope: SofiaContextEnvelope,
  options: SofiaContextObservabilityOptions = {}
): SofiaContextObservabilityPayload {
  const actor = envelope.actor;
  const channel = envelope.channel;
  const businessId =
    readObjectValue(envelope.safeMetadata, 'businessId') ||
    readObjectValue(actor.metadata, 'businessId');

  const payload: SofiaContextObservabilityPayload = {
    event: SOFIA_CONTEXT_OBSERVABILITY_EVENT,
    reason: options.reason || SOFIA_CONTEXT_OBSERVABILITY_EVENT,
    contextVersion: SOFIA_CONTEXT_OBSERVABILITY_VERSION,
    timestamp: options.timestamp || new Date().toISOString(),
    entryPoint: normalizeEntryPoint(input, envelope),
    actorType: actor.actorType,
    identityStatus: actor.identityStatus,
    trustLevel: actor.trustLevel,
    hasOrgId: hasValue(envelope.orgId || actor.orgId || input.orgId),
    hasUserId: hasValue(envelope.userId || actor.userId || input.actor.userId),
    hasContactId: hasValue(envelope.contactId || actor.contactId || input.actor.contactId),
    hasBusinessId: hasValue(businessId),
    hasSessionId: hasValue(channel.sessionId || input.sessionId),
    hasCallId: hasValue(channel.callId),
    hasTurnId: hasValue(channel.turnId || input.turnId),
    hasRequestId: hasValue(channel.requestId || input.requestId),
    hasPageContext: hasValue(channel.pagePath) || hasValue(channel.pageUrl) || hasValue(channel.pageTitle),
    language: safeLanguage(channel.language || input.message.language),
    source: safeSource(channel.source || actor.source)
  };

  if (options.policyDecision) {
    payload.policyDryRun = sanitizeSofiaPolicyDecisionForLog(options.policyDecision) as SofiaCoreJsonObject;
  }
  payload.policyCorrelation = options.policyCorrelation ?? buildCorePolicyCorrelationMetadata(
    input,
    envelope,
    options.policyDecision ?? null
  );

  return payload;
}
