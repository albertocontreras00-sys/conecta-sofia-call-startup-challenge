import { logError } from '../../../../utils/logger.js';
import { createSofiaVoiceBooking } from '../../../../sofia/services/sofiaVoiceBookingService.ts';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  logBookingBoundary,
  readErrorCode,
  type SofiaBookingVoiceToolContext
} from './common.ts';

export async function handleCreateBookingTool(
  context: SofiaBookingVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const activeSession = context.session;
  if (!activeSession) return;

  const slotId = stringArg(args, 'slotId');
  const confirmationReceived = args.confirmationReceived === true;
  logBookingBoundary(context, 'voice.booking.create.request_shape', 'create_booking', toolCallId, {
    args,
    derived: { slotId, confirmationReceived, bookingSlotMapSize: context.bookingSlotMap.size }
  });
  if (!slotId) {
    context.sendGeminiToolResponse('create_booking', toolCallId, {
      ok: false,
      errorCode: 'MISSING_REQUIRED_SLOT_ID',
      message: 'create_booking requires slotId from get_available_slots.'
    });
    return;
  }
  if (!confirmationReceived) {
    context.sendGeminiToolResponse('create_booking', toolCallId, {
      ok: false,
      errorCode: 'CONFIRMATION_REQUIRED',
      message: 'Do not create the appointment until the caller explicitly confirms the exact offered slot.'
    });
    return;
  }

  const selectedOption = context.bookingSlotMap.get(slotId);
  if (!selectedOption) {
    context.sendGeminiToolResponse('create_booking', toolCallId, {
      ok: false,
      errorCode: 'UNKNOWN_SLOT_ID',
      message: 'The selected slotId is not in the current offered slot list. Call get_available_slots again before booking.'
    });
    return;
  }

  try {
    const writeSofiaVoiceBooking = context.deps?.createSofiaVoiceBooking ?? createSofiaVoiceBooking;
    const result = await writeSofiaVoiceBooking({
      orgId: activeSession.orgId,
      callerPhone: activeSession.fromPhone,
      smsPhoneOverride: stringArg(args, 'smsPhoneOverride'),
      selectedOption,
      confirmationReceived: true,
      observability: {
        callId: activeSession.callId,
        sessionId: activeSession.sessionId,
        dialogId: activeSession.dialogId,
        turnId: activeSession.callId
      }
    });
    logBookingBoundary(context, 'voice.booking.create.backend_response_shape', 'create_booking', toolCallId, {
      result
    });
    context.bookingSlotMap.clear();
    context.sendGeminiToolResponse('create_booking', toolCallId, {
      ok: true,
      bookingId: result.bookingId,
      startTime: result.startTime,
      timezone: result.timezone,
      staffMemberName: result.staffMemberName,
      smsQueued: result.smsQueued ?? false,
      smsSent: result.smsSent,
      smsStatus: result.smsStatus
    });
  } catch (error) {
    const errorCode = readErrorCode(error, 'CREATE_BOOKING_FAILED');
    logError(context.logContext, 'voice.gemini.create_booking_failed', error, {
      sessionId: activeSession.sessionId,
      callId: activeSession.callId,
      orgId: activeSession.orgId,
      errorCode
    });
    context.sendGeminiToolResponse('create_booking', toolCallId, {
      ok: false,
      errorCode,
      message: 'Sofia could not create that appointment. Apologize briefly and offer another slot or a human follow-up.'
    });
  }
}
