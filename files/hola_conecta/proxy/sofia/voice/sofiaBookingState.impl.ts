import {
  createSofiaVoiceBooking,
  getSofiaBookingOptions,
  lookupUpcomingVoiceBookings,
  cancelVoiceBooking,
  rescheduleVoiceBooking
} from '../services/sofiaVoiceBookingService.ts';
import { logError, logInfo } from '../../utils/logger.js';
import type {
  BookingIntentState,
  JsonRecord,
  SofiaVoiceBookingOption,
  SofiaPendingBookingAction,
  SofiaVoiceLanguage
} from '../../services/voice/voiceSessionTypes.ts';
import { isSpanishVoiceLanguage } from './sofiaVoiceLanguage.ts';
import {
  extractPhoneNumber,
  extractPreferredStaffName,
  isBookingRefinement,
  isConfirmation,
  isCorrection,
  isEndIntent,
  isRejection,
} from './sofiaBookingIntent.ts';
import {
  applyPreferenceUpdate,
  applyRelativePreferenceUpdate,
  extractBookingPreferenceUpdate,
  hasPreferenceUpdate,
  hasStructuredPreference,
  type BookingPreferenceUpdate
} from './sofiaBookingPreferences.ts';
import {
  formatAlternateOptions,
  formatBookingSummaryForVoice,
  formatMultipleBookingSummaries,
  formatStaffMatchCount,
  formatStaffNames
} from './sofiaBookingFormatters.ts';
import {
  bookingLogContext,
  bookingStateLogSummary,
  logMutationSkipped,
  logRuntimeOutput
} from './sofiaBookingRuntimeLogging.ts';
import {
  bookingOptionId,
  buildMetadata,
  buildNoMatchingPreferenceResponse,
  clearPendingBookingAction,
  errorCode,
  errorMessage,
  isPendingRescheduleExpired,
  isTerminalActiveBooking,
  mutationBlockedResponse,
  observabilityFromTurn,
  pendingBookingExpiresAt,
  resolveActiveBookingSelection,
  setSelectedActiveBooking,
  validateReadyToConfirmSelectedOption,
  validateTrustedBookingContext
} from './sofiaBookingStateHelpers.ts';
import {
  buildEventSelectionPrompt,
  resolveSofiaEventSelection
} from './sofiaBookingEventSelection.ts';
import {
  handleExistingAppointmentLookup,
  lookupUpcomingForMutation,
  searchRescheduleOptions
} from './sofiaBookingLookupRuntime.ts';
import { createEmptyBookingIntentState } from './sofiaBookingStateFactories.ts';
import { SofiaBookingStateDecisionRequiredError, type SofiaBookingAgentDecision, type SofiaBookingTurnResult } from './sofiaBookingStateTypes.ts';

export { isAppointmentLookupIntent } from './sofiaBookingIntent.ts';
export { serializeBookingStateForMetadata } from './sofiaBookingStateHelpers.ts';
export { SofiaBookingStateDecisionRequiredError, type SofiaBookingAgentDecision, type SofiaBookingTurnResult } from './sofiaBookingStateTypes.ts';
export {
  createEmptyBookingIntentState,
  createEmptySofiaReceptionistSessionState,
  createEmptySofiaSessionState
} from './sofiaBookingStateFactories.ts';

export type SofiaBookingDeps = {
  getSofiaBookingOptions: typeof getSofiaBookingOptions;
  createSofiaVoiceBooking: typeof createSofiaVoiceBooking;
  lookupUpcomingVoiceBookings: typeof lookupUpcomingVoiceBookings;
  cancelVoiceBooking: typeof cancelVoiceBooking;
  rescheduleVoiceBooking: typeof rescheduleVoiceBooking;
};

type HandleSofiaBookingTurnInput = {
  orgId: string;
  callId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  dialogId?: string | null;
  callerPhone: string;
  transcript: string;
  state: BookingIntentState | null | undefined;
  language?: SofiaVoiceLanguage;
  assumeAppointmentLookup?: boolean;
  agentDecision: SofiaBookingAgentDecision;
  now?: Date;
  deps?: Partial<SofiaBookingDeps>;
};

const LOG_CONTEXT = 'sofiaBookingState';

const defaultDeps: SofiaBookingDeps = {
  getSofiaBookingOptions,
  createSofiaVoiceBooking,
  lookupUpcomingVoiceBookings,
  cancelVoiceBooking,
  rescheduleVoiceBooking
};

export async function handleSofiaBookingTurn(
  input: HandleSofiaBookingTurnInput
): Promise<SofiaBookingTurnResult> {
  if (!input.agentDecision) {
    throw new SofiaBookingStateDecisionRequiredError();
  }
  const deps = { ...defaultDeps, ...(input.deps || {}) };
  const transcript = input.transcript.trim();
  const state: BookingIntentState = {
    ...createEmptyBookingIntentState({ callerPhone: input.callerPhone }),
    ...(input.state || {}),
    callerPhone: input.state?.callerPhone || input.callerPhone
  };
  const text = transcript.toLowerCase();
  const language = input.language || 'en';
  const spanish = isSpanishVoiceLanguage(language);
  const selectedBookingTool = input.agentDecision.toolName;
  const bookingActive = state.intent === 'book_appointment';
  const bookingRequested = selectedBookingTool === 'get_booking_options';
  const appointmentLookupRequested = selectedBookingTool === 'lookup_upcoming_voice_bookings';
  const cancelRequested = selectedBookingTool === 'prepare_cancel_voice_booking';
  const rescheduleRequested = selectedBookingTool === 'prepare_reschedule_voice_booking';
  const continuePendingRequested = selectedBookingTool === 'continue_pending_booking_action';
  const activeBookingSelectionRequested = selectedBookingTool === 'select_active_booking';
  const createBookingRequested = selectedBookingTool === 'create_sofia_voice_booking';
  const completeConversationRequested = selectedBookingTool === 'complete_booking_conversation';
  const confirmation = isConfirmation(text);
  const rejection = isRejection(text);
  const endIntent = isEndIntent(text);
  const preferredStaffName = extractPreferredStaffName(transcript);
  const preferenceUpdate = applyRelativePreferenceUpdate(
    extractBookingPreferenceUpdate(transcript, input.now || new Date()),
    text,
    state.selectedOption
  );
  const preferredDateTime = preferenceUpdate.preferredDateTime;
  const correction = isCorrection(text);
  const refinement = isBookingRefinement(text) || Boolean(
    preferenceUpdate.preferredDate
    || preferenceUpdate.preferredTime
    || preferenceUpdate.preferredTimeRelation
    || preferenceUpdate.preferredTimeWindow
  );
  const logContext = bookingLogContext(input);
  const contextValidationReason = validateTrustedBookingContext(input);
  logInfo(LOG_CONTEXT, 'voice.booking.runtime.evaluated', {
    ...logContext,
    status: 'evaluated',
    transcriptLength: transcript.length,
    language,
    selectedBookingTool,
    bookingAgentDecisionReason: input.agentDecision.reason,
    bookingAgentDecisionConfidence: input.agentDecision.confidence,
    bookingActive,
    bookingRequested,
    appointmentLookupRequested,
    cancelRequested,
    rescheduleRequested,
    confirmation,
    rejection,
    correction,
    refinement,
    endIntent,
    preferredStaffNamePresent: Boolean(preferredStaffName),
    preferredDateTimePresent: Boolean(preferredDateTime),
    contextValidationReason,
    ...bookingStateLogSummary(state)
  });

  if (continuePendingRequested) {
    const pendingMutationResult = await handlePendingBookingMutationTurn({
      input,
      state,
      deps,
      spanish,
      logContext,
      confirmation,
      rejection,
      preferenceUpdate,
      refinement,
      rescheduleRequested
    });
    if (pendingMutationResult) {
      logRuntimeOutput('voice.booking.runtime.handled', logContext, pendingMutationResult, 'pending_mutation');
      return pendingMutationResult;
    }
  }

  if (activeBookingSelectionRequested) {
    const readOnlySelectionResult = handleReadOnlyActiveBookingSelection({
      transcript,
      state,
      spanish
    });
    if (readOnlySelectionResult) {
      logRuntimeOutput('voice.booking.runtime.handled', logContext, readOnlySelectionResult, 'read_only_selection');
      return readOnlySelectionResult;
    }
  }

  if (cancelRequested) {
    logInfo(LOG_CONTEXT, 'voice.booking.runtime.route_selected', {
      ...logContext,
      route: 'cancel_booking',
      status: 'selected',
      ...bookingStateLogSummary(state)
    });
    const result = await handleBookingMutationIntent({
      action: 'cancel',
      input,
      state,
      deps,
      spanish,
      logContext,
      preferenceUpdate
    });
    logRuntimeOutput('voice.booking.runtime.handled', logContext, result, 'cancel_booking');
    return result;
  }

  if (rescheduleRequested) {
    logInfo(LOG_CONTEXT, 'voice.booking.runtime.route_selected', {
      ...logContext,
      route: 'reschedule_booking',
      status: 'selected',
      ...bookingStateLogSummary(state)
    });
    const result = await handleBookingMutationIntent({
      action: 'reschedule',
      input,
      state,
      deps,
      spanish,
      logContext,
      preferenceUpdate
    });
    logRuntimeOutput('voice.booking.runtime.handled', logContext, result, 'reschedule_booking');
    return result;
  }

  if (appointmentLookupRequested) {
    logInfo(LOG_CONTEXT, 'voice.booking.runtime.route_selected', {
      ...logContext,
      route: 'lookup_upcoming_voice_bookings',
      status: 'selected',
      ...bookingStateLogSummary(state)
    });
    const result = await handleExistingAppointmentLookup({ input, state, deps, spanish, logContext });
    logRuntimeOutput('voice.booking.runtime.handled', logContext, result, 'lookup_upcoming_voice_bookings');
    return result;
  }

  if (state.completedAwaitingFollowup && completeConversationRequested) {
    if (endIntent) {
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? 'Gracias por llamar. Que tenga buen día.' : 'Thanks for calling. Have a good day.',
          shouldEndCall: true,
          metadata: buildMetadata(state, { reason: 'completed_booking_end_intent' })
        }
      };
    }
    const result = { handled: false, state, output: null };
    logRuntimeOutput('voice.booking.runtime.not_handled', logContext, result, 'completed_awaiting_followup');
    return result;
  }

  if (!bookingActive && !bookingRequested && !preferredStaffName) {
    const result = { handled: false, state, output: null };
    logRuntimeOutput('voice.booking.runtime.not_handled', logContext, result, 'no_booking_intent');
    return result;
  }

  state.intent = 'book_appointment';
  const staffPreferenceChanged = Boolean(preferredStaffName && preferredStaffName !== state.preferredStaffName);
  if (preferredStaffName) state.preferredStaffName = preferredStaffName;
  applyPreferenceUpdate(state, preferenceUpdate);
  const selectedEvent = resolveSofiaEventSelection(transcript, state.eventSelectionOptions);
  if (selectedEvent) {
    state.preferredEventId = selectedEvent.eventId;
    state.preferredEventName = selectedEvent.eventName;
    state.pendingEventSelection = false;
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    state.rejectionCount = 0;
  }

  if (correction) {
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    state.rejectionCount = 0;
    if (!preferredStaffName && !selectedEvent && !hasStructuredPreference(state)) {
      logMutationSkipped(logContext, 'preference_required');
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? 'Claro, ¿qué día u hora prefiere?' : 'Sure, what day or time would you prefer?',
          metadata: buildMetadata(state)
        }
      };
    }
  } else if (staffPreferenceChanged) {
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    state.rejectionCount = 0;
  }

  if (selectedBookingTool === 'get_booking_options' && state.pendingEventSelection && state.eventSelectionOptions.length > 1 && !state.preferredEventId) {
    logMutationSkipped(logContext, 'event_selection_required');
    return {
      handled: true,
      state,
      output: {
        responseText: buildEventSelectionPrompt(state.eventSelectionOptions, spanish),
        metadata: buildMetadata(state, {
          tool: 'get_booking_options',
          eventSelectionRequired: true,
          eventCount: state.eventSelectionOptions.length
        })
      }
    };
  }

  if (state.smsDestinationStatus === 'awaiting_mobile_number') {
    const smsPhoneOverride = extractPhoneNumber(transcript);
    if (!smsPhoneOverride) {
      logMutationSkipped(logContext, 'sms_mobile_number_required');
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? '¿A qué número móvil se lo mando?' : 'What mobile number should I send it to?',
          metadata: buildMetadata(state, { reason: 'sms_mobile_number_required' })
        }
      };
    }
    state.smsPhoneOverride = smsPhoneOverride;
    state.smsDestinationStatus = 'confirmed';
  } else if (createBookingRequested && confirmation && state.selectedOption) {
    const blockedOutput = validateReadyToConfirmSelectedOption({
      state,
      input,
      contextValidationReason,
      logContext,
      spanish
    });
    if (blockedOutput) return blockedOutput;
    state.smsDestinationStatus = 'confirmed';
  }

  if (createBookingRequested && state.smsDestinationStatus === 'confirmed' && state.selectedOption) {
    const blockedOutput = validateReadyToConfirmSelectedOption({
      state,
      input,
      contextValidationReason,
      logContext,
      spanish
    });
    if (blockedOutput) return blockedOutput;
    state.confirmationStatus = 'confirmed';
    const createStartedAt = Date.now();
    logInfo(LOG_CONTEXT, 'voice.booking.create.started', {
      ...logContext,
      action: 'create_sofia_voice_booking',
      status: 'started'
    });
    let result: Awaited<ReturnType<typeof deps.createSofiaVoiceBooking>>;
    try {
      result = await deps.createSofiaVoiceBooking({
        orgId: input.orgId,
        callerPhone: input.callerPhone,
        selectedOption: state.selectedOption as SofiaVoiceBookingOption,
        confirmationReceived: true,
        smsPhoneOverride: state.smsPhoneOverride,
        observability: observabilityFromTurn(input)
      });
      logInfo(LOG_CONTEXT, 'voice.booking.create.succeeded', {
        ...logContext,
        action: 'create_sofia_voice_booking',
        status: 'succeeded',
        durationMs: Date.now() - createStartedAt,
        bookingCreated: true,
        smsSent: result.smsSent === true,
        smsStatus: result.smsStatus || null
      });
    } catch (error) {
      logError(LOG_CONTEXT, 'voice.booking.create.failed', error, {
        ...logContext,
        action: 'create_sofia_voice_booking',
        status: 'failed',
        durationMs: Date.now() - createStartedAt,
        errorCode: errorCode(error),
        errorMessage: errorMessage(error)
      });
      throw error;
    }
    const bookedDisplayText = state.selectedOption.displayText;
    state.bookingId = result.bookingId;
    state.offeredOptions = [];
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    state.completedAwaitingFollowup = true;
    return {
      handled: true,
      state,
      output: {
        responseText: spanish ? 'Su cita está confirmada. Le estoy mandando el mensaje de confirmación. ¿Hay algo más en lo que le pueda ayudar?' : "Your appointment is confirmed. I'm sending the confirmation text now. Is there anything else I can help you with?",
        shouldEndCall: false,
        metadata: buildMetadata(state, {
          bookingId: result.bookingId,
          smsSent: result.smsSent,
          smsStatus: result.smsStatus,
          bookedDisplayText,
          tool: 'create_sofia_voice_booking'
        })
      }
    };
  }

  if (selectedBookingTool === 'get_booking_options' && !correction && rejection && state.offeredOptions.length > 0) {
    state.rejectionCount += 1;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    if (state.rejectionCount === 1) {
      const alternates = state.offeredOptions.slice(1, 3);
      state.selectedOption = alternates[0] || null;
      state.selectedOptionId = state.selectedOption ? bookingOptionId(state.selectedOption) : null;
      state.pendingExpiresAt = state.selectedOption ? pendingBookingExpiresAt(input.now || new Date()) : null;
      if (alternates.length > 0) {
        logMutationSkipped(logContext, 'confirmation_missing');
        return {
          handled: true,
          state,
          output: {
            responseText: spanish ? `No hay problema. También tengo ${formatAlternateOptions(alternates)}. ¿Alguna de esas opciones le funciona?` : `No problem. I also have ${formatAlternateOptions(alternates)}. Would either of those work?`,
            metadata: buildMetadata(state, { tool: 'get_booking_options', offeredOptionCount: state.offeredOptions.length })
          }
        };
      }
    }
    if (state.rejectionCount >= 2) {
      state.selectedOption = null;
      state.selectedOptionId = null;
      state.pendingExpiresAt = null;
      state.smsDestinationStatus = 'not_requested';
      state.smsPhoneOverride = null;
      logMutationSkipped(logContext, 'preference_required');
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? '¿Qué día u hora le funciona mejor?' : 'What day or time works better for you?',
          metadata: buildMetadata(state)
        }
      };
    }
  }

  if (selectedBookingTool === 'get_booking_options') {
    const optionsStartedAt = Date.now();
    logInfo(LOG_CONTEXT, 'voice.booking.options.started', {
      ...logContext,
      action: 'get_booking_options',
      status: 'started'
    });
    let optionsResult: Awaited<ReturnType<typeof deps.getSofiaBookingOptions>>;
    try {
      optionsResult = await deps.getSofiaBookingOptions({
        orgId: input.orgId,
        callerPhone: input.callerPhone,
        ...(state.preferredStaffName !== undefined ? { preferredStaffName: state.preferredStaffName } : {}),
        ...(state.preferredDateTime !== undefined ? { preferredDateTime: state.preferredDateTime } : {}),
        ...(state.preferredDate !== undefined ? { preferredDate: state.preferredDate } : {}),
        ...(state.preferredTime !== undefined ? { preferredTime: state.preferredTime } : {}),
        ...(state.preferredTimeRelation !== undefined ? { preferredTimeRelation: state.preferredTimeRelation } : {}),
        ...(state.preferredTimeWindow !== undefined ? { preferredTimeWindow: state.preferredTimeWindow } : {}),
        ...(state.preferredEventId !== undefined ? { preferredEventId: state.preferredEventId } : {}),
        limit: 3,
        ...(input.now !== undefined ? { now: input.now } : {}),
        observability: observabilityFromTurn(input)
      });
      logInfo(LOG_CONTEXT, 'voice.booking.options.succeeded', {
        ...logContext,
        action: 'get_booking_options',
        status: 'succeeded',
        durationMs: Date.now() - optionsStartedAt,
        optionCount: optionsResult.options.length,
        missingRequirementCount: optionsResult.missingRequirements.length,
        staffDisambiguation: Boolean(optionsResult.staffDisambiguation?.matches?.length)
      });
    } catch (error) {
      logError(LOG_CONTEXT, 'voice.booking.options.failed', error, {
        ...logContext,
        action: 'get_booking_options',
        status: 'failed',
        durationMs: Date.now() - optionsStartedAt,
        errorCode: errorCode(error),
        errorMessage: errorMessage(error)
      });
      throw error;
    }
    if (optionsResult.eventSelectionRequired && (optionsResult.availableEvents?.length || 0) > 1) {
      state.pendingEventSelection = true;
      state.eventSelectionOptions = optionsResult.availableEvents || [];
      state.preferredEventId = null;
      state.preferredEventName = null;
      state.offeredOptions = [];
      state.selectedOption = null;
      state.selectedOptionId = null;
      state.pendingExpiresAt = null;
      state.confirmationStatus = 'not_ready';
      state.smsDestinationStatus = 'not_requested';
      state.smsPhoneOverride = null;
      logMutationSkipped(logContext, 'event_selection_required');
      return {
        handled: true,
        state,
        output: {
          responseText: buildEventSelectionPrompt(state.eventSelectionOptions, spanish),
          metadata: buildMetadata(state, {
            tool: 'get_booking_options',
            eventSelectionRequired: true,
            eventCount: state.eventSelectionOptions.length
          })
        }
      };
    }
    if (optionsResult.staffDisambiguation?.matches?.length) {
      state.selectedOption = null;
      state.selectedOptionId = null;
      state.pendingExpiresAt = null;
      state.confirmationStatus = 'not_ready';
      state.smsDestinationStatus = 'not_requested';
      state.smsPhoneOverride = null;
      logMutationSkipped(logContext, 'staff_disambiguation_required');
      return {
        handled: true,
        state,
        output: {
          responseText: spanish
            ? `Encontré ${formatStaffMatchCount(optionsResult.staffDisambiguation.matches.length, true)} con el nombre ${optionsResult.staffDisambiguation.requestedName}. ¿Se refiere a ${formatStaffNames(optionsResult.staffDisambiguation.matches, true)}?`
            : `I found ${formatStaffMatchCount(optionsResult.staffDisambiguation.matches.length)} named ${optionsResult.staffDisambiguation.requestedName}. Did you mean ${formatStaffNames(optionsResult.staffDisambiguation.matches)}?`,
          metadata: buildMetadata(state, {
            tool: 'get_booking_options',
            staffDisambiguation: optionsResult.staffDisambiguation
          })
        }
      };
    }
    if (optionsResult.missingRequirements.length > 0 && optionsResult.options.length === 0) {
      logMutationSkipped(logContext, 'missing_required_ids');
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? 'Tengo problemas para encontrar una configuración disponible para citas. Puedo pedirle a alguien de la oficina que le dé seguimiento.' : 'I am having trouble finding a bookable appointment setup. I can have someone from the office follow up.',
          handoff: true,
          metadata: buildMetadata(state, {
            tool: 'get_booking_options',
            missingRequirements: optionsResult.missingRequirements
          })
        }
      };
    }
    state.offeredOptions = optionsResult.options as SofiaVoiceBookingOption[];
    state.selectedOption = optionsResult.defaultOption as SofiaVoiceBookingOption | null;
    state.selectedOptionId = state.selectedOption ? bookingOptionId(state.selectedOption) : null;
    state.pendingExpiresAt = state.selectedOption ? pendingBookingExpiresAt(input.now || new Date()) : null;
    state.confirmationStatus = state.selectedOption ? 'ready_to_confirm' : 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    state.rejectionCount = preferredDateTime || staffPreferenceChanged || correction || refinement ? 0 : state.rejectionCount;

    if (!state.selectedOption) {
      state.selectedOptionId = null;
      state.pendingExpiresAt = null;
      logMutationSkipped(logContext, 'no_available_option');
      return {
        handled: true,
        state,
        output: {
          responseText: buildNoMatchingPreferenceResponse({
            spanish,
            state,
            optionsResult
          }),
          handoff: !hasStructuredPreference(state),
          metadata: buildMetadata(state, {
            tool: 'get_booking_options',
            missingRequirements: optionsResult.missingRequirements
          })
        }
      };
    }

    logMutationSkipped(logContext, 'confirmation_missing');
    return {
      handled: true,
      state,
      output: {
        responseText: optionsResult.preferenceMatched === false
          ? buildNoMatchingPreferenceResponse({ spanish, state, optionsResult })
          : spanish ? `La cita más pronto que tengo es ${state.selectedOption.displayText}. ¿Quiere que la reserve?` : `The soonest appointment I have is ${state.selectedOption.displayText}. Would you like me to book that?`,
        metadata: buildMetadata(state, {
          tool: 'get_booking_options',
          offeredOptionCount: state.offeredOptions.length,
          preferenceMatched: optionsResult.preferenceMatched !== false
        })
      }
    };
  }

  if (bookingActive && !confirmation) {
    logMutationSkipped(logContext, 'confirmation_missing');
  }
  const result = { handled: false, state, output: null };
  logRuntimeOutput('voice.booking.runtime.not_handled', logContext, result, 'booking_state_waiting_for_orchestrator');
  return result;
}

function handleReadOnlyActiveBookingSelection(input: {
  transcript: string;
  state: BookingIntentState;
  spanish: boolean;
}): SofiaBookingTurnResult | null {
  const { state, spanish } = input;
  if (state.pendingBookingAction) return null;
  if (state.activeBookingSelectionStatus !== 'multiple_found') return null;
  if (state.activeBookingCandidates.length === 0) return null;

  const selected = resolveActiveBookingSelection(input.transcript, state.activeBookingCandidates);
  if (!selected) {
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? '¿Cuál cita quiere decir — la primera, segunda o tercera?'
          : 'Which appointment do you mean — the first, second, or third?',
        metadata: buildMetadata(state, { reason: 'active_booking_selection_unclear' })
      }
    };
  }

  setSelectedActiveBooking(state, selected);
  return {
    handled: true,
    state,
    output: {
      responseText: spanish
        ? `Su cita es ${formatBookingSummaryForVoice(selected, true)}. ¿Quiere mantenerla, cancelarla o cambiarla?`
        : `Your appointment is ${formatBookingSummaryForVoice(selected, false)}. Do you want to keep it, cancel it, or reschedule it?`,
      metadata: buildMetadata(state, {
        tool: 'lookup_upcoming_voice_bookings',
        selectedBookingId: selected.bookingId,
        activeBookingSelected: true
      })
    }
  };
}

async function handlePendingBookingMutationTurn(input: {
  input: HandleSofiaBookingTurnInput;
  state: BookingIntentState;
  deps: SofiaBookingDeps;
  spanish: boolean;
  logContext: JsonRecord;
  confirmation: boolean;
  rejection: boolean;
  preferenceUpdate: BookingPreferenceUpdate;
  refinement: boolean;
  rescheduleRequested: boolean;
}): Promise<SofiaBookingTurnResult | null> {
  const { state, spanish } = input;
  if (!state.pendingBookingAction || !state.pendingBookingActionStatus) return null;

  if (input.rejection) {
    const action = state.pendingBookingAction;
    if (action === 'cancel') {
      clearPendingBookingAction(state, { clearActiveBooking: false });
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? 'No hay problema. No cancelé su cita.' : 'No problem. I did not cancel your appointment.',
          metadata: buildMetadata(state, { tool: 'cancel_voice_booking', cancelled: false })
        }
      };
    }
    state.pendingRescheduleOption = null;
    state.pendingRescheduleOptionId = null;
    state.pendingRescheduleExpiresAt = null;
    state.pendingBookingActionStatus = 'awaiting_new_slot';
    return {
      handled: true,
      state,
      output: {
        responseText: spanish ? 'No hay problema. ¿Quiere intentar otro día u hora?' : 'No problem. Would you like to try another day or time?',
        metadata: buildMetadata(state, { tool: 'reschedule_voice_booking', rescheduled: false })
      }
    };
  }

  if (state.pendingBookingActionStatus === 'awaiting_selection') {
    const selected = resolveActiveBookingSelection(input.input.transcript, state.activeBookingCandidates);
    if (!selected) {
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? '¿Cuál cita quiere cambiar?' : 'Which appointment do you mean?',
          metadata: buildMetadata(state, { reason: 'active_booking_selection_required' })
        }
      };
    }
    if (isTerminalActiveBooking(selected)) {
      clearPendingBookingAction(state, { clearActiveBooking: false });
      return mutationBlockedResponse(state, spanish, 'terminal_booking_not_mutable');
    }
    setSelectedActiveBooking(state, selected);
    state.pendingBookingActionBookingId = selected.bookingId;
    state.pendingBookingActionStatus = state.pendingBookingAction === 'cancel' ? 'awaiting_confirmation' : 'awaiting_new_slot';
    if (state.pendingBookingAction === 'cancel') {
      return {
        handled: true,
        state,
        output: {
          responseText: spanish
            ? `Encontré su cita para ${formatBookingSummaryForVoice(selected, true)}. ¿Quiere que la cancele?`
            : `I found your appointment for ${formatBookingSummaryForVoice(selected, false)}. Do you want me to cancel it?`,
          metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings' })
        }
      };
    }
    if (hasPreferenceUpdate(input.preferenceUpdate)) {
      applyPreferenceUpdate(state, input.preferenceUpdate);
      return searchRescheduleOptions(input);
    }
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? `Encontré su cita para ${formatBookingSummaryForVoice(selected, true)}. ¿Para qué día u hora quiere moverla?`
          : `I found your appointment for ${formatBookingSummaryForVoice(selected, false)}. What day or time would you like to move it to?`,
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings' })
      }
    };
  }

  if (state.pendingBookingAction === 'cancel' && state.pendingBookingActionStatus === 'awaiting_confirmation') {
    if (!input.confirmation) return null;
    const bookingId = state.pendingBookingActionBookingId || state.activeBookingId;
    if (!bookingId) {
      logMutationSkipped(input.logContext, 'active_booking_required');
      return mutationBlockedResponse(state, spanish, 'active_booking_required');
    }
    const result = await input.deps.cancelVoiceBooking({
      orgId: input.input.orgId,
      callerPhone: input.input.callerPhone,
      bookingId,
      ...(input.input.now !== undefined ? { now: input.input.now } : {}),
      observability: observabilityFromTurn(input.input)
    });
    clearPendingBookingAction(state, { clearActiveBooking: true });
    state.completedAwaitingFollowup = true;
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? 'Su cita ha sido cancelada. Le estoy mandando el mensaje de confirmación. ¿Hay algo más en lo que le pueda ayudar?'
          : "Your appointment has been cancelled. I'm sending the confirmation text now. Is there anything else I can help you with?",
        metadata: buildMetadata(state, { tool: 'cancel_voice_booking', bookingId: result.bookingId, cancelled: true })
      }
    };
  }

  if (state.pendingBookingAction === 'reschedule' && state.pendingBookingActionStatus === 'awaiting_confirmation') {
    if (!input.confirmation) return null;
    const bookingId = state.pendingBookingActionBookingId || state.activeBookingId;
    const selectedOption = state.pendingRescheduleOption;
    if (!bookingId || !selectedOption) {
      logMutationSkipped(input.logContext, 'reschedule_option_required');
      return mutationBlockedResponse(state, spanish, 'reschedule_option_required');
    }
    if (isPendingRescheduleExpired(state, input.input.now || new Date())) {
      state.pendingRescheduleOption = null;
      state.pendingRescheduleOptionId = null;
      state.pendingRescheduleExpiresAt = null;
      state.pendingBookingActionStatus = 'awaiting_new_slot';
      return {
        handled: true,
        state,
        output: {
          responseText: spanish ? 'Esa hora expiró. Puedo buscar otra vez.' : 'That appointment time expired. I can search again.',
          metadata: buildMetadata(state, { blockedReason: 'pending_reschedule_expired' })
        }
      };
    }
    const result = await input.deps.rescheduleVoiceBooking({
      orgId: input.input.orgId,
      callerPhone: input.input.callerPhone,
      bookingId,
      selectedOption,
      confirmationReceived: true,
      ...(input.input.now !== undefined ? { now: input.input.now } : {}),
      observability: observabilityFromTurn(input.input)
    });
    clearPendingBookingAction(state, { clearActiveBooking: false });
    state.activeBookingId = result.bookingId;
    state.activeBookingSummary = {
      bookingId: result.bookingId,
      startTime: result.startTime,
      endTime: result.endTime,
      timezone: result.timezone,
      staffMemberName: result.staffMemberName,
      eventName: result.eventName,
      status: result.status
    };
    state.activeBookingSelectionStatus = 'selected';
    state.completedAwaitingFollowup = true;
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? 'Su cita ha sido cambiada. Le estoy mandando la confirmación actualizada. ¿Hay algo más en lo que le pueda ayudar?'
          : "Your appointment has been rescheduled. I'm sending the updated confirmation text now. Is there anything else I can help you with?",
        metadata: buildMetadata(state, { tool: 'reschedule_voice_booking', bookingId: result.bookingId, rescheduled: true })
      }
    };
  }

  if (
    state.pendingBookingAction === 'reschedule'
    && state.pendingBookingActionStatus === 'awaiting_new_slot'
    && (input.rescheduleRequested || input.refinement || hasPreferenceUpdate(input.preferenceUpdate))
  ) {
    applyPreferenceUpdate(state, input.preferenceUpdate);
    return searchRescheduleOptions(input);
  }

  return null;
}

async function handleBookingMutationIntent(input: {
  action: SofiaPendingBookingAction;
  input: HandleSofiaBookingTurnInput;
  state: BookingIntentState;
  deps: SofiaBookingDeps;
  spanish: boolean;
  logContext: JsonRecord;
  preferenceUpdate: BookingPreferenceUpdate;
}): Promise<SofiaBookingTurnResult> {
  const { action, state, spanish } = input;
  state.intent = 'book_appointment';
  if (hasPreferenceUpdate(input.preferenceUpdate)) applyPreferenceUpdate(state, input.preferenceUpdate);

  const selected = state.activeBookingId && state.activeBookingSummary ? state.activeBookingSummary : null;
  if (selected) {
    if (isTerminalActiveBooking(selected)) {
      return mutationBlockedResponse(state, spanish, 'terminal_booking_not_mutable');
    }
    state.pendingBookingAction = action;
    state.pendingBookingActionBookingId = selected.bookingId;
    state.pendingBookingActionStatus = action === 'cancel' ? 'awaiting_confirmation' : 'awaiting_new_slot';
    if (action === 'cancel') {
      return {
        handled: true,
        state,
        output: {
          responseText: spanish
            ? `Encontré su cita para ${formatBookingSummaryForVoice(selected, true)}. ¿Quiere que la cancele?`
            : `I found your appointment for ${formatBookingSummaryForVoice(selected, false)}. Do you want me to cancel it?`,
          metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings' })
        }
      };
    }
    if (hasPreferenceUpdate(input.preferenceUpdate)) {
      return searchRescheduleOptions(input);
    }
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? `Encontré su cita para ${formatBookingSummaryForVoice(selected, true)}. ¿Para qué día u hora quiere moverla?`
          : `I found your appointment for ${formatBookingSummaryForVoice(selected, false)}. What day or time would you like to move it to?`,
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings' })
      }
    };
  }

  const lookup = await lookupUpcomingForMutation(input);
  if (lookup.bookings.length === 0) {
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

  if (lookup.bookings.length > 1) {
    state.pendingBookingAction = action;
    state.pendingBookingActionStatus = 'awaiting_selection';
    state.pendingBookingActionBookingId = null;
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? `Encontré más de una cita próxima: ${formatMultipleBookingSummaries(state.activeBookingCandidates, true)}. ¿Cuál quiere ${action === 'cancel' ? 'cancelar' : 'cambiar'}?`
          : `I found more than one upcoming appointment: ${formatMultipleBookingSummaries(state.activeBookingCandidates, false)}. Which one do you want to ${action === 'cancel' ? 'cancel' : 'reschedule'}?`,
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: lookup.bookings.length })
      }
    };
  }

  const summary = lookup.bookings[0];
  if (!summary) {
    throw new Error('Expected Sofia active booking summary but none was returned');
  }
  setSelectedActiveBooking(state, summary);
  state.pendingBookingAction = action;
  state.pendingBookingActionBookingId = summary.bookingId;
  state.pendingBookingActionStatus = action === 'cancel' ? 'awaiting_confirmation' : 'awaiting_new_slot';
  if (action === 'cancel') {
    return {
      handled: true,
      state,
      output: {
        responseText: spanish
          ? `Encontré su cita para ${formatBookingSummaryForVoice(summary, true)}. ¿Quiere que la cancele?`
          : `I found your appointment for ${formatBookingSummaryForVoice(summary, false)}. Do you want me to cancel it?`,
        metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: 1 })
      }
    };
  }
  if (hasPreferenceUpdate(input.preferenceUpdate)) {
    return searchRescheduleOptions(input);
  }
  return {
    handled: true,
    state,
    output: {
      responseText: spanish
        ? `Encontré su cita para ${formatBookingSummaryForVoice(summary, true)}. ¿Para qué día u hora quiere moverla?`
        : `I found your appointment for ${formatBookingSummaryForVoice(summary, false)}. What day or time would you like to move it to?`,
      metadata: buildMetadata(state, { tool: 'lookup_upcoming_voice_bookings', upcomingBookingCount: 1 })
    }
  };
}
