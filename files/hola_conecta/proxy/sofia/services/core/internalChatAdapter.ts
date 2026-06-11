import {
  createPassivePolicyDecision,
  type SofiaCoreInput,
  type SofiaCoreJsonObject,
  type SofiaCoreOutput,
  type SofiaRequestedAction,
  type SofiaToolResult
} from './types.ts';

export interface SofiaInternalChatInputAdapterInput {
  orgId: string;
  userId: string;
  sessionId: string;
  requestId?: string | null;
  inputText: string;
  language?: string | null;
  pagePath?: string | null;
  source?: string | null;
}

export interface SofiaInternalChatOutputAdapterInput {
  orgId: string;
  userId: string;
  sessionId: string;
  requestId: string;
  assistantText: string | null;
  model?: string | null;
  latencyMs?: number | null;
  requestedActions?: SofiaRequestedAction[];
  toolResults?: SofiaToolResult[];
  metadata?: SofiaCoreJsonObject;
}

export function mapInternalChatInputToSofiaCoreInput(input: SofiaInternalChatInputAdapterInput): SofiaCoreInput {
  return {
    channel: 'internal_chat',
    entryPoint: 'api_sofia_chat',
    orgId: input.orgId,
    sessionId: input.sessionId,
    turnId: null,
    requestId: input.requestId ?? null,
    actor: {
      identityStatus: 'user_authenticated',
      trustLevel: 'authenticated_user',
      verifiedFactors: ['logged_in_session'],
      userId: input.userId,
      contactId: null,
      phone: null,
      email: null,
      displayName: null
    },
    message: {
      text: input.inputText,
      language: input.language ?? null,
      timestamp: null
    },
    context: {
      pagePath: input.pagePath ?? null,
      source: input.source ?? null
    }
  };
}

export function mapInternalChatOutputToSofiaCoreOutput(input: SofiaInternalChatOutputAdapterInput): SofiaCoreOutput {
  return {
    channel: 'internal_chat',
    entryPoint: 'api_sofia_chat',
    orgId: input.orgId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    responseText: input.assistantText,
    shouldEndSession: false,
    handoff: false,
    handoffReason: null,
    policyDecision: createPassivePolicyDecision(),
    requestedActions: input.requestedActions ?? [],
    toolResults: input.toolResults ?? [],
    metadata: {
      model: input.model ?? null,
      latencyMs: input.latencyMs ?? null,
      ...input.metadata
    }
  };
}
