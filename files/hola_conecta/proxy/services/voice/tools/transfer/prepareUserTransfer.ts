import { logError } from '../../../../utils/logger.js';
import {
  findPhoneCallLogByProviderCallId
} from '../../../../models/phoneOutboundCallLogModel.ts';
import {
  prepareSofiaUserTransfer,
} from '../../../phone/phoneUserExtensionsService.ts';
import { PhoneUserExtensionValidationError } from '../../../../types/phoneUserExtensionTypes.ts';
import type { GeminiDomain } from '../../infobipMediaWebSocketGeminiTypes.ts';
import { stringArg, type GeminiToolResponseBody } from '../../sofiaVoiceToolArgs.ts';
import type { VoiceSession } from '../../voiceSessionTypes.ts';
import type { SendGeminiToolResponse } from '../booking/common.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
  sanitizePhoneJson,
} from '../../../phone/phoneJsonContract.ts';
import { recordSofiaVoiceLiveDebugEvent } from '../../sofiaVoiceLiveDebugStore.ts';

export type SofiaUserTransferVoiceToolContext = {
  activeGeminiDomain: GeminiDomain;
  logContext: string;
  sendGeminiToolResponse: SendGeminiToolResponse;
  session: VoiceSession | null;
};

function blockResponse(errorCode: string, message: string): GeminiToolResponseBody {
  return { ok: false, errorCode, message };
}

export async function handlePrepareUserTransferTool(
  context: SofiaUserTransferVoiceToolContext,
  args: Record<string, unknown>,
  toolCallId: string | null
): Promise<void> {
  const toolName = 'prepare_user_transfer';
  const session = context.session;
  if (!session) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('VOICE_SESSION_REQUIRED', 'One moment, I can take a message.'));
    return;
  }

  const requestedName = stringArg(args, 'requestedName');
  const extension = stringArg(args, 'extension');
  const callerPhrase = stringArg(args, 'callerPhrase');
  recordSofiaVoiceLiveDebugEvent({
    event: 'transfer_requested',
    callId: session.callId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    metadata: {
      toolCallId,
      requestedName,
      extension,
      callerPhrasePresent: Boolean(callerPhrase)
    }
  });
  if (!requestedName && !extension) {
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse('TRANSFER_TARGET_REQUIRED', 'Who would you like me to try to connect you to?'));
    return;
  }

  try {
    logPhoneJsonEvent('voice.json.gemini.prepare_user_transfer.tool_call.received', buildPhoneJsonEnvelope({
      eventType: 'gemini.prepare_user_transfer.tool_call.received',
      orgId: session.orgId,
      call: {
        provider_call_id: session.callId,
        dialog_id: session.sessionId,
        direction: 'inbound',
        status: 'answered',
      },
      actor: { type: 'sofia' },
      routing: {
        requested_name: requestedName,
        requested_extension: extension,
      },
      source: {
        sender: 'gemini_live',
        converter: 'transfer/prepareUserTransfer.handlePrepareUserTransferTool',
        receiver: 'phoneUserExtensionsService.prepareSofiaUserTransfer',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal',
      },
      metadata: {
        toolCallId,
        args_json: sanitizePhoneJson(args),
        caller_phrase_present: Boolean(callerPhrase),
      },
    }));
    const callLog = await findPhoneCallLogByProviderCallId(session.orgId, session.callId);
    const result = await prepareSofiaUserTransfer({
      orgId: session.orgId,
      callLogId: callLog?.id || null,
      fromUserId: null,
      requestedName,
	      extension,
	      callerPhrase,
	      voiceResponseLanguage: session.languageState.responseLanguage,
	      parentCallId: session.callId,
	      dialogId: session.dialogId,
	      sofiaChildCallId: session.mediaCallId,
	      callerNumber: session.fromPhone,
	      sourceRoutePhone: session.toPhone,
	      sourceRouteId: session.routeId,
		    });
    recordSofiaVoiceLiveDebugEvent({
      event: result.transferIntent ? 'transfer_target_resolved' : 'transfer_failed',
      callId: session.callId,
      sessionId: session.sessionId,
      orgId: session.orgId,
      metadata: {
        toolCallId,
        requestedName,
        extension,
        matchStatus: result.matchStatus,
        transferIntentId: result.transferIntent?.id || null,
        transferTargetUserId: result.transferIntent?.target_user_id || null,
        transferTargetName: result.matches[0]?.display_name || result.matches[0]?.user_name || null,
        transferTargetExtension: result.transferIntent?.target_extension || null,
        providerTransferStarted: result.providerTransferStarted,
        browserRingStarted: result.browserRingStarted,
        providerTransferStatus: result.providerTransferStatus,
        message: result.message
      }
    });
    if (result.providerTransferStarted) {
      recordSofiaVoiceLiveDebugEvent({
        event: 'transfer_call_control_request_sent',
        callId: session.callId,
        sessionId: session.sessionId,
        orgId: session.orgId,
        metadata: {
          toolCallId,
          transferIntentId: result.transferIntent?.id || null,
          transferTargetUserId: result.transferIntent?.target_user_id || null,
          providerTransferStatus: result.providerTransferStatus
        }
      });
    }
    const responseBody = {
      ok: true,
      matchStatus: result.matchStatus,
      matches: result.matches.map((match) => ({
        userId: match.user_id,
        extension: match.extension,
        displayName: match.display_name || match.user_name || null,
        transferLabel: match.transfer_label
      })),
      transferIntentId: result.transferIntent?.id || null,
      targetUserId: result.transferIntent?.target_user_id || null,
      targetExtension: result.transferIntent?.target_extension || null,
      actualTransferStarted: result.providerTransferStarted,
	      browserRingStarted: result.browserRingStarted,
	      providerTransferStatus: result.providerTransferStatus,
	      transferState: result.providerTransferStatus || (result.providerTransferStarted ? 'submitted' : 'not_started'),
	      callerShouldWait: Boolean(result.transferIntent),
	      voicemailIfNoAnswer: false,
	      nextAction: result.transferIntent ? 'tell_caller_transfer_pending_and_wait_for_answer' : 'continue_clarifying_transfer_target',
	      message: result.transferIntent
	        ? result.message
	        : result.message
	    };
    logPhoneJsonEvent('voice.json.gemini.prepare_user_transfer.tool_response.sent', buildPhoneJsonEnvelope({
      eventType: 'gemini.prepare_user_transfer.tool_response.sent',
      orgId: session.orgId,
      call: {
        phone_call_log_id: callLog?.id || null,
        provider_call_id: session.callId,
        dialog_id: session.sessionId,
        direction: 'inbound',
        status: result.transferIntent ? 'submitted' : 'answered',
      },
      actor: { type: 'sofia' },
      routing: {
        requested_name: requestedName,
        requested_extension: extension,
        target_user_id: result.transferIntent?.target_user_id || null,
        target_extension: result.transferIntent?.target_extension || null,
        transfer_intent_id: result.transferIntent?.id || null,
        match_status: result.matchStatus,
      },
      source: {
        sender: 'transfer/prepareUserTransfer.handlePrepareUserTransferTool',
        converter: 'GeminiToolResponseBody',
        receiver: 'gemini_live',
        transport: 'gemini_tool',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal',
      },
      metadata: {
        toolCallId,
        response_json: sanitizePhoneJson(responseBody),
      },
    }));
	    context.sendGeminiToolResponse(toolName, toolCallId, responseBody);
  } catch (error) {
    const code = error instanceof PhoneUserExtensionValidationError ? error.code : 'PREPARE_USER_TRANSFER_FAILED';
    logError(context.logContext, 'voice.gemini.prepare_user_transfer_failed', error, {
      orgId: session.orgId,
      sessionId: session.sessionId,
      callId: session.callId,
      toolCallId,
      toolName: 'prepare_user_transfer',
      errorCode: code
    });
    recordSofiaVoiceLiveDebugEvent({
      event: 'transfer_failed',
      callId: session.callId,
      sessionId: session.sessionId,
      orgId: session.orgId,
      metadata: {
        toolCallId,
        requestedName,
        extension,
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    });
    context.sendGeminiToolResponse(toolName, toolCallId, blockResponse(code, 'I could not prepare that transfer. I can take a message.'));
  }
}
