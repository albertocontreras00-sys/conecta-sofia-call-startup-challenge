import { logInfo } from '../../utils/logger.js';
import type {
  getSofiaBookingOptions,
  lookupUpcomingVoiceBookings
} from '../services/sofiaVoiceBookingService.ts';
import type {
  BookingIntentState,
  JsonRecord,
  SofiaActiveBookingSummary,
  SofiaVoiceBookingOption,
  VoiceTurnOutput
} from '../../services/voice/voiceSessionTypes.ts';
import {
  hasStructuredPreference
} from './sofiaBookingPreferences.ts';
import {
  formatBookingSummaryForVoice,
  formatMultipleBookingSummaries
} from './sofiaBookingFormatters.ts';
import {
  bookingOptionId,
  buildMetadata,
  buildNoMatchingPreferenceResponse,
  clearNewBookingSelection,
  mutationBlockedResponse,
  observabilityFromTurn,
  pendingBookingExpiresAt,
  setSelectedActiveBooking,
  toActiveBookingSummary
} from './sofiaBookingStateHelpers.ts';

const LOG_CONTEXT = 'sofiaBookingState';

type SofiaBookingTurnResult = {
  handled: boolean;
  state: BookingIntentState;
  output: VoiceTurnOutput | null;
};

type TurnInput = {
  orgId: string;
  callId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  dialogId?: string | null;
  callerPhone: string;
  now?: Date;
};

type SofiaBookingDeps = {
  getSofiaBookingOptions: typeof getSofiaBookingOptions;
  lookupUpcomingVoiceBookings: typeof lookupUpcomingVoiceBookings;
};

export async function lookupUpcomingForMutation(input: {
  input: TurnInput;
  state: BookingIntentState;
  deps: SofiaBookingDeps;
  logContext: JsonRecord;
}): Promise<{ bookings: SofiaActiveBookingSummary[] }> {
  const startedAt = Date.now();
  logInfo(LOG_CONTEXT, 'voice.booking.lookup_upcoming.started', {
    ...input.logContext,
    action: 'lookup_upcoming_voice_bookings',
    status: 'started'
  });
  const bookings = await input.deps.lookupUpcomingVoiceBookings({
    orgId: input.input.orgId,
    callerPhone: input.input.callerPhone,
    ...(input.input.now !== undefined ? { now: input.input.now } : {}),
    limit: 3
  });
  logInfo(LOG_CONTEXT, 'voice.booking.lookup_upcoming.succeeded', {
    ...input.logContext,
    action: 'lookup_upcoming_voice_bookings',
    status: 'succeeded',
    durationMs: Date.now() - startedAt,
    bookingCount: bookings.length
  });
  clearNewBookingSelection(input.state);
  const summaries = bookings.map(toActiveBookingSummary);
  input.state.activeBookingCandidates = summaries;
  if (summaries.length === 1) {
    const summary = summaries[0];
    if (!summary) {
      throw new Error('Expected Sofia active booking summary but none was returned');
    }
    setSelectedActiveBooking(input.state, summary);
  } else if (summaries.length > 1) {
    input.state.activeBookingId = null;
    input.state.activeBookingSummary = summaries[0] || null;
    input.state.activeBookingSelectionStatus = 'multiple_found';
  } else {
    input.state.activeBookingId = null;
    input.state.activeBookingSummary = null;
    input.state.activeBookingSelectionStatus = 'none';
  }
  return { bookings: summaries };
}

export async function searchRescheduleOptions(input: {
  input: TurnInput;
  state: BookingIntentState;
  deps: SofiaBookingDeps;
  spanish: boolean;
  logContext: JsonRecord;
}): Promise<SofiaBookingTurnResult> {
  const bookingId = input.state.pendingBookingActionBookingId || input.state.activeBookingId;
  if (!bookingId) {
    return mutationBlockedResponse(input.state, input.spanish, 'active_booking_required');
  }
  const optionsResult = await input.deps.getSofiaBookingOptions({
    orgId: input.input.orgId,
    callerPhone: input.input.callerPhone,
    ...(input.state.preferredStaffName !== undefined ? { preferredStaffName: input.state.preferredStaffName } : {}),
    ...(input.state.preferredDateTime !== undefined ? { preferredDateTime: input.state.preferredDateTime } : {}),
    ...(input.state.preferredDate !== undefined ? { preferredDate: input.state.preferredDate } : {}),
    ...(input.state.preferredTime !== undefined ? { preferredTime: input.state.preferredTime } : {}),
    ...(input.state.preferredTimeRelation !== undefined ? { preferredTimeRelation: input.state.preferredTimeRelation } : {}),
    ...(input.state.preferredTimeWindow !== undefined ? { preferredTimeWindow: input.state.preferredTimeWindow } : {}),
    limit: 3,
    ...(input.input.now !== undefined ? { now: input.input.now } : {}),
    excludeBookingId: bookingId,
    observability: observabilityFromTurn(input.input)
  });
  input.state.offeredOptions = optionsResult.options as SofiaVoiceBookingOption[];
  input.state.pendingRescheduleOption = optionsResult.defaultOption as SofiaVoiceBookingOption | null;
  input.state.pendingRescheduleOptionId = input.state.pendingRescheduleOption ? bookingOptionId(input.state.pendingRescheduleOption) : null;
  input.state.pendingRescheduleExpiresAt = input.state.pendingRescheduleOption ? pendingBookingExpiresAt(input.input.now || new Date()) : null;
  input.state.pendingBookingActionStatus = input.state.pendingRescheduleOption ? 'awaiting_confirmation' : 'awaiting_new_slot';
  if (!input.state.pendingRescheduleOption) {
    return {
      handled: true,
      state: input.state,
      output: {
        responseText: buildNoMatchingPreferenceResponse({
          spanish: input.spanish,
          state: input.state,
          optionsResult
        }),
        handoff: !hasStructuredPreference(input.state),
        metadata: buildMetadata(input.state, { tool: 'get_booking_options', reschedule: true })
      }
    };
  }
  return {
    handled: true,
    state: input.state,
    output: {
      responseText: optionsResult.preferenceMatched === false
        ? buildNoMatchingPreferenceResponse({ spanish: input.spanish, state: input.state, optionsResult })
        : input.spanish
          ? `La puedo mover para ${input.state.pendingRescheduleOption.displayText}. ¿Quiere que la cambie?`
          : `I can move it to ${input.state.pendingRescheduleOption.displayText}. Do you want me to reschedule it?`,
      metadata: buildMetadata(input.state, {
        tool: 'get_booking_options',
        reschedule: true,
        offeredOptionCount: input.state.offeredOptions.length,
        preferenceMatched: optionsResult.preferenceMatched !== false
      })
    }
  };
}

export async function handleExistingAppointmentLookup(input: {
  input: TurnInput;
  state: BookingIntentState;
  deps: SofiaBookingDeps;
  spanish: boolean;
  logContext: JsonRecord;
}): Promise<SofiaBookingTurnResult> {
  const { input: turnInput, state, deps, spanish, logContext } = input;
  const lookupStartedAt = Date.now();
  logInfo(LOG_CONTEXT, 'voice.booking.lookup_upcoming.started', {
    ...logContext,
    action: 'lookup_upcoming_voice_bookings',
    status: 'started'
  });
  const bookings = await deps.lookupUpcomingVoiceBookings({
    orgId: turnInput.orgId,
    callerPhone: turnInput.callerPhone,
    ...(turnInput.now !== undefined ? { now: turnInput.now } : {}),
    limit: 3
  });
  logInfo(LOG_CONTEXT, 'voice.booking.lookup_upcoming.succeeded', {
    ...logContext,
    action: 'lookup_upcoming_voice_bookings',
    status: 'succeeded',
    durationMs: Date.now() - lookupStartedAt,
    bookingCount: bookings.length
  });

  state.intent = 'book_appointment';
  state.offeredOptions = [];
  state.selectedOption = null;
  state.selectedOptionId = null;
  state.pendingExpiresAt = null;
  state.confirmationStatus = 'not_ready';
  state.smsDestinationStatus = 'not_requested';
  state.smsPhoneOverride = null;

  if (bookings.length === 0) {
    state.activeBookingId = null;
    state.activeBookingSummary = null;
    state.activeBookingCandidates = [];
    state.activeBookingSelectionStatus = 'none';
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? 'No encontré ninguna cita próxima para este número. Si quiere, puedo ayudarle a reservar una.'
          : 'I did not find an upcoming appointment for this number. I can help you book one if you would like.',
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: 0 })
      }
    };
  }

  if (bookings.length === 1) {
    const booking = bookings[0];
    if (!booking) {
      throw new Error('Expected Sofia active booking summary but none was returned');
    }
    const summary = toActiveBookingSummary(booking);
    state.activeBookingId = summary.bookingId;
    state.activeBookingSummary = summary;
    state.activeBookingCandidates = [summary];
    state.activeBookingSelectionStatus = 'single_found';
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? `Su cita es ${formatBookingSummaryForVoice(summary, true)}.`
          : `Your appointment is ${formatBookingSummaryForVoice(summary, false)}.`,
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: 1 })
      }
    };
  }

  const summaries = bookings.slice(0, 3).map(toActiveBookingSummary);
  state.activeBookingId = null;
  state.activeBookingSummary = summaries[0] || null;
  state.activeBookingCandidates = summaries;
  state.activeBookingSelectionStatus = 'multiple_found';
  return {
    handled: true,
    state,
    output: {
      responseText: spanish
        ? `Encontré más de una cita próxima: ${formatMultipleBookingSummaries(summaries, true)}. ¿Cuál quiere revisar?`
        : `I found more than one upcoming appointment: ${formatMultipleBookingSummaries(summaries, false)}. Which one do you mean?`,
      metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: bookings.length })
    }
  };
}
