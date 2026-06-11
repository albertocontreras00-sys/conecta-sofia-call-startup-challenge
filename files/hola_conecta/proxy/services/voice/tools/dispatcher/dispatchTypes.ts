import type { WebSocket } from 'ws';
import type { GeminiDomain } from '../../infobipMediaWebSocketGeminiTypes.ts';
import type { GeminiToolResponseBody } from '../../sofiaVoiceToolArgs.ts';
import type { SofiaBookingVoiceToolContext } from '../booking/common.ts';
import type { SofiaOwnerDebugVoiceToolContext } from '../debug/common.ts';
import type { SofiaIdentityCrmVoiceToolContext } from '../identity/types.ts';
import type { SofiaReceptionistVoiceToolContext } from '../receptionist/common.ts';
import type { SofiaUserTransferVoiceToolContext } from '../transfer/prepareUserTransfer.ts';
import type { VoiceSession } from '../../voiceSessionTypes.ts';

export type GeminiToolCall = {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
};

export type DispatchGeminiToolContext = {
  activeGeminiDomain: GeminiDomain;
  bookingToolContext: () => SofiaBookingVoiceToolContext;
  identityCrmToolContext: () => SofiaIdentityCrmVoiceToolContext;
  receptionistToolContext: () => SofiaReceptionistVoiceToolContext;
  userTransferToolContext: () => SofiaUserTransferVoiceToolContext;
  ownerDebugToolContext: () => SofiaOwnerDebugVoiceToolContext;
  buildCurrentSessionHistory: (nextDomain: GeminiDomain, handoffSummary: string) => string;
  connectToGeminiDomain: (domain: GeminiDomain, sessionHistory: string) => void;
  emitLocalDebugEvent: (eventType: string, metadata: Record<string, unknown>) => void;
  gemini: WebSocket | null;
  logContext: string;
  requestEndCall: (reason: string, toolCallId: string | null) => void;
  sendGeminiToolResponse: (name: string, toolCallId: string | null, response: GeminiToolResponseBody) => void;
  session: VoiceSession | null;
  setCurrentSessionHistory: (sessionHistory: string) => void;
  setRebindInProgress: (value: boolean) => void;
};
