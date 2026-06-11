export type SofiaCoreChannel = 'voice' | 'internal_chat' | 'website_chat';

export type SofiaIdentityStatus =
  | 'unknown'
  | 'anonymous'
  | 'channel_verified'
  | 'contact_matched'
  | 'user_authenticated';

export type SofiaCoreJsonPrimitive = string | number | boolean | null;
export type SofiaCoreJsonValue =
  | SofiaCoreJsonPrimitive
  | SofiaCoreJsonValue[]
  | { [key: string]: SofiaCoreJsonValue | undefined };
export type SofiaCoreJsonObject = Record<string, SofiaCoreJsonValue | undefined>;

export type SofiaPolicyDecisionStatus = 'not_evaluated' | 'allow' | 'revise' | 'block' | 'handoff';

export interface SofiaCoreResponsePolicyDecision {
  status: SofiaPolicyDecisionStatus;
  handoff: boolean;
  handoffReason: string | null;
  reasons: string[];
  blockedReasons: string[];
  metadata: SofiaCoreJsonObject;
}

export type SofiaToolResultStatus = 'not_run' | 'succeeded' | 'failed' | 'blocked';

export interface SofiaToolResult {
  toolName: string;
  status: SofiaToolResultStatus;
  output: SofiaCoreJsonObject | null;
  error: string | null;
  metadata: SofiaCoreJsonObject;
}

export interface SofiaRequestedAction {
  actionType: string;
  status: 'requested' | 'drafted' | 'approved' | 'executed' | 'blocked' | 'cancelled';
  payload: SofiaCoreJsonObject;
  approvalRequired: boolean;
  idempotencyKey: string | null;
  metadata: SofiaCoreJsonObject;
}

export interface SofiaCoreInput {
  channel: SofiaCoreChannel;
  entryPoint: string;
  orgId: string;
  sessionId: string | null;
  turnId: string | null;
  requestId: string | null;
  actor: {
    identityStatus: SofiaIdentityStatus;
    trustLevel: 'unknown' | 'anonymous' | 'channel' | 'authenticated_user' | 'contact_matched' | 'verified_sensitive';
    verifiedFactors: string[];
    userId: string | null;
    contactId: string | null;
    phone: string | null;
    email: string | null;
    displayName: string | null;
  };
  message: {
    text: string;
    language: string | null;
    timestamp: string | null;
  };
  context: SofiaCoreJsonObject;
}

export interface SofiaCoreOutput {
  channel: SofiaCoreChannel;
  entryPoint: string;
  orgId: string;
  sessionId: string | null;
  requestId: string | null;
  responseText: string | null;
  shouldEndSession: boolean;
  handoff: boolean;
  handoffReason: string | null;
  policyDecision: SofiaCoreResponsePolicyDecision;
  requestedActions: SofiaRequestedAction[];
  toolResults: SofiaToolResult[];
  metadata: SofiaCoreJsonObject;
}

export function createPassivePolicyDecision(overrides: Partial<SofiaCoreResponsePolicyDecision> = {}): SofiaCoreResponsePolicyDecision {
  return {
    status: overrides.status ?? 'not_evaluated',
    handoff: overrides.handoff ?? false,
    handoffReason: overrides.handoffReason ?? null,
    reasons: overrides.reasons ?? [],
    blockedReasons: overrides.blockedReasons ?? [],
    metadata: overrides.metadata ?? {}
  };
}
