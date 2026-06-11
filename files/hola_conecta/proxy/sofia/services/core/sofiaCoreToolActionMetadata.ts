import {
  createAllowedPolicyDecision,
  createRequiresApprovalDecision,
  createRequiresVerificationDecision,
  doesTrustMeetRequirement,
  getRequiredTrustForAction,
  type SofiaPolicyAction,
  type SofiaPolicyActorType,
  type SofiaPolicyAuditSensitivity,
  type SofiaPolicyDecision,
  type SofiaPolicyTrustRequirement
} from './sofiaCorePolicy.ts';
import { mapAssistantActionTypeToPolicyAction, normalizeSofiaRequestedAction } from './sofiaCoreActionIntent.ts';
import {
  buildSofiaPolicyCorrelationMetadata,
  type SofiaPolicyCorrelationInput,
  type SofiaPolicyCorrelationMetadata
} from './sofiaCorePolicyCorrelation.ts';
import type { SofiaCoreChannel, SofiaCoreJsonObject, SofiaRequestedAction } from './types.ts';

const TOOL_ROUTE_ACTIONS: Record<string, SofiaPolicyAction | null> = {
  '/appointments/available-slots': null,
  'appointments.available-slots': null,
  'appointments/available-slots': null,

  '/appointments/create': 'create_booking',
  'appointments.create': 'create_booking',
  'appointments/create': 'create_booking',

  '/appointments/cancel': 'cancel_booking',
  'appointments.cancel': 'cancel_booking',
  'appointments/cancel': 'cancel_booking',

  '/appointments/reschedule': 'reschedule_booking',
  'appointments.reschedule': 'reschedule_booking',
  'appointments/reschedule': 'reschedule_booking',

  '/tasks/create': 'create_task',
  'tasks.create': 'create_task',
  'tasks/create': 'create_task',

  '/messaging/send-sms': 'send_sms',
  'messaging.send-sms': 'send_sms',
  'messaging/send-sms': 'send_sms',

  '/messaging/send-email': 'send_email',
  'messaging.send-email': 'send_email',
  'messaging/send-email': 'send_email',

  '/messaging/send-whatsapp': 'send_whatsapp',
  'messaging.send-whatsapp': 'send_whatsapp',
  'messaging/send-whatsapp': 'send_whatsapp',

  '/messaging/mark-needs-human': 'mark_needs_human',
  'messaging.mark-needs-human': 'mark_needs_human',
  'messaging/mark-needs-human': 'mark_needs_human',

  '/identity/verify-caller': 'verify_caller_pin',
  'identity.verify-caller': 'verify_caller_pin',
  'identity/verify-caller': 'verify_caller_pin',

  '/crm/notify-owner': 'handoff',
  'crm.notify-owner': 'handoff',
  'crm/notify-owner': 'handoff',

  '/crm/write-call-summary': 'write_call_summary',
  'crm.write-call-summary': 'write_call_summary',
  'crm/write-call-summary': 'write_call_summary'
};

export interface SofiaToolBoundaryRequestedActionInput {
  routeNameOrPath: string;
  status?: SofiaRequestedAction['status'];
  source?: string | null;
  approvalRequired?: boolean;
  idempotencyKey?: string | null;
}

export interface SofiaToolBoundaryPolicyDryRunInput extends SofiaToolBoundaryRequestedActionInput {
  orgId: string;
  channel?: SofiaCoreChannel;
  actorType?: SofiaPolicyActorType;
  trustLevel?: SofiaPolicyTrustRequirement;
  verifiedFactors?: string[];
  contactId?: string | null;
  userId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  entryPoint?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  requestId?: string | null;
  callId?: string | null;
  actionLifecycleId?: string | null;
}

export interface SofiaToolBoundaryPolicyMetadata extends SofiaCoreJsonObject {
  event: 'sofia_tool_boundary_policy_dry_run';
  routeName: string;
  policyAction: SofiaPolicyAction;
  orgId: string;
  channel: SofiaCoreChannel;
  actorType: SofiaPolicyActorType;
  trustLevel: SofiaPolicyTrustRequirement;
  requiredTrustLevel: SofiaPolicyTrustRequirement;
  allowed: boolean;
  requiresApproval: boolean;
  requiresVerification: boolean;
  reasonCodes: string[];
  auditSensitivity: SofiaPolicyAuditSensitivity;
  hasContactId: boolean;
  hasUserId: boolean;
  hasResourceId: boolean;
  policyCorrelation?: SofiaPolicyCorrelationMetadata | null;
}

function normalizeRouteName(value: string): string {
  return value.trim().replace(/^\/api\/sofia\/tools/, '').replace(/^\/+/, '/');
}

function defaultActorType(channel: SofiaCoreChannel): SofiaPolicyActorType {
  if (channel === 'internal_chat') return 'user';
  if (channel === 'website_chat') return 'visitor';
  return 'caller';
}

function defaultTrustLevel(channel: SofiaCoreChannel): SofiaPolicyTrustRequirement {
  if (channel === 'internal_chat') return 'authenticated_user';
  if (channel === 'website_chat') return 'anonymous';
  return 'channel';
}

function defaultRequiresApproval(action: SofiaPolicyAction, channel: SofiaCoreChannel): boolean {
  return channel === 'internal_chat' && (action === 'send_sms' || action === 'send_email' || action === 'send_whatsapp');
}

export function mapSofiaToolRouteToPolicyAction(routeNameOrPath: string): SofiaPolicyAction | null {
  const normalized = normalizeRouteName(routeNameOrPath);
  if (Object.hasOwn(TOOL_ROUTE_ACTIONS, normalized)) {
    const action = TOOL_ROUTE_ACTIONS[normalized];
    if (action !== undefined) return action;
  }
  const withoutSlash = normalized.replace(/^\/+/, '');
  if (Object.hasOwn(TOOL_ROUTE_ACTIONS, withoutSlash)) {
    const action = TOOL_ROUTE_ACTIONS[withoutSlash];
    if (action !== undefined) return action;
  }
  return mapAssistantActionTypeToPolicyAction(withoutSlash);
}

export function buildToolBoundaryRequestedAction(
  input: SofiaToolBoundaryRequestedActionInput
): SofiaRequestedAction | null {
  const action = mapSofiaToolRouteToPolicyAction(input.routeNameOrPath);
  if (!action) return null;
  return normalizeSofiaRequestedAction({
    actionType: action,
    status: input.status ?? 'requested',
    approvalRequired: input.approvalRequired === true,
    idempotencyKey: input.idempotencyKey ?? null,
    source: input.source || 'sofia_tool_boundary'
  });
}

export function buildToolBoundaryPolicyDryRun(
  input: SofiaToolBoundaryPolicyDryRunInput
): SofiaPolicyDecision | null {
  const requestedAction = buildToolBoundaryRequestedAction(input);
  if (!requestedAction) return null;

  const channel = input.channel ?? 'voice';
  const actorType = input.actorType ?? defaultActorType(channel);
  const trustLevel = input.trustLevel ?? defaultTrustLevel(channel);
  const requiredTrustLevel = getRequiredTrustForAction(requestedAction.actionType as SofiaPolicyAction, {
    channel,
    actorType
  });
  const base = {
    orgId: input.orgId,
    channel,
    actorType,
    action: requestedAction.actionType as SofiaPolicyAction,
    resourceType: input.resourceType as never,
    resourceId: input.resourceId ?? null,
    contactId: input.contactId ?? null,
    userId: input.userId ?? null,
    trustLevel,
    verifiedFactors: input.verifiedFactors ?? [],
    requiredTrustLevel,
    idempotencyKey: input.idempotencyKey ?? null
  };

  if (!doesTrustMeetRequirement(trustLevel, requiredTrustLevel)) {
    return createRequiresVerificationDecision(base);
  }

  if (input.approvalRequired === true || defaultRequiresApproval(requestedAction.actionType as SofiaPolicyAction, channel)) {
    return createRequiresApprovalDecision(base);
  }

  return createAllowedPolicyDecision(base);
}

export function sanitizeToolBoundaryPolicyMetadata(
  decision: SofiaPolicyDecision,
  routeNameOrPath: string,
  correlationInput: SofiaPolicyCorrelationInput = {}
): SofiaToolBoundaryPolicyMetadata {
  return {
    event: 'sofia_tool_boundary_policy_dry_run',
    routeName: routeNameOrPath,
    policyAction: decision.action,
    orgId: decision.orgId,
    channel: decision.channel,
    actorType: decision.actorType,
    trustLevel: decision.trustLevel,
    requiredTrustLevel: decision.requiredTrustLevel,
    allowed: decision.allowed,
    requiresApproval: decision.requiresApproval,
    requiresVerification: decision.requiresVerification,
    reasonCodes: decision.reasonCodes,
    auditSensitivity: decision.auditSensitivity,
    hasContactId: Boolean(decision.contactId),
    hasUserId: Boolean(decision.userId),
    hasResourceId: Boolean(decision.resourceId),
    policyCorrelation: buildSofiaPolicyCorrelationMetadata({
      orgId: decision.orgId,
      channel: decision.channel,
      entryPoint: correlationInput.entryPoint ?? 'api_sofia_tools',
      sessionId: correlationInput.sessionId ?? null,
      turnId: correlationInput.turnId ?? null,
      requestId: correlationInput.requestId ?? null,
      callId: correlationInput.callId ?? null,
      action: decision.action,
      policyDecisionId: decision.decisionId,
      idempotencyKey: correlationInput.idempotencyKey ?? decision.idempotencyKey ?? null,
      routeAction: correlationInput.routeAction ?? routeNameOrPath,
      lifecycleAction: correlationInput.lifecycleAction ?? null,
      actionLifecycleId: correlationInput.actionLifecycleId ?? null,
      resourceId: decision.resourceId ?? correlationInput.resourceId ?? null,
      contactId: decision.contactId ?? correlationInput.contactId ?? null,
      userId: decision.userId ?? correlationInput.userId ?? null,
      allowed: decision.allowed,
      requiresVerification: decision.requiresVerification,
      requiresApproval: decision.requiresApproval
    })
  };
}
