import type { SofiaCoreChannel } from './types.ts';
import type { SofiaActorType, SofiaTrustLevel } from './sofiaCoreContext.ts';

export const SOFIA_POLICY_VERSION = '1';

export const SOFIA_POLICY_ACTIONS = [
  'send_sms',
  'send_email',
  'send_whatsapp',
  'create_booking',
  'cancel_booking',
  'reschedule_booking',
  'mark_needs_human',
  'create_task',
  'write_call_summary',
  'verify_caller_pin',
  'end_session',
  'handoff'
] as const;

export type SofiaPolicyAction = typeof SOFIA_POLICY_ACTIONS[number];

export type SofiaPolicyActorType = SofiaActorType;
export type SofiaPolicyTrustRequirement = SofiaTrustLevel;

export type SofiaPolicyResourceType =
  | 'contact'
  | 'booking'
  | 'task'
  | 'message'
  | 'session'
  | 'call'
  | 'organization'
  | 'unknown';

export type SofiaPolicyAuditSensitivity = 'low' | 'medium' | 'high' | 'restricted';

export type SofiaPolicyReasonCode =
  | 'draft_only'
  | 'trust_sufficient'
  | 'trust_insufficient'
  | 'approval_required'
  | 'verification_required'
  | 'pin_required'
  | 'voice_sensitive_action'
  | 'anonymous_action_limited'
  | 'org_scope_required'
  | 'not_enforced';

export interface SofiaPolicyDecision {
  decisionId: string;
  orgId: string;
  channel: SofiaCoreChannel;
  actorType: SofiaPolicyActorType;
  action: SofiaPolicyAction;
  resourceType?: SofiaPolicyResourceType | null;
  resourceId?: string | null;
  contactId?: string | null;
  userId?: string | null;
  trustLevel: SofiaPolicyTrustRequirement;
  verifiedFactors: string[];
  requiredTrustLevel: SofiaPolicyTrustRequirement;
  requiresApproval: boolean;
  requiresPin: boolean;
  requiresVerification: boolean;
  allowed: boolean;
  reasonCodes: SofiaPolicyReasonCode[];
  idempotencyKey?: string | null;
  auditSensitivity: SofiaPolicyAuditSensitivity;
  policyVersion: string;
}

export interface SofiaPolicyDecisionInput {
  decisionId?: string | null;
  orgId: string;
  channel: SofiaCoreChannel;
  actorType: SofiaPolicyActorType;
  action: SofiaPolicyAction;
  resourceType?: SofiaPolicyResourceType | null;
  resourceId?: string | null;
  contactId?: string | null;
  userId?: string | null;
  trustLevel: SofiaPolicyTrustRequirement;
  verifiedFactors?: string[];
  requiredTrustLevel?: SofiaPolicyTrustRequirement;
  requiresApproval?: boolean;
  requiresPin?: boolean;
  requiresVerification?: boolean;
  reasonCodes?: SofiaPolicyReasonCode[];
  idempotencyKey?: string | null;
  auditSensitivity?: SofiaPolicyAuditSensitivity;
}

const TRUST_RANK: Record<SofiaPolicyTrustRequirement, number> = {
  unknown: 0,
  anonymous: 1,
  channel: 2,
  authenticated_user: 3,
  contact_matched: 4,
  verified_sensitive: 5
};

function defaultDecisionId(input: SofiaPolicyDecisionInput): string {
  return [
    SOFIA_POLICY_VERSION,
    input.channel,
    input.actorType,
    input.action,
    input.orgId || 'no-org',
    input.resourceType || 'no-resource-type',
    input.resourceId || input.contactId || input.userId || input.idempotencyKey || 'draft'
  ].join(':');
}

function appendUnique(
  base: SofiaPolicyReasonCode[],
  additions: SofiaPolicyReasonCode[]
): SofiaPolicyReasonCode[] {
  return Array.from(new Set([...base, ...additions]));
}

function isSensitiveVoiceBookingAction(action: SofiaPolicyAction): boolean {
  return action === 'cancel_booking' || action === 'reschedule_booking';
}

export function getRequiredTrustForAction(
  action: SofiaPolicyAction,
  context: Pick<SofiaPolicyDecisionInput, 'channel' | 'actorType'> = { channel: 'voice', actorType: 'unknown' }
): SofiaPolicyTrustRequirement {
  if (context.actorType === 'user' && context.channel === 'internal_chat') {
    if (action === 'mark_needs_human' || action === 'handoff' || action === 'end_session') return 'authenticated_user';
    return 'authenticated_user';
  }

  if (context.channel === 'website_chat') {
    if (action === 'handoff' || action === 'mark_needs_human') return 'anonymous';
    if (action === 'end_session') return 'anonymous';
    return 'contact_matched';
  }

  if (isSensitiveVoiceBookingAction(action)) return 'verified_sensitive';

  switch (action) {
    case 'send_sms':
    case 'send_email':
    case 'send_whatsapp':
    case 'create_booking':
      return 'contact_matched';
    case 'create_task':
      return 'authenticated_user';
    case 'write_call_summary':
    case 'verify_caller_pin':
    case 'end_session':
    case 'handoff':
    case 'mark_needs_human':
      return 'channel';
    default:
      return 'verified_sensitive';
  }
}

export function doesTrustMeetRequirement(
  currentTrust: SofiaPolicyTrustRequirement,
  requiredTrust: SofiaPolicyTrustRequirement
): boolean {
  return (TRUST_RANK[currentTrust] ?? TRUST_RANK.unknown) >= (TRUST_RANK[requiredTrust] ?? TRUST_RANK.verified_sensitive);
}

export function classifyActionSensitivity(action: SofiaPolicyAction): SofiaPolicyAuditSensitivity {
  switch (action) {
    case 'cancel_booking':
    case 'reschedule_booking':
      return 'high';
    case 'send_sms':
    case 'send_email':
    case 'send_whatsapp':
    case 'create_booking':
    case 'create_task':
    case 'write_call_summary':
    case 'verify_caller_pin':
      return 'medium';
    case 'mark_needs_human':
    case 'end_session':
    case 'handoff':
      return 'low';
    default:
      return 'restricted';
  }
}

function defaultRequiresApproval(input: SofiaPolicyDecisionInput): boolean {
  if (input.action === 'send_sms' || input.action === 'send_email' || input.action === 'send_whatsapp') return input.channel === 'internal_chat';
  return false;
}

function defaultRequiresPin(input: SofiaPolicyDecisionInput): boolean {
  return input.channel === 'voice' && isSensitiveVoiceBookingAction(input.action);
}

function createPolicyDecision(
  input: SofiaPolicyDecisionInput,
  overrides: {
    allowed: boolean;
    reasonCodes: SofiaPolicyReasonCode[];
    requiresApproval?: boolean;
    requiresPin?: boolean;
    requiresVerification?: boolean;
  }
): SofiaPolicyDecision {
  const requiredTrustLevel = input.requiredTrustLevel ?? getRequiredTrustForAction(input.action, input);
  const requiresPin = overrides.requiresPin ?? input.requiresPin ?? defaultRequiresPin(input);
  const requiresVerification =
    overrides.requiresVerification ??
    input.requiresVerification ??
    !doesTrustMeetRequirement(input.trustLevel, requiredTrustLevel);
  const requiresApproval = overrides.requiresApproval ?? input.requiresApproval ?? defaultRequiresApproval(input);

  return {
    decisionId: input.decisionId || defaultDecisionId(input),
    orgId: input.orgId,
    channel: input.channel,
    actorType: input.actorType,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    contactId: input.contactId ?? null,
    userId: input.userId ?? null,
    trustLevel: input.trustLevel,
    verifiedFactors: input.verifiedFactors ?? [],
    requiredTrustLevel,
    requiresApproval,
    requiresPin,
    requiresVerification,
    allowed: overrides.allowed,
    reasonCodes: appendUnique(input.reasonCodes ?? [], overrides.reasonCodes),
    idempotencyKey: input.idempotencyKey ?? null,
    auditSensitivity: input.auditSensitivity ?? classifyActionSensitivity(input.action),
    policyVersion: SOFIA_POLICY_VERSION
  };
}

export function createDraftPolicyDecision(input: SofiaPolicyDecisionInput): SofiaPolicyDecision {
  return createPolicyDecision(input, {
    allowed: false,
    reasonCodes: ['draft_only', 'not_enforced']
  });
}

export function createAllowedPolicyDecision(input: SofiaPolicyDecisionInput): SofiaPolicyDecision {
  return createPolicyDecision(input, {
    allowed: true,
    reasonCodes: ['trust_sufficient', 'not_enforced'],
    requiresVerification: false
  });
}

export function createBlockedPolicyDecision(input: SofiaPolicyDecisionInput): SofiaPolicyDecision {
  return createPolicyDecision(input, {
    allowed: false,
    reasonCodes: ['trust_insufficient', 'not_enforced']
  });
}

export function createRequiresVerificationDecision(input: SofiaPolicyDecisionInput): SofiaPolicyDecision {
  return createPolicyDecision(input, {
    allowed: false,
    reasonCodes: ['verification_required', 'not_enforced'],
    requiresVerification: true
  });
}

export function createRequiresApprovalDecision(input: SofiaPolicyDecisionInput): SofiaPolicyDecision {
  return createPolicyDecision(input, {
    allowed: false,
    reasonCodes: ['approval_required', 'not_enforced'],
    requiresApproval: true
  });
}
