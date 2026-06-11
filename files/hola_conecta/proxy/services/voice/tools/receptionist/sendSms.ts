import { logError } from '../../../../utils/logger.js';
import { sendSmsNotification } from '../../../notifications/notificationHub.js';
import { stringArg } from '../../sofiaVoiceToolArgs.ts';
import {
  blockResponse,
  logReceptionistBoundary,
  requireSessionAndContact,
  type SofiaReceptionistVoiceToolContext
} from './common.ts';

type SmsPurpose = 'map_link' | 'directions' | 'business_info' | 'callback' | 'other';

function smsPurpose(value: string | null): SmsPurpose {
  switch (value) {
    case 'map_link':
    case 'directions':
    case 'business_info':
    case 'callback':
    case 'other':
      return value;
    default:
      return 'other';
  }
}

export async function handleSendSmsTool(
  context: SofiaReceptionistVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'send_sms';
  const body = stringArg(args, 'body');
  const explicitToPhone = stringArg(args, 'toPhone');
  const purpose = smsPurpose(stringArg(args, 'purpose'));
  const confirmationReceived = args.confirmationReceived === true;
  logReceptionistBoundary(context, 'voice.messaging.sms.request_shape', toolName, toolCallId, {
    args: {
      ...args,
      bodyPresent: Boolean(body),
      bodyLength: body?.length || 0,
      toPhonePresent: Boolean(explicitToPhone),
      confirmationReceived,
      purpose
    },
    identity: context.callerIdentity
  });

  const contactContext = requireSessionAndContact(context, toolName, toolCallId);
  if (!contactContext) return;
  const { session, contactId } = contactContext;

  if (!confirmationReceived) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('CONFIRMATION_REQUIRED', 'Ask the caller for explicit permission before sending the SMS.'));
    return;
  }
  if (!body) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('SMS_BODY_REQUIRED', 'The SMS body is required. Do not send an empty text.'));
    return;
  }

  const destinationPhone = explicitToPhone || session.fromPhone;
  if (!destinationPhone || destinationPhone === 'unknown') {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('DESTINATION_PHONE_REQUIRED', 'No destination phone number is available. Ask for the phone number or offer human follow-up.'));
    return;
  }

  try {
    const result = await sendSmsNotification({
      orgId: session.orgId,
      toPhone: destinationPhone,
      toContactId: contactId,
      body,
      category: 'SYSTEM',
      source: 'SYSTEM',
      metadata: {
        action: 'sofia_voice_send_sms',
        toolName,
        purpose,
        sessionId: session.sessionId,
        callId: session.callId,
        contactId,
        destinationSource: explicitToPhone ? 'caller_provided_toPhone' : 'voice_session_fromPhone'
      }
    });

    logReceptionistBoundary(context, 'voice.messaging.sms.response_shape', toolName, toolCallId, {
      result,
      contactId,
      destinationPhonePresent: true,
      destinationSource: explicitToPhone ? 'caller_provided_toPhone' : 'voice_session_fromPhone',
      purpose
    });

    if (result.status !== 'sent') {
      context.sendGeminiToolResponse(toolName, toolCallId, {
        ok: false,
        errorCode: 'SMS_NOT_SENT',
        status: result.status,
        reason: result.reason || null,
        error: result.error || null,
        message: 'The SMS was not sent. Do not claim it was sent; apologize briefly and offer human follow-up.'
      });
      return;
    }

    context.sendGeminiToolResponse(toolName, toolCallId, {
      ok: true,
      status: result.status,
      messageId: result.messageId || null,
      contactId,
      destinationPhonePresent: true,
      purpose,
      message: 'SMS sent. Sofia may tell the caller the text was sent.'
    });
  } catch (error) {
    logError(context.logContext, 'voice.gemini.send_sms_failed', error, {
      orgId: session.orgId,
      sessionId: session.sessionId,
      callId: session.callId,
      contactId,
      purpose
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('SEND_SMS_FAILED', 'The SMS failed. Do not claim it was sent; apologize briefly and offer human follow-up.'));
  }
}
