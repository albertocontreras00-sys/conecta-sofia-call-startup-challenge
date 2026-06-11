import type {
  VoiceBookingLookupSummary,
  SofiaVoiceBookingOption as LiveBookingOption
} from '../../../sofia/services/sofiaVoiceBookingService.ts';
import type { SofiaIdentityResolutionResult } from '../../../sofia/sofia_identity_agent/identityTypes.ts';
import type {
  SofiaIdentityCrmVoiceToolContext,
  SofiaPendingContactFieldUpdate,
  SofiaPendingContactNoteOrTask
} from '../tools/identity/types.ts';
import type { SofiaBookingVoiceToolContext } from '../tools/booking/common.ts';
import type { SofiaOwnerDebugVoiceToolContext } from '../tools/debug/common.ts';
import type { SofiaReceptionistVoiceToolContext } from '../tools/receptionist/common.ts';
import type { SofiaUserTransferVoiceToolContext } from '../tools/transfer/prepareUserTransfer.ts';
import type { GeminiDomain } from '../infobipMediaWebSocketGeminiTypes.ts';
import type { GeminiToolResponseBody } from '../sofiaVoiceToolArgs.ts';
import type { VoiceSession } from '../voiceSessionTypes.ts';

export type SofiaVoiceToolContextFactories = {
  bookingToolContext: () => SofiaBookingVoiceToolContext;
  identityCrmToolContext: () => SofiaIdentityCrmVoiceToolContext;
  ownerDebugToolContext: () => SofiaOwnerDebugVoiceToolContext;
  receptionistToolContext: () => SofiaReceptionistVoiceToolContext;
  userTransferToolContext: () => SofiaUserTransferVoiceToolContext;
};

export function createSofiaVoiceToolContextFactories(input: {
  activeBookingMap: Map<string, VoiceBookingLookupSummary>;
  bookingSlotMap: Map<string, LiveBookingOption>;
  emitLocalDebugEvent: (eventType: string, metadata: Record<string, unknown>) => void;
  getActiveGeminiDomain: () => GeminiDomain;
  getCallerIdentity: () => SofiaIdentityResolutionResult | null;
  getSession: () => VoiceSession | null;
  logContext: string;
  pendingContactFieldUpdates: Map<string, SofiaPendingContactFieldUpdate>;
  pendingContactNotesOrTasks: Map<string, SofiaPendingContactNoteOrTask>;
  recentLocalDebugEvents: Record<string, unknown>[];
  recentToolEvents: Record<string, unknown>[];
  sendGeminiToolResponse: (name: string, toolCallId: string | null, response: GeminiToolResponseBody) => void;
}): SofiaVoiceToolContextFactories {
  return {
    bookingToolContext: () => ({
      activeBookingMap: input.activeBookingMap,
      activeGeminiDomain: input.getActiveGeminiDomain(),
      bookingSlotMap: input.bookingSlotMap,
      callerIdentity: input.getCallerIdentity(),
      logContext: input.logContext,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session: input.getSession()
    }),
    identityCrmToolContext: () => ({
      activeGeminiDomain: input.getActiveGeminiDomain(),
      callerIdentity: input.getCallerIdentity(),
      logContext: input.logContext,
      pendingContactFieldUpdates: input.pendingContactFieldUpdates,
      pendingContactNotesOrTasks: input.pendingContactNotesOrTasks,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session: input.getSession()
    }),
    receptionistToolContext: () => ({
      activeGeminiDomain: input.getActiveGeminiDomain(),
      callerIdentity: input.getCallerIdentity(),
      logContext: input.logContext,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session: input.getSession()
    }),
    userTransferToolContext: () => ({
      activeGeminiDomain: input.getActiveGeminiDomain(),
      logContext: input.logContext,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session: input.getSession()
    }),
    ownerDebugToolContext: () => ({
      activeGeminiDomain: input.getActiveGeminiDomain(),
      emitLocalDebugEvent: input.emitLocalDebugEvent,
      logContext: input.logContext,
      recentLocalDebugEvents: input.recentLocalDebugEvents,
      recentToolEvents: input.recentToolEvents,
      sendGeminiToolResponse: input.sendGeminiToolResponse,
      session: input.getSession()
    })
  };
}
