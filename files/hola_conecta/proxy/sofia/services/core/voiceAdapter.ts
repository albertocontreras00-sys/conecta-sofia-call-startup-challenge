import {
  createPassivePolicyDecision,
  type SofiaCoreInput,
  type SofiaCoreJsonObject,
  type SofiaCoreOutput,
  type SofiaRequestedAction,
  type SofiaToolResult
} from './types.ts';

export interface SofiaVoiceInputAdapterInput {
  orgId: string;
  callId: string;
  sessionId: string;
  turnId: string;
  turnNumber: number;
  fromPhone: string;
  transcript: string;
  timestamp: string;
  previousTurns?: SofiaCoreJsonObject[];
  requestId?: string | null;
}

export interface SofiaVoiceOutputAdapterInput {
  orgId: string;
  sessionId: string;
  requestId?: string | null;
  responseText: string | null;
  shouldEndCall?: boolean;
  handoff?: boolean;
  handoffReason?: string | null;
  requestedActions?: SofiaRequestedAction[];
  toolResults?: SofiaToolResult[];
  metadata?: SofiaCoreJsonObject;
}

export function mapVoiceInputToSofiaCoreInput(input: SofiaVoiceInputAdapterInput): SofiaCoreInput {
  return {
    channel: 'voice',
    entryPoint: 'infobip_voice_websocket',
    orgId: input.orgId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestId: input.requestId ?? null,
    actor: {
      identityStatus: 'unknown',
      trustLevel: 'channel',
      verifiedFactors: ['voice_channel'],
      userId: null,
      contactId: null,
      phone: input.fromPhone || null,
      email: null,
      displayName: null
    },
    message: {
      text: input.transcript,
      language: null,
      timestamp: input.timestamp
    },
    context: {
      callId: input.callId,
      turnNumber: input.turnNumber,
      previousTurns: input.previousTurns ?? []
    }
  };
}

export function mapVoiceOutputToSofiaCoreOutput(input: SofiaVoiceOutputAdapterInput): SofiaCoreOutput {
  const handoff = input.handoff === true;

  return {
    channel: 'voice',
    entryPoint: 'infobip_voice_websocket',
    orgId: input.orgId,
    sessionId: input.sessionId,
    requestId: input.requestId ?? null,
    responseText: input.responseText,
    shouldEndSession: input.shouldEndCall === true,
    handoff,
    handoffReason: handoff ? input.handoffReason ?? null : null,
    policyDecision: createPassivePolicyDecision({
      handoff,
      handoffReason: handoff ? input.handoffReason ?? null : null
    }),
    requestedActions: input.requestedActions ?? [],
    toolResults: input.toolResults ?? [],
    metadata: input.metadata ?? {}
  };
}
