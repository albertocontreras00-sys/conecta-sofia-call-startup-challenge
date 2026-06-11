import { logError } from '../../../../utils/logger.js';
import { cancelVoiceBooking } from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  logBookingBoundary,
  readErrorCode,
  type SofiaBookingVoiceToolContext
} from './common.ts';

export async function handleCancelBookingTool(
  context: SofiaBookingVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;

  const bookingId = stringArg(args, 'bookingId');
  const confirmationReceived = args.confirmationReceived === true;
  logBookingBoundary(context, 'voice.booking.cancel.request_shape', 'cancel_booking', toolCallId, {
    args,
    derived: { bookingId, confirmationReceived, activeBookingMapSize: context.activeBookingMap.size }
  });
  if (!bookingId) {
    context.sendGeminiToolResponse('cancel_booking', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_BOOKING_ID',
      message: 'cancel_booking requires bookingId from lookup_upcoming_bookings.'
    });
    return;
  }
  if (!confirmationReceived) {
    context.sendGeminiToolResponse('cancel_booking', toolCallId, {
      ok: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      message: 'Do not cancel the appointment until the caller explicitly confirms cancelling the exact appointment.'
    });
    return;
  }
  if (!context.activeBookingMap.has(bookingId)) {
    context.sendGeminiToolResponse('cancel_booking', toolCallId, {
      ok: false,
      errorCode: 'UNKNOWN_BOOKING_ID',
      message: 'The bookingId is not in the current upcoming appointment list. Call lookup_upcoming_bookings again before cancelling.'
    });
    return;
  }

  try {
    const result = await cancelVoiceBooking({
      orgId: activeSession.orgId,
      callerPhone: activeSession.fromPhone,
      bookingId,
      reason: stringArg(args, 'reason'),
      observability: {
        callId: activeSession.callId,
        sessionId: activeSession.sessionId,
        dialogId: activeSession.dialogId,
        turnId: activeSession.callId
      }
    });
    logBookingBoundary(context, 'voice.booking.cancel.backend_response_shape', 'cancel_booking', toolCallId, {
      result
    });
    context.activeBookingMap.delete(bookingId);
    context.sendGeminiToolResponse('cancel_booking', toolCallId, {
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
    const errorCode = readErrorCode(error, 'CANCEL_BOOKING_FAILED');
    logError(context.logContext, 'voice.gemini.cancel_booking_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId,
      errorCode
    });
    context.sendGeminiToolResponse('cancel_booking', toolCallId, {
      ok: false,
      errorCode,
      message: 'Sofia could not cancel that appointment. Apologize briefly and offer a human follow-up.'
    });
  }
}
