import type { SofiaContextEnvelope } from './sofiaCoreContext.ts';
import type { SofiaPolicyAction, SofiaPolicyDecision } from './sofiaCorePolicy.ts';
import type { SofiaCoreChannel, SofiaCoreInput, SofiaCoreJsonObject } from './types.ts';

export interface SofiaPolicyCorrelationInput {
  orgId?: string | null;
  channel?: SofiaCoreChannel | null;
  entryPoint?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  requestId?: string | null;
  callId?: string | null;
  action?: SofiaPolicyAction | string | null;
  policyDecisionId?: string | null;
  idempotencyKey?: string | null;
  routeAction?: string | null;
  lifecycleAction?: string | null;
  actionLifecycleId?: string | null;
  resourceId?: string | null;
  contactId?: string | null;
  userId?: string | null;
  allowed?: boolean | null;
  requiresVerification?: boolean | null;
  requiresApproval?: boolean | null;
}

export interface SofiaPolicyCorrelationMetadata extends SofiaCoreJsonObject {
  event: 'sofia_policy_correlation';
  correlationKey: string;
  orgId: string | null;
  channel: SofiaCoreChannel | null;
  entryPoint: string | null;
  sessionId: string | null;
  turnId: string | null;
  requestId: string | null;
  callId: string | null;
  action: string | null;
  policyDecisionId: string | null;
  allowed: boolean | null;
  requiresVerification: boolean | null;
  requiresApproval: boolean | null;
  routeAction: string | null;
  lifecycleAction: string | null;
  hasContactId: boolean;
  hasUserId: boolean;
  hasResourceId: boolean;
}

function cleanString(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

export function buildSofiaPolicyCorrelationKey(input: SofiaPolicyCorrelationInput): string {
  const parts = [
    'sofia-policy',
    cleanString(input.orgId) || 'no-org',
    cleanString(input.channel) || 'no-channel',
    cleanString(input.entryPoint) || 'no-entry',
    cleanString(input.sessionId) || 'no-session',
    cleanString(input.callId) || 'no-call',
    cleanString(input.turnId) || 'no-turn',
    cleanString(input.requestId) || 'no-request',
    cleanString(input.action) || 'no-action',
    cleanString(input.policyDecisionId) || cleanString(input.idempotencyKey) || cleanString(input.actionLifecycleId) || 'no-decision'
  ];

  return parts.join(':');
}

export function buildSofiaPolicyCorrelationMetadata(input: SofiaPolicyCorrelationInput): SofiaPolicyCorrelationMetadata {
  const metadata: SofiaPolicyCorrelationMetadata = {
    event: 'sofia_policy_correlation',
    correlationKey: buildSofiaPolicyCorrelationKey(input),
    orgId: cleanString(input.orgId),
    channel: input.channel ?? null,
    entryPoint: cleanString(input.entryPoint),
    sessionId: cleanString(input.sessionId),
    turnId: cleanString(input.turnId),
    requestId: cleanString(input.requestId),
    callId: cleanString(input.callId),
    action: cleanString(input.action),
    policyDecisionId: cleanString(input.policyDecisionId),
    allowed: typeof input.allowed === 'boolean' ? input.allowed : null,
    requiresVerification: typeof input.requiresVerification === 'boolean' ? input.requiresVerification : null,
    requiresApproval: typeof input.requiresApproval === 'boolean' ? input.requiresApproval : null,
    routeAction: cleanString(input.routeAction),
    lifecycleAction: cleanString(input.lifecycleAction),
    hasContactId: hasValue(input.contactId),
    hasUserId: hasValue(input.userId),
    hasResourceId: hasValue(input.resourceId)
  };

  return metadata;
}

export function correlateCoreDecisionWithToolBoundary(
  core: SofiaPolicyCorrelationInput,
  boundary: SofiaPolicyCorrelationInput
): SofiaPolicyCorrelationMetadata {
  return buildSofiaPolicyCorrelationMetadata({
    ...core,
    ...boundary,
    orgId: boundary.orgId ?? core.orgId ?? null,
    channel: boundary.channel ?? core.channel ?? null,
    entryPoint: boundary.entryPoint ?? core.entryPoint ?? null,
    sessionId: boundary.sessionId ?? core.sessionId ?? null,
    turnId: boundary.turnId ?? core.turnId ?? null,
    requestId: boundary.requestId ?? core.requestId ?? null,
    callId: boundary.callId ?? core.callId ?? null,
    action: boundary.action ?? core.action ?? null,
    policyDecisionId: boundary.policyDecisionId ?? core.policyDecisionId ?? null
  });
}

export function buildCorePolicyCorrelationMetadata(
  input: SofiaCoreInput,
  envelope: SofiaContextEnvelope,
  decision?: SofiaPolicyDecision | null
): SofiaPolicyCorrelationMetadata {
  return buildSofiaPolicyCorrelationMetadata({
    orgId: input.orgId || envelope.orgId,
    channel: input.channel,
    entryPoint: input.entryPoint,
    sessionId: input.sessionId || envelope.channel.sessionId,
    turnId: input.turnId || envelope.channel.turnId,
    requestId: input.requestId || envelope.channel.requestId || null,
    callId: envelope.channel.callId ?? null,
    action: decision?.action ?? null,
    policyDecisionId: decision?.decisionId ?? null,
    contactId: decision?.contactId ?? envelope.contactId ?? input.actor.contactId,
    userId: decision?.userId ?? envelope.userId ?? input.actor.userId,
    allowed: decision?.allowed ?? null,
    requiresVerification: decision?.requiresVerification ?? null,
    requiresApproval: decision?.requiresApproval ?? null
  });
}

export function sanitizeSofiaPolicyCorrelationForLog(input: SofiaPolicyCorrelationInput): SofiaPolicyCorrelationMetadata {
  return buildSofiaPolicyCorrelationMetadata(input);
}
