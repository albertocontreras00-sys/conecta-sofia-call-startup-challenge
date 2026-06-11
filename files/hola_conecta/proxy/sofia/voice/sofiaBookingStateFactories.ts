import type {
  BookingIntentState,
  SofiaReceptionistSessionState,
  SofiaSessionState
} from '../../services/voice/voiceSessionTypes.ts';

export function createEmptyBookingIntentState(input: {
  callerPhone?: string | null;
} = {}): BookingIntentState {
  return {
    intent: null,
    offeredOptions: [],
    selectedOption: null,
    selectedOptionId: null,
    rejectionCount: 0,
    preferredStaffName: null,
    preferredDateTime: null,
    preferredDate: null,
    preferredTime: null,
    preferredTimeRelation: null,
    preferredTimeWindow: null,
    preferredEventId: null,
    preferredEventName: null,
    pendingEventSelection: false,
    eventSelectionOptions: [],
    callerPhone: input.callerPhone || null,
    confirmationStatus: 'not_ready',
    smsDestinationStatus: 'not_requested',
    smsPhoneOverride: null,
    bookingId: null,
    activeBookingId: null,
    activeBookingSummary: null,
    activeBookingCandidates: [],
    activeBookingSelectionStatus: 'none',
    pendingBookingAction: null,
    pendingBookingActionStatus: null,
    pendingBookingActionBookingId: null,
    pendingRescheduleOption: null,
    pendingRescheduleOptionId: null,
    pendingRescheduleExpiresAt: null,
    pendingExpiresAt: null,
    completedAwaitingFollowup: false
  };
}

export function createEmptySofiaSessionState(input: {
  callerPhone?: string | null;
} = {}): SofiaSessionState {
  return {
    booking: createEmptyBookingIntentState(input),
    pendingAction: null
  };
}

export function createEmptySofiaReceptionistSessionState(): SofiaReceptionistSessionState {
  return {
    outcomes: [],
    actionTraces: [],
    escalationReasons: [],
    unresolvedIssues: [],
    requestedTopic: null,
    requestedHumanOrTopic: null,
    language: null,
    failedAttemptCount: 0,
    callbackRequested: false,
    finalized: false,
    followUpTaskId: null,
    summary: null
  };
}
