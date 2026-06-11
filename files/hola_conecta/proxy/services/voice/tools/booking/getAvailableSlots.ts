import { logError } from '../../../../utils/logger.js';
import { getSofiaBookingOptions } from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import {
  integerArg,
  isDateKey,
  stringArg,
  validPreferredTime,
  validPreferredTimeRelation,
  validPreferredTimeWindow
} from '../../sofiaVoiceToolArgs.ts';
import {
  logBookingBoundary,
  type SofiaBookingVoiceToolContext
} from './common.ts';

export async function handleGetAvailableSlotsTool(
  context: SofiaBookingVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;

  const searchMode = stringArg(args, 'searchMode');
  const date = stringArg(args, 'date');
  const startDate = stringArg(args, 'startDate');
  const endDate = stringArg(args, 'endDate');
  const preferredDate = searchMode === 'specific_date'
    ? date
    : searchMode === 'date_range'
      ? startDate
      : null;
  const preferredTime = validPreferredTime(stringArg(args, 'preferredTime'));
  const preferredTimeRelation = validPreferredTimeRelation(stringArg(args, 'preferredTimeRelation'));
  const preferredTimeWindow = validPreferredTimeWindow(stringArg(args, 'timeWindow'));
  const selectedEventId = stringArg(args, 'selectedEventId');
  const horizonDays = integerArg(args, 'horizonDays');
  const excludeBookingId = stringArg(args, 'excludeBookingId');
  const limit = 3;
  logBookingBoundary(context, 'voice.booking.get_available_slots.request_shape', 'get_available_slots', toolCallId, {
    args,
    derived: { searchMode, date, startDate, endDate, preferredDate, preferredTime, preferredTimeRelation, preferredTimeWindow, selectedEventId, horizonDays, excludeBookingId, limit }
  });

  if (searchMode === 'specific_date' && !isDateKey(date)) {
    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_DATE',
      message: 'specific_date availability search requires date in YYYY-MM-DD format.'
    });
    return;
  }
  if (searchMode === 'date_range' && !isDateKey(startDate)) {
    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_START_DATE',
      message: 'date_range availability search requires startDate in YYYY-MM-DD format.'
    });
    return;
  }
  if (searchMode === 'date_range' && endDate && !isDateKey(endDate)) {
    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: false,
      errorCode: 'INVALID_END_DATE',
      message: 'date_range availability search endDate must be in YYYY-MM-DD format when provided.'
    });
    return;
  }
  if (searchMode !== 'specific_date' && searchMode !== 'date_range' && searchMode !== 'earliest_available') {
    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: false,
      errorCode: 'INVALID_SEARCH_MODE',
      message: 'searchMode must be specific_date, date_range, or earliest_available.'
    });
    return;
  }

  try {
    const readSofiaBookingOptions = context.deps?.getSofiaBookingOptions ?? getSofiaBookingOptions;
    const result = await readSofiaBookingOptions({
      orgId: activeSession.orgId,
      callerPhone: activeSession.fromPhone,
      preferredDate: isDateKey(preferredDate) ? preferredDate : null,
      preferredTime,
      preferredTimeRelation,
      preferredTimeWindow,
      preferredEventId: selectedEventId,
      preferredEndDate: searchMode === 'date_range' && isDateKey(endDate) ? endDate : null,
      horizonDays: searchMode === 'earliest_available' && horizonDays ? horizonDays : null,
      limit,
      excludeBookingId,
      observability: {
        callId: activeSession.callId,
        sessionId: activeSession.sessionId,
        dialogId: activeSession.dialogId,
        turnId: activeSession.callId
      }
    });
    logBookingBoundary(context, 'voice.booking.get_available_slots.backend_response_shape', 'get_available_slots', toolCallId, {
      result,
      existingSlotMapSize: context.bookingSlotMap.size
    });
    context.bookingSlotMap.clear();

    if (result.eventSelectionRequired && (result.availableEvents?.length || 0) > 1) {
      context.sendGeminiToolResponse('get_available_slots', toolCallId, {
        ok: true,
        searchMode,
        eventSelectionRequired: true,
        availableEvents: result.availableEvents,
        slots: [],
        missingRequirements: [],
        message: result.eventSelectionPrompt || 'Ask the caller which option they would like. Do not say there is no availability. After the caller chooses, call get_available_slots again with selectedEventId from availableEvents.'
      });
      return;
    }

    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: true,
      searchMode,
      eventSelectionRequired: false,
      availableEvents: result.availableEvents || [],
      preferenceMatched: result.preferenceMatched ?? true,
      slots: result.options.map((option, index) => {
        const slotId = `slot_${index + 1}`;
        context.bookingSlotMap.set(slotId, option);
        return {
          slotId,
          startTime: option.startTime,
          endTime: option.endTime,
          timezone: option.timezone,
          displayText: option.displayText,
          staffMemberName: option.staffMemberName,
          eventName: option.eventName
        };
      }),
      missingRequirements: result.missingRequirements,
      staffDisambiguation: result.staffDisambiguation || null
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.get_available_slots_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId
    });
    context.sendGeminiToolResponse('get_available_slots', toolCallId, {
      ok: false,
      errorCode: 'GET_AVAILABLE_SLOTS_FAILED',
      message: 'Sofia could not read appointment availability right now. Apologize briefly and offer to take a message.'
    });
  }
}
