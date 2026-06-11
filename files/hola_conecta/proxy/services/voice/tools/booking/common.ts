import { logInfo } from '../../../../utils/logger.js';
import {
  createSofiaVoiceBooking,
  getSofiaBookingOptions,
  type SofiaVoiceBookingOption as LiveBookingOption,
  type VoiceBookingLookupSummary
} from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import type { SofiaIdentityResolutionResult } from '../../../../sofia/sofia_identity_agent/identityTypes.ts';
import type { GeminiDomain } from '../../infobipMediaWebSocketGeminiTypes.ts';
import type { GeminiToolResponseBody } from '../../sofiaVoiceToolArgs.ts';
import { buildSofiaVoiceDebugJsonDump } from '../../sofiaVoiceDeepDebugLog.ts';
import type { VoiceSession } from '../../voiceSessionTypes.ts';

export type SendGeminiToolResponse = (
  name: string,
  toolCallId: string | null,
  response: GeminiToolResponseBody
) => void;

export type SofiaBookingVoiceToolDeps = {
  getSofiaBookingOptions: typeof getSofiaBookingOptions;
  createSofiaVoiceBooking: typeof createSofiaVoiceBooking;
};

export type SofiaBookingVoiceToolContext = {
  activeBookingMap: Map<string, VoiceBookingLookupSummary>;
  activeGeminiDomain: GeminiDomain;
  bookingSlotMap: Map<string, LiveBookingOption>;
  callerIdentity: SofiaIdentityResolutionResult | null;
  deps?: Partial<SofiaBookingVoiceToolDeps>;
  logContext: string;
  sendGeminiToolResponse: SendGeminiToolResponse;
  session: VoiceSession | null;
};

export function readErrorCode(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

export function logBookingBoundary(
  context: SofiaBookingVoiceToolContext,
  event: string,
  toolName: string,
  toolCallId: string | null,
  value: Record<string, unknown>
): void {
  logInfo(context.logContext, event, {
    sessionId: context.session?.sessionId || null,
    callId: context.session?.callId || null,
    orgId: context.session?.orgId || null,
    activeDomain: context.activeGeminiDomain,
    toolCallId,
    toolName,
    dump: buildSofiaVoiceDebugJsonDump({
      label: `${toolName}_${event}`,
      value
    })
  });
}
