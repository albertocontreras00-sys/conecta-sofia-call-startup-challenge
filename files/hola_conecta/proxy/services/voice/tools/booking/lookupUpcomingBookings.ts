import { logError } from '../../../../utils/logger.js';
import { lookupUpcomingVoiceBookings } from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import { integerArg } from '../../sofiaVoiceToolArgs.ts';
import {
  logBookingBoundary,
  type SofiaBookingVoiceToolContext
} from './common.ts';

export async function handleLookupUpcomingBookingsTool(
  context: SofiaBookingVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;

  if (context.callerIdentity?.identityStatus === 'ambiguous_phone_match') {
    context.sendGeminiToolResponse('lookup_upcoming_bookings', toolCallId, {
      ok: false,
      errorCode: 'AMBIGUOUS_PHONE_MATCH',
      message: 'The caller phone matches multiple contacts. Ask a brief disambiguation question before revealing appointment details.'
    });
    return;
  }

  const limit = Math.min(Math.max(integerArg(args, 'limit') || 3, 1), 5);
  logBookingBoundary(context, 'voice.booking.lookup_upcoming.request_shape', 'lookup_upcoming_bookings', toolCallId, {
    args,
    derived: { limit, identityStatus: context.callerIdentity?.identityStatus || null }
  });
  try {
    const bookings = await lookupUpcomingVoiceBookings({
      orgId: activeSession.orgId,
      callerPhone: activeSession.fromPhone,
      limit
    });
    context.activeBookingMap.clear();
    logBookingBoundary(context, 'voice.booking.lookup_upcoming.backend_response_shape', 'lookup_upcoming_bookings', toolCallId, {
      bookings,
      bookingCount: bookings.length
    });
    for (const booking of bookings) context.activeBookingMap.set(booking.bookingId, booking);
    context.sendGeminiToolResponse('lookup_upcoming_bookings', toolCallId, {
      ok: true,
      identityStatus: context.callerIdentity?.identityStatus || null,
      phoneMatchedSingleContact: context.callerIdentity?.identityStatus === 'contact_matched' || context.callerIdentity?.identityStatus === 'pin_verified',
      bookings: bookings.map((booking) => ({
        bookingId: booking.bookingId,
        startTime: booking.startTime,
        endTime: booking.endTime,
        timezone: booking.timezone,
        staffMemberName: booking.staffMemberName,
        eventName: booking.eventName,
        status: booking.status
      })),
      message: bookings.length
        ? 'Speak the appointment time directly. Do not ask whether the caller still wants you to check.'
        : 'No upcoming appointment was found for this caller phone. Offer to help book one.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.lookup_upcoming_bookings_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId
    });
    context.sendGeminiToolResponse('lookup_upcoming_bookings', toolCallId, {
      ok: false,
      errorCode: 'LOOKUP_UPCOMING_BOOKINGS_FAILED',
      message: 'Sofia could not look up upcoming appointments right now. Apologize briefly and offer a human follow-up.'
    });
  }
}
