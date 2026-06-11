import {
  findTransferIntentForAnswer,
  updateTransferIntentStatus,
  type JsonObject,
} from '../../models/phoneUserExtensionsModel.ts';
import {
  findPhoneCallLogByIdForOrg,
  updatePhoneCallLogTransferStatus,
} from '../../models/phoneOutboundCallLogModel.ts';
import { publishPhoneLiveCallFromCallLog } from './phoneLiveStateService.ts';
import {
  InfobipLiveCallBridgeRequestError,
  buildVoicemailStartMetadataPatch,
  startTransferVoicemailOnConference,
} from './infobipLiveCallBridgeService.ts';
import {
  buildPhoneJsonEnvelope,
  logPhoneJsonEvent,
} from './phoneJsonContract.ts';
import { ANSWERABLE_TRANSFER_INTENT_STATUSES } from '../../types/phoneTransferTypes.ts';
import { PhoneUserExtensionValidationError } from '../../types/phoneUserExtensionTypes.ts';
import {
  metadataText,
  transferEndpointTypeFromMetadata,
} from './phoneTransferIntentMetadataService.ts';
import {
  normalizeVoiceResponseLanguage,
  syncTransferRealtimeForUser,
} from './phoneTransferWorkflowHelpers.ts';

export async function maybeStartInboundProviderVoicemail(input: {
  orgId: string;
  callLogId: string | null;
  reason: string;
  voiceResponseLanguage: string | null;
  targetUserId?: string | null;
  targetExtension?: string | null;
  requestedName?: string | null;
  requestedExtension?: string | null;
}): Promise<boolean> {
  if (!input.callLogId) return false;
  const callLog = await findPhoneCallLogByIdForOrg(input.orgId, input.callLogId);
  if (!callLog || callLog.direction !== 'inbound') return false;
  const metadata = callLog.raw_provider_response && typeof callLog.raw_provider_response === 'object' && !Array.isArray(callLog.raw_provider_response)
    ? callLog.raw_provider_response as JsonObject
    : {};
  const conferenceId = callLog.dialog_id
    || metadataText(metadata, 'conference_id')
    || metadataText(metadata, 'conferenceId');
  const providerCallId = callLog.parent_call_id || callLog.provider_call_id;
  const language = normalizeVoiceResponseLanguage(input.voiceResponseLanguage);
  if (!conferenceId || !providerCallId || !language) {
    logPhoneJsonEvent('voice.json.inbound_voicemail.trigger.skipped', buildPhoneJsonEnvelope({
      eventType: 'inbound_voicemail.trigger.skipped',
      orgId: input.orgId,
      call: {
        phone_call_log_id: callLog.id,
        provider_call_id: callLog.provider_call_id,
        dialog_id: callLog.dialog_id,
        parent_call_id: callLog.parent_call_id,
        direction: 'inbound',
        status: ['initiated', 'submitted', 'ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'canceled', 'unknown'].includes(callLog.status)
          ? callLog.status as 'initiated' | 'submitted' | 'ringing' | 'answered' | 'completed' | 'failed' | 'no_answer' | 'busy' | 'canceled' | 'unknown'
          : 'unknown',
      },
      actor: { type: 'system' },
      routing: {
        requested_name: input.requestedName || null,
        requested_extension: input.requestedExtension || null,
        target_user_id: input.targetUserId || null,
        target_extension: input.targetExtension || null,
        match_status: input.targetUserId ? 'single' : 'none',
      },
      source: {
        sender: 'sofia_user_transfer_tool',
        converter: 'phoneUserExtensionsService.maybeStartInboundProviderVoicemail',
        receiver: 'infobipLiveCallBridgeService.startTransferVoicemailOnConference',
        transport: 'internal_service',
        provider_event_type: 'prepare_user_transfer',
        provider_payload_shape: 'internal',
      },
      metadata: {
        reason: input.reason,
        conference_id_present: Boolean(conferenceId),
        provider_call_id_present: Boolean(providerCallId),
        language_present: Boolean(language),
      },
    }));
    return false;
  }

  const voicemailResult = await startTransferVoicemailOnConference({
    orgId: input.orgId,
    providerCallId,
    phoneCallLogId: callLog.id,
    targetUserId: input.targetUserId || null,
    targetExtension: input.targetExtension || null,
    conferenceId,
    language,
    parentCallId: callLog.parent_call_id || callLog.provider_call_id,
    dialogId: callLog.dialog_id,
    callerNumber: callLog.from_number,
  });
  await updatePhoneCallLogTransferStatus({
    id: callLog.id,
    orgId: input.orgId,
    status: 'answered',
    metadata: {
      ...buildVoicemailStartMetadataPatch({
        conferenceId,
        reason: input.reason,
        result: voicemailResult,
      }),
      voicemail_source: 'inbound_provider_call',
      voicemail_target_user_id: input.targetUserId || null,
      voicemail_target_extension: input.targetExtension || null,
    },
  });
  logPhoneJsonEvent('voice.json.inbound_voicemail.trigger.success', buildPhoneJsonEnvelope({
    eventType: 'inbound_voicemail.trigger.success',
    orgId: input.orgId,
    call: {
      phone_call_log_id: callLog.id,
      provider_call_id: callLog.provider_call_id,
      dialog_id: callLog.dialog_id,
      parent_call_id: callLog.parent_call_id,
      direction: 'inbound',
      status: 'answered',
    },
    actor: { type: 'system' },
    routing: {
      requested_name: input.requestedName || null,
      requested_extension: input.requestedExtension || null,
      target_user_id: input.targetUserId || null,
      target_extension: input.targetExtension || null,
      match_status: input.targetUserId ? 'single' : 'none',
    },
    source: {
      sender: 'infobipLiveCallBridgeService.startTransferVoicemailOnConference',
      converter: 'phoneUserExtensionsService.maybeStartInboundProviderVoicemail',
      receiver: 'phone_call_logs',
      transport: 'internal_service',
      provider_event_type: 'prepare_user_transfer',
      provider_payload_shape: 'internal',
    },
    metadata: {
      reason: input.reason,
      conference_id: conferenceId,
      s3_archive_expected_from_provider_recording_ready: true,
    },
  }));
  return true;
}

export interface DeclineTransferToVoicemailResult {
  transferIntentId: string;
  status: string;
  voicemailStarted: boolean;
  voicemailAvailable: boolean;
  voicemailUnavailableReason: string | null;
}

export async function declineTransferIntentToVoicemail(input: {
  orgId: string;
  actorUserId: string;
  transferIntentId: string;
}): Promise<DeclineTransferToVoicemailResult> {
  const intent = await findTransferIntentForAnswer(input.orgId, input.transferIntentId);
  if (!intent) throw new PhoneUserExtensionValidationError('TRANSFER_INTENT_NOT_FOUND', 'Transfer intent was not found', 404);
  if (intent.target_user_id !== input.actorUserId) throw new PhoneUserExtensionValidationError('TRANSFER_INTENT_TARGET_MISMATCH', 'This transfer is assigned to another user', 403);
  if (!ANSWERABLE_TRANSFER_INTENT_STATUSES.includes(intent.status as typeof ANSWERABLE_TRANSFER_INTENT_STATUSES[number])) {
    throw new PhoneUserExtensionValidationError('TRANSFER_INTENT_NOT_ANSWERABLE', 'Transfer intent is not answerable', 409);
  }

  const declinedAt = new Date().toISOString();
  const conferenceId = metadataText(intent.metadata, 'transfer_conference_id') || intent.startup_conference_id || null;
  const providerCallId = metadataText(intent.metadata, 'parent_provider_call_id')
    || intent.parent_call_id
    || intent.provider_call_id
    || null;
  const language = normalizeVoiceResponseLanguage(metadataText(intent.metadata, 'voice_response_language'));
  let voicemailStarted = false;
  let voicemailUnavailableReason: string | null = null;

  await updateTransferIntentStatus({
    orgId: input.orgId,
    transferIntentId: intent.id,
    status: 'failed_user_unavailable',
    metadataPatch: {
      declined_to_voicemail_at: declinedAt,
      declined_by_user_id: input.actorUserId,
      voicemail_requested_at: declinedAt,
      voicemail_request_source: 'browser_decline_to_voicemail',
    },
  });

  if (!conferenceId || !providerCallId || !language) {
    voicemailUnavailableReason = !conferenceId
      ? 'missing_transfer_conference_id'
      : !providerCallId
        ? 'missing_parent_provider_call_id'
        : 'missing_voice_response_language';
    await updateTransferIntentStatus({
      orgId: input.orgId,
      transferIntentId: intent.id,
      status: 'failed_user_unavailable',
      metadataPatch: {
        voicemail_failed_at: new Date().toISOString(),
        voicemail_failure_code: voicemailUnavailableReason,
        voicemail_reason: 'declined_to_voicemail',
      },
    });
  } else {
    try {
      const voicemailResult = await startTransferVoicemailOnConference({
        orgId: input.orgId,
        providerCallId,
        phoneCallLogId: intent.call_log_id,
        transferIntentId: intent.id,
        targetUserId: intent.target_user_id,
        targetExtension: intent.target_extension,
        conferenceId,
        language,
        parentCallId: metadataText(intent.metadata, 'parent_call_id') || providerCallId,
        dialogId: metadataText(intent.metadata, 'dialog_id') || intent.dialog_id,
        callerNumber: metadataText(intent.metadata, 'caller_number') || intent.caller_from_number,
        sourceRoutePhone: metadataText(intent.metadata, 'source_route_phone') || intent.dialed_number,
        sourceRouteId: metadataText(intent.metadata, 'source_route_id'),
        sofiaChildCallId: metadataText(intent.metadata, 'sofia_child_call_id'),
        targetEndpointType: transferEndpointTypeFromMetadata(intent.metadata),
        safeEndpointId: metadataText(intent.metadata, 'safe_endpoint_id'),
      });
      voicemailStarted = true;
      await updateTransferIntentStatus({
        orgId: input.orgId,
        transferIntentId: intent.id,
        status: 'failed_user_unavailable',
        metadataPatch: buildVoicemailStartMetadataPatch({
          conferenceId,
          reason: 'declined_to_voicemail',
          result: voicemailResult,
        }),
      });
    } catch (error) {
      voicemailUnavailableReason = error instanceof InfobipLiveCallBridgeRequestError
        ? error.code
        : 'TRANSFER_VOICEMAIL_TRIGGER_FAILED';
      await updateTransferIntentStatus({
        orgId: input.orgId,
        transferIntentId: intent.id,
        status: 'failed_user_unavailable',
        metadataPatch: {
          voicemail_failed_at: new Date().toISOString(),
          voicemail_failure_code: voicemailUnavailableReason,
          voicemail_failure_message: error instanceof Error ? error.message : String(error),
          voicemail_conference_id: conferenceId,
          voicemail_reason: 'declined_to_voicemail',
        },
      });
    }
  }

  await syncTransferRealtimeForUser(input.orgId, intent.target_user_id);
  if (intent.call_log_id) {
    const callLog = await findPhoneCallLogByIdForOrg(input.orgId, intent.call_log_id);
    if (callLog) {
      await publishPhoneLiveCallFromCallLog({
        row: callLog,
        source: 'infobip',
        projectionEventType: 'infobip_provider_lifecycle',
        lastProviderEventAt: new Date().toISOString(),
        transferIntentId: intent.id,
        transferStatus: 'failed_user_unavailable',
      });
    }
  }

  logPhoneJsonEvent('voice.json.transfer_intent.decline_to_voicemail', buildPhoneJsonEnvelope({
    eventType: 'transfer_intent.decline_to_voicemail',
    orgId: input.orgId,
    call: {
      phone_call_log_id: intent.call_log_id,
      provider_call_id: providerCallId,
      direction: 'internal_transfer',
      status: voicemailStarted ? 'submitted' : 'failed',
    },
    actor: {
      type: 'user',
      user_id: input.actorUserId,
    },
    routing: {
      target_user_id: intent.target_user_id,
      target_extension: intent.target_extension,
      transfer_intent_id: intent.id,
      match_status: 'single',
    },
    source: {
      sender: 'conecta_browser',
      converter: 'phoneUserExtensionsService.declineTransferIntentToVoicemail',
      receiver: voicemailStarted ? 'infobipLiveCallBridgeService.startTransferVoicemailOnConference' : 'phone_user_transfer_intents',
      transport: 'http',
      provider_event_type: null,
      provider_payload_shape: 'internal',
    },
    metadata: {
      conference_id_present: Boolean(conferenceId),
      provider_call_id_present: Boolean(providerCallId),
      voice_response_language_present: Boolean(language),
      voicemail_started: voicemailStarted,
      voicemail_unavailable_reason: voicemailUnavailableReason,
      s3_archive_expected_from_provider_recording_ready: voicemailStarted,
    },
  }));

  return {
    transferIntentId: intent.id,
    status: 'failed_user_unavailable',
    voicemailStarted,
    voicemailAvailable: voicemailStarted,
    voicemailUnavailableReason,
  };
}
