import {
  createPassivePolicyDecision,
  type SofiaCoreInput,
  type SofiaCoreJsonObject,
  type SofiaCoreOutput,
  type SofiaRequestedAction,
  type SofiaToolResult
} from './types.ts';

export interface SofiaWebsiteChatInputAdapterInput {
  orgId: string;
  sessionId: string;
  requestId?: string | null;
  message: string;
  language?: string | null;
  pageUrl?: string | null;
  pageTitle?: string | null;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
}

export interface SofiaWebsiteChatOutputAdapterInput {
  orgId: string;
  sessionId: string;
  requestId?: string | null;
  reply: string | null;
  needsContactCapture?: boolean;
  conversationEnded?: boolean;
  requestedActions?: SofiaRequestedAction[];
  toolResults?: SofiaToolResult[];
  metadata?: SofiaCoreJsonObject;
}

export function mapWebsiteChatInputToSofiaCoreInput(input: SofiaWebsiteChatInputAdapterInput): SofiaCoreInput {
  return {
    channel: 'website_chat',
    entryPoint: 'api_website_chat',
    orgId: input.orgId,
    sessionId: input.sessionId,
    turnId: null,
    requestId: input.requestId ?? null,
    actor: {
      identityStatus: 'anonymous',
      trustLevel: 'anonymous',
      verifiedFactors: [],
      userId: null,
      contactId: null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      displayName: input.name ?? null
    },
    message: {
      text: input.message,
      language: input.language ?? null,
      timestamp: null
    },
    context: {
      pageUrl: input.pageUrl ?? null,
      pageTitle: input.pageTitle ?? null
    }
  };
}

export function mapWebsiteChatOutputToSofiaCoreOutput(input: SofiaWebsiteChatOutputAdapterInput): SofiaCoreOutput {
  return {
    channel: 'website_chat',
    entryPoint: 'api_website_chat',
    orgId: input.orgId,
    sessionId: input.sessionId,
    requestId: input.requestId ?? null,
    responseText: input.reply,
    shouldEndSession: false,
    handoff: false,
    handoffReason: null,
    policyDecision: createPassivePolicyDecision(),
    requestedActions: input.requestedActions ?? [],
    toolResults: input.toolResults ?? [],
    metadata: {
      needsContactCapture: input.needsContactCapture ?? false,
      conversationEnded: input.conversationEnded ?? false,
      ...input.metadata
    }
  };
}
