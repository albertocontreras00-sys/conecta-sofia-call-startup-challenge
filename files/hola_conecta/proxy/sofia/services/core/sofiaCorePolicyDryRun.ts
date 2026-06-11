import type { SofiaCoreInput, SofiaCoreJsonObject, SofiaCoreJsonValue } from './types.ts';
import {
  createAllowedPolicyDecision,
  createRequiresApprovalDecision,
  createRequiresVerificationDecision,
  doesTrustMeetRequirement,
  getRequiredTrustForAction,
  type SofiaPolicyAction,
  type SofiaPolicyActorType,
  type SofiaPolicyDecision,
  type SofiaPolicyTrustRequirement
} from './sofiaCorePolicy.ts';
import { normalizeSofiaRequestedAction } from './sofiaCoreActionIntent.ts';

function isObject(value: SofiaCoreJsonValue | undefined): value is SofiaCoreJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: Array<SofiaCoreJsonValue | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function inferActionFromObject(value: SofiaCoreJsonValue | undefined): SofiaPolicyAction | null {
  const action = normalizeSofiaRequestedAction(value);
  return action?.actionType as SofiaPolicyAction | null;
}

export function inferPolicyActionFromCoreInput(input: SofiaCoreInput): SofiaPolicyAction | null {
  const direct =
    inferActionFromObject(input.context.requestedAction) ||
    inferActionFromObject(input.context.requested_action) ||
    inferActionFromObject(input.context.action);

  if (direct) return direct;

  const requestedActions = input.context.requestedActions;
  if (Array.isArray(requestedActions)) {
    for (const item of requestedActions) {
      const action = inferActionFromObject(item);
      if (action) return action;
    }
  }

  return null;
}

function readSofiaContext(input: SofiaCoreInput): SofiaCoreJsonObject {
  return isObject(input.context.sofiaContext) ? input.context.sofiaContext : {};
}

function readNestedObject(source: SofiaCoreJsonObject, key: string): SofiaCoreJsonObject {
  return isObject(source[key]) ? source[key] as SofiaCoreJsonObject : {};
}

function readVerifiedFactors(actor: SofiaCoreJsonObject): string[] {
  const value = actor.verifiedFactors;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function defaultActorType(input: SofiaCoreInput): SofiaPolicyActorType {
  if (input.channel === 'voice') return 'caller';
  if (input.channel === 'internal_chat') return 'user';
  if (input.channel === 'website_chat') return 'visitor';
  return 'unknown';
}

function defaultTrustLevel(input: SofiaCoreInput): SofiaPolicyTrustRequirement {
  if (input.channel === 'internal_chat' && input.actor.identityStatus === 'user_authenticated') return 'authenticated_user';
  if (input.channel === 'website_chat') return 'anonymous';
  if (input.channel === 'voice') return 'channel';
  return 'unknown';
}

export function evaluateSofiaPolicyDryRun(input: SofiaCoreInput): SofiaPolicyDecision | null {
  const action = inferPolicyActionFromCoreInput(input);
  if (!action) return null;

  const sofiaContext = readSofiaContext(input);
  const actor = readNestedObject(sofiaContext, 'actor');
  const actorType = (firstString(actor.actorType) || defaultActorType(input)) as SofiaPolicyActorType;
  const trustLevel = (firstString(actor.trustLevel) || defaultTrustLevel(input)) as SofiaPolicyTrustRequirement;
  const contactId = firstString(sofiaContext.contactId, actor.contactId, input.actor.contactId);
  const userId = firstString(sofiaContext.userId, actor.userId, input.actor.userId);
  const requiredTrustLevel = getRequiredTrustForAction(action, {
    channel: input.channel,
    actorType
  });
  const base = {
    orgId: input.orgId,
    channel: input.channel,
    actorType,
    action,
    contactId,
    userId,
    trustLevel,
    verifiedFactors: readVerifiedFactors(actor),
    requiredTrustLevel
  };

  if (!doesTrustMeetRequirement(trustLevel, requiredTrustLevel)) {
    return createRequiresVerificationDecision(base);
  }

  const approvalProbe = createRequiresApprovalDecision(base);
  if (approvalProbe.requiresApproval) return approvalProbe;

  return createAllowedPolicyDecision(base);
}

export function sanitizeSofiaPolicyDecisionForLog(decision: SofiaPolicyDecision): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    policyVersion: decision.policyVersion,
    channel: decision.channel,
    actorType: decision.actorType,
    action: decision.action,
    requiredTrustLevel: decision.requiredTrustLevel,
    trustLevel: decision.trustLevel,
    allowed: decision.allowed,
    requiresApproval: decision.requiresApproval,
    requiresPin: decision.requiresPin,
    requiresVerification: decision.requiresVerification,
    reasonCodes: decision.reasonCodes,
    auditSensitivity: decision.auditSensitivity,
    hasContactId: Boolean(decision.contactId),
    hasUserId: Boolean(decision.userId)
  };
}
