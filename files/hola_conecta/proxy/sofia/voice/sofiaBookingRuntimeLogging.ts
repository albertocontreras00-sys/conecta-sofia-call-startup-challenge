import { logInfo } from '../../utils/logger.js';
import type {
  BookingIntentState,
  JsonRecord,
  VoiceTurnOutput
} from '../../services/voice/voiceSessionTypes.ts';
import { hasStructuredPreference } from './sofiaBookingPreferences.ts';

const LOG_CONTEXT = 'sofiaBookingState';

type BookingLogContextInput = {
  orgId: string;
  callId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  dialogId?: string | null;
};

type RuntimeLogResult = {
  handled: boolean;
  state: BookingIntentState;
  output: VoiceTurnOutput | null;
};

export function bookingLogContext(input: BookingLogContextInput): JsonRecord {
  return {
    orgId: input.orgId,
    callId: input.callId || null,
    sessionId: input.sessionId || null,
    turnId: input.turnId || null,
    dialogId: input.dialogId || null,
    tool: 'sofia_booking_tool'
  };
}

export function bookingStateLogSummary(state: BookingIntentState): JsonRecord {
  return {
    intent: state.intent,
    confirmationStatus: state.confirmationStatus,
    smsDestinationStatus: state.smsDestinationStatus,
    offeredOptionCount: state.offeredOptions.length,
    selectedOptionPresent: Boolean(state.selectedOption),
    activeBookingPresent: Boolean(state.activeBookingId),
    activeBookingCandidateCount: state.activeBookingCandidates.length,
    activeBookingSelectionStatus: state.activeBookingSelectionStatus,
    pendingBookingAction: state.pendingBookingAction,
    pendingBookingActionStatus: state.pendingBookingActionStatus,
    pendingRescheduleOptionPresent: Boolean(state.pendingRescheduleOption),
    completedAwaitingFollowup: state.completedAwaitingFollowup,
    preferencePresent: hasStructuredPreference(state),
    preferredStaffNamePresent: Boolean(state.preferredStaffName),
    preferredEventIdPresent: Boolean(state.preferredEventId),
    pendingEventSelection: state.pendingEventSelection,
    eventSelectionOptionCount: state.eventSelectionOptions.length
  };
}

export function logRuntimeOutput(
  eventName: string,
  context: JsonRecord,
  result: RuntimeLogResult,
  route: string
): void {
  logInfo(LOG_CONTEXT, eventName, {
    ...context,
    route,
    status: result.handled ? 'handled' : 'not_handled',
    outputPresent: Boolean(result.output),
    replyLength: result.output?.responseText?.length || 0,
    handoff: result.output?.handoff === true,
    shouldEndCall: result.output?.shouldEndCall === true,
    outputTool: typeof result.output?.metadata?.tool === 'string' ? result.output.metadata.tool : null,
    outputReason: typeof result.output?.metadata?.reason === 'string' ? result.output.metadata.reason : null,
    outputMetadataKeys: result.output?.metadata ? Object.keys(result.output.metadata).sort() : [],
    ...bookingStateLogSummary(result.state)
  });
}

export function logMutationSkipped(context: JsonRecord, reason: string): void {
  logInfo(LOG_CONTEXT, 'voice.booking.mutation.skipped', {
    ...context,
    action: 'create_sofia_voice_booking',
    status: 'skipped',
    reason
  });
}
