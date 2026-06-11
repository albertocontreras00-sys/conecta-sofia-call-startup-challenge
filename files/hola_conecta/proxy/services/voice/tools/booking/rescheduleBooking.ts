import { logError } from '../../../../utils/logger.js';
import { rescheduleVoiceBooking } from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  logBookingBoundary,
  readErrorCode,
  type SofiaBookingVoiceToolContext
} from './common.ts';

export async function handleRescheduleBookingTool(
  context: SofiaBookingVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;

  const bookingId = stringArg(args, 'bookingId');
  const slotId = stringArg(args, 'slotId');
  const confirmationReceived = args.confirmationReceived === true;
  logBookingBoundary(context, 'voice.booking.reschedule.request_shape', 'reschedule_booking', toolCallId, {
    args,
    derived: { bookingId, slotId, confirmationReceived, activeBookingMapSize: context.activeBookingMap.size, bookingSlotMapSize: context.bookingSlotMap.size }
  });
  if (!bookingId) {
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_BOOKING_ID',
      message: 'reschedule_booking requires bookingId from lookup_upcoming_bookings.'
    });
    return;
  }
  if (!slotId) {
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_SLOT_ID',
      message: 'reschedule_booking requires slotId from get_available_slots.'
    });
    return;
  }
  if (!confirmationReceived) {
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      message: 'Do not reschedule the appointment until the caller explicitly confirms the exact replacement slot.'
    });
    return;
  }
  if (!context.activeBookingMap.has(bookingId)) {
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode: 'UNKNOWN_BOOKING_ID',
      message: 'The bookingId is not in the current upcoming appointment list. Call lookup_upcoming_bookings again before rescheduling.'
    });
    return;
  }

  const selectedOption = context.bookingSlotMap.get(slotId);
  if (!selectedOption) {
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode: 'UNKNOWN_SLOT_ID',
      message: 'The selected slotId is not in the current offered slot list. Call get_available_slots again before rescheduling.'
    });
    return;
  }

  try {
    const result = await rescheduleVoiceBooking({
      orgId: activeSession.orgId,
      callerPhone: activeSession.fromPhone,
      bookingId,
      selectedOption,
      confirmationReceived: true,
      observability: {
        callId: activeSession.callId,
        sessionId: activeSession.sessionId,
        dialogId: activeSession.dialogId,
        turnId: activeSession.callId
      }
    });
    logBookingBoundary(context, 'voice.booking.reschedule.backend_response_shape', 'reschedule_booking', toolCallId, {
      result
    });
    context.bookingSlotMap.clear();
    context.activeBookingMap.set(result.bookingId, result);
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: true,
      bookingId: result.bookingId,
      status: result.status,
      startTime: result.startTime,
      endTime: result.endTime,
      timezone: result.timezone,
      staffMemberName: result.staffMemberName,
      eventName: result.eventName,
      smsQueued: result.smsQueued ?? false,
      smsStatus: result.smsStatus ?? null
    });
  } catch (error) {
    const errorCode = readErrorCode(error, 'RESCHEDULE_BOOKING_FAILED');
    logError(context.logContext, 'voice.gemini.reschedule_booking_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId,
      errorCode
    });
    context.sendGeminiToolResponse('reschedule_booking', toolCallId, {
      ok: false,
      errorCode,
      message: 'Sofia could not reschedule that appointment. Apologize briefly and offer another slot or a human follow-up.'
    });
  }
}
