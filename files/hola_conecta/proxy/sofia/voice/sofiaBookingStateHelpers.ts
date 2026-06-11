import type {
  BookingIntentState,
  JsonRecord,
  SofiaActiveBookingSummary,
  SofiaVoiceBookingOption,
  VoiceTurnOutput
} from '../../services/voice/voiceSessionTypes.ts';
import { hasStructuredPreference } from './sofiaBookingPreferences.ts';
import { formatSlotForLookup } from './sofiaBookingFormatters.ts';
import { logMutationSkipped } from './sofiaBookingRuntimeLogging.ts';

type SofiaBookingTurnResult = {
  handled: boolean;
  state: BookingIntentState;
  output: VoiceTurnOutput | null;
};

type TurnIdentityInput = {
  callId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  dialogId?: string | null;
};

type UpcomingVoiceBooking = {
  bookingId: string;
  startTime: string;
  endTime: string | null;
  timezone: string;
  staffMemberName: string | null;
  eventName: string | null;
  status?: string | null;
};

type OptionsResultForNoMatch = {
  options: Array<{ displayText: string }>;
};

export function validRequiredValue(value: string | null | undefined): boolean {
  const normalized = String(value ?? '').trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (['undefined', 'null', 'default', '888', '444', '333', '222', '111-222-3333'].includes(lower)) return false;
  if (lower.startsWith('$context.variables.')) return false;
  return true;
}

export function validateTrustedBookingContext(input: {
  orgId: string;
  sessionId?: string | null;
  callId?: string | null;
  turnId?: string | null;
}): string | null {
  if (!validRequiredValue(input.orgId)) return 'missing_org_id';
  if (!validRequiredValue(input.sessionId)) return 'missing_session_id';
  if (!validRequiredValue(input.callId)) return 'missing_call_id';
  if (!validRequiredValue(input.turnId)) return 'missing_turn_id';
  return null;
}

export function validateReadyToConfirmSelectedOption(input: {
  state: BookingIntentState;
  input: { now?: Date };
  contextValidationReason: string | null;
  logContext: JsonRecord;
  spanish: boolean;
}): SofiaBookingTurnResult | null {
  const { state, contextValidationReason, logContext, spanish } = input;
  if (contextValidationReason) {
    const blockedReason = contextValidationReason;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    logMutationSkipped(logContext, blockedReason);
    return {
      handled: true,
      state,
      output: {
        responseText: spanish ? 'Tengo problemas para verificar esta llamada, así que no puedo reservar esa cita por teléfono.' : 'I am having trouble verifying this call, so I cannot book that appointment by phone.',
        handoff: true,
        metadata: buildMetadata(state, { blockedReason })
      }
    };
  }
  if (isPendingBookingExpired(state, input.input.now || new Date())) {
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    logMutationSkipped(logContext, 'pending_state_expired');
    return {
      handled: true,
      state,
      output: {
        responseText: spanish ? 'Esa cita reservada expiró. Puedo buscar otra vez la cita más pronto disponible.' : 'That appointment hold expired. I can find the soonest available appointment again.',
        metadata: buildMetadata(state, { blockedReason: 'pending_state_expired' })
      }
    };
  }
  if (state.selectedOption && !isCurrentlyOfferedOption(state.selectedOption, state.offeredOptions)) {
    state.selectedOption = null;
    state.selectedOptionId = null;
    state.pendingExpiresAt = null;
    state.confirmationStatus = 'not_ready';
    state.smsDestinationStatus = 'not_requested';
    state.smsPhoneOverride = null;
    logMutationSkipped(logContext, 'selected_option_not_currently_offered');
    return {
      handled: true,
      state,
      output: {
        responseText: spanish ? 'Necesito buscar esa hora otra vez antes de poder reservarla.' : 'I need to find that appointment time again before I can book it.',
        metadata: buildMetadata(state)
      }
    };
  }
  return null;
}

export function bookingOptionId(option: SofiaVoiceBookingOption): string {
  return [
    option.staffMemberId,
    option.eventId,
    option.startTime,
    option.endTime,
    option.timezone,
    option.durationMinutes
  ].join('|');
}

export function pendingBookingExpiresAt(now: Date): string {
  return new Date(now.getTime() + 10 * 60 * 1000).toISOString();
}

export function isPendingBookingExpired(state: BookingIntentState, now: Date): boolean {
  if (!state.pendingExpiresAt) return true;
  const expiresAt = Date.parse(state.pendingExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as { code?: unknown; status?: unknown; statusCode?: unknown }).code
    || (error as { status?: unknown }).status
    || (error as { statusCode?: unknown }).statusCode;
  return candidate === undefined || candidate === null ? null : String(candidate);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeBookingStateForMetadata(state: BookingIntentState): JsonRecord {
  return {
    intent: state.intent,
    offeredOptionCount: state.offeredOptions.length,
    selectedOptionPresent: Boolean(state.selectedOption),
    rejectionCount: state.rejectionCount,
    preferredDate: state.preferredDate,
    preferredTime: state.preferredTime,
    preferredTimeRelation: state.preferredTimeRelation,
    preferredTimeWindow: state.preferredTimeWindow,
    preferredEventId: state.preferredEventId,
    preferredEventName: state.preferredEventName,
    pendingEventSelection: state.pendingEventSelection,
    eventSelectionOptionCount: state.eventSelectionOptions.length,
    hasCallerPhone: Boolean(state.callerPhone),
    confirmationStatus: state.confirmationStatus,
    bookingId: state.bookingId,
    activeBookingId: state.activeBookingId,
    activeBookingSummaryPresent: Boolean(state.activeBookingSummary),
    activeBookingCandidateCount: state.activeBookingCandidates.length,
    activeBookingSelectionStatus: state.activeBookingSelectionStatus,
    pendingBookingAction: state.pendingBookingAction,
    pendingBookingActionStatus: state.pendingBookingActionStatus,
    pendingBookingActionBookingId: state.pendingBookingActionBookingId,
    pendingRescheduleOptionPresent: Boolean(state.pendingRescheduleOption),
    pendingRescheduleExpiresAt: state.pendingRescheduleExpiresAt,
    pendingExpiresAt: state.pendingExpiresAt,
    smsDestinationStatus: state.smsDestinationStatus,
    smsPhoneOverridePresent: Boolean(state.smsPhoneOverride),
    completedAwaitingFollowup: state.completedAwaitingFollowup
  };
}

export function buildMetadata(state: BookingIntentState, extra: JsonRecord = {}): JsonRecord {
  return {
    bookingState: serializeBookingStateForMetadata(state),
    ...extra
  };
}

export function clearNewBookingSelection(state: BookingIntentState): void {
  state.offeredOptions = [];
  state.selectedOption = null;
  state.selectedOptionId = null;
  state.pendingExpiresAt = null;
  state.confirmationStatus = 'not_ready';
  state.smsDestinationStatus = 'not_requested';
  state.smsPhoneOverride = null;
}

export function clearPendingBookingAction(state: BookingIntentState, input: { clearActiveBooking: boolean }): void {
  state.pendingBookingAction = null;
  state.pendingBookingActionStatus = null;
  state.pendingBookingActionBookingId = null;
  state.pendingRescheduleOption = null;
  state.pendingRescheduleOptionId = null;
  state.pendingRescheduleExpiresAt = null;
  if (input.clearActiveBooking) {
    state.activeBookingId = null;
    state.activeBookingSummary = null;
    state.activeBookingCandidates = [];
    state.activeBookingSelectionStatus = 'none';
  }
}

export function setSelectedActiveBooking(state: BookingIntentState, summary: SofiaActiveBookingSummary): void {
  state.activeBookingId = summary.bookingId;
  state.activeBookingSummary = summary;
  state.activeBookingSelectionStatus = 'selected';
  if (!state.activeBookingCandidates.some((candidate) => candidate.bookingId === summary.bookingId)) {
    state.activeBookingCandidates = [summary];
  }
  clearNewBookingSelection(state);
}

export function isPendingRescheduleExpired(state: BookingIntentState, now: Date): boolean {
  if (!state.pendingRescheduleExpiresAt) return true;
  const expiresAt = Date.parse(state.pendingRescheduleExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function isTerminalActiveBooking(summary: SofiaActiveBookingSummary): boolean {
  return ['cancelled', 'completed', 'no_show', 'expired'].includes(String(summary.status || '').toLowerCase());
}

export function mutationBlockedResponse(
  state: BookingIntentState,
  spanish: boolean,
  blockedReason: string
): SofiaBookingTurnResult {
  return {
    handled: true,
    state,
    output: {
      responseText: spanish
        ? 'Necesito confirmar qué cita quiere cambiar antes de hacer eso.'
        : 'I need to confirm which appointment you mean before I can do that.',
      metadata: buildMetadata(state, { blockedReason })
    }
  };
}

export function observabilityFromTurn(input: TurnIdentityInput): TurnIdentityInput {
  return {
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.dialogId !== undefined ? { dialogId: input.dialogId } : {})
  };
}

export function resolveActiveBookingSelection(
  transcript: string,
  candidates: SofiaActiveBookingSummary[]
): SofiaActiveBookingSummary | null {
  const lower = transcript.toLowerCase();
  const ordinal = parseSelectionOrdinal(lower);
  if (ordinal !== null) return candidates[ordinal] ?? null;
  const weekday = [
    { en: 'sunday', es: 'domingo' },
    { en: 'monday', es: 'lunes' },
    { en: 'tuesday', es: 'martes' },
    { en: 'wednesday', es: 'mi[eé]rcoles' },
    { en: 'thursday', es: 'jueves' },
    { en: 'friday', es: 'viernes' },
    { en: 'saturday', es: 's[aá]bado' }
  ]
    .find((day) => new RegExp(`\\b(${day.en}|${day.es})\\b`, 'i').test(lower))?.en || null;
  if (weekday) {
    const matches = candidates.filter((candidate) =>
      formatSlotForLookup(candidate.startTime, candidate.timezone).toLowerCase().includes(weekday)
    );
    const match = matches[0];
    return matches.length === 1 && match ? match : null;
  }
  return null;
}

export function buildNoMatchingPreferenceResponse(input: {
  spanish: boolean;
  state: BookingIntentState;
  optionsResult: OptionsResultForNoMatch;
}): string {
  const { spanish, state, optionsResult } = input;
  if (!hasStructuredPreference(state)) {
    return spanish
      ? 'No estoy encontrando una cita disponible en este momento. Puedo pedirle a alguien de la oficina que le dé seguimiento.'
      : 'I am not finding an open appointment time right now. I can have someone from the office follow up.';
  }
  const requested = describePreference(state, spanish);
  const alternative = optionsResult.options[0]?.displayText;
  if (alternative) {
    return spanish
      ? `No veo nada ${requested}. Sí tengo ${alternative}. ¿Le funciona esa hora?`
      : `I am not seeing anything ${requested}. I do have ${alternative}. Would that work?`;
  }
  return spanish
    ? `No veo nada ${requested}. Puedo revisar otro día.`
    : `I am not seeing anything ${requested}. I can check another day.`;
}

export function toActiveBookingSummary(input: UpcomingVoiceBooking): SofiaActiveBookingSummary {
  return {
    bookingId: input.bookingId,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
    staffMemberName: input.staffMemberName,
    eventName: input.eventName,
    status: input.status || null
  };
}

export function isCurrentlyOfferedOption(selected: SofiaVoiceBookingOption, offered: SofiaVoiceBookingOption[]): boolean {
  return offered.some((option) =>
    option.optionToken === selected.optionToken
    && option.staffMemberId === selected.staffMemberId
    && option.eventId === selected.eventId
    && option.startTime === selected.startTime
    && option.endTime === selected.endTime
    && option.timezone === selected.timezone
    && option.durationMinutes === selected.durationMinutes
  );
}

function parseSelectionOrdinal(lower: string): number | null {
  if (/\b(first|1st|number one|primera|primero)\b/.test(lower)) return 0;
  if (/\b(second|2nd|number two|segunda|segundo)\b/.test(lower)) return 1;
  if (/\b(third|3rd|number three|tercera|tercero)\b/.test(lower)) return 2;
  return null;
}

function describePreference(state: BookingIntentState, spanish: boolean): string {
  const date = state.preferredDate || 'that day';
  if (state.preferredTimeRelation === 'at_or_after' && state.preferredTime) {
    return spanish ? `después de ${formatPreferenceTime(state.preferredTime)}` : `after ${formatPreferenceTime(state.preferredTime)} on ${date}`;
  }
  if (state.preferredTimeRelation === 'at_or_before' && state.preferredTime) {
    return spanish ? `antes de ${formatPreferenceTime(state.preferredTime)}` : `before ${formatPreferenceTime(state.preferredTime)} on ${date}`;
  }
  if (state.preferredTimeWindow) {
    return spanish ? `en ${state.preferredTimeWindow}` : `in the ${state.preferredTimeWindow} on ${date}`;
  }
  return spanish ? 'para esa hora' : `for ${date}`;
}

function formatPreferenceTime(value: string): string {
  const [hourPart, minutePart] = value.split(':');
  const hour = Number(hourPart);
  const minute = minutePart || '00';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return minute === '00' ? `${hour12} ${suffix}` : `${hour12}:${minute} ${suffix}`;
}
